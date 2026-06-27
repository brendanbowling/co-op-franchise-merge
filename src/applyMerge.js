'use strict';

/**
 * APPLY MERGE (Phase 4.1, v1) — transplant a guest's played game(s) onto the host save.
 *
 * 3-way, baseline-anchored: changeSet = diff(baseline, guest); apply it to host.
 * v1 policy (config.merge): copy the GAME RESULT (allowlisted SeasonGame fields) + the
 * AGGREGATE rows (season/career/team). Skip per-game box-score tables (they need reference
 * re-pointing — v2). Reference-free: only writes values into rows already matched across saves.
 *
 * Because host, guest, and baseline all derive from the same distributed file, rows align:
 *   - aggregate tables use positional identity ("#<index>") -> host.records[index]
 *   - SeasonGame uses its natural key (year+week+teams) -> located in host by those fields
 *
 * The only file coupled to the library here is openFranchise.js (host I/O) — snapshot/diff are pure.
 */

const fs = require('fs');
const path = require('path');
const { openFranchise, safe } = require('./openFranchise');
const { snapshot } = require('./snapshot');
const { diffSnapshots } = require('./diff');
const { buildPlayerStatMap, resolveHostAggregateRow } = require('./playerStatMap');

/**
 * @param {object} opts
 * @param {string} opts.baseline  path to the pristine distributed Week-N save
 * @param {string} opts.host      path to the source-of-truth (host's) save to merge INTO
 * @param {string} opts.guest     path to the guest's played save
 * @param {string} opts.out       output path for the merged save (must differ from host)
 * @param {object} opts.config    title config (with .merge policy)
 * @returns {Promise<object>} summary { applied, skipped, warnings, verify }
 */
async function applyMerge({ baseline, host, guest, out, config }) {
  const merge = config.merge;
  if (!merge) throw new Error('config.merge policy missing');
  // Inputs are strictly read-only: the merge writes ONLY the user-chosen output file. Refuse if the
  // output path collides with any input, so a merge can never overwrite a save the user gave us.
  const outAbs = path.resolve(out);
  for (const [name, p] of [['host', host], ['guest', guest], ['baseline', baseline]]) {
    if (outAbs === path.resolve(p)) {
      throw new Error(`output must differ from the ${name} file (inputs are never modified — choose a new output name)`);
    }
  }

  // 1. Compute the guest's change-set vs the shared baseline (pure, in-memory).
  const baseSnap = await snapshot(baseline, config, null);
  const guestSnap = await snapshot(guest, config, null);
  const report = diffSnapshots(baseSnap, guestSnap);

  // Identify the guest's REAL played games being merged: match humanGameFilter AND actually differ
  // from the baseline (i.e. newly played this round — not the user's past-week games, which are
  // unchanged). This keeps the team-record/standings step scoped to just this game's two teams.
  const humanGameKeys = new Set();
  if (merge.humanGameFilter) {
    const changedResultKeys = new Set(((report.tables[merge.resultTable] || {}).modified || []).map(m => m.key));
    const guestGames = (guestSnap.tables[merge.resultTable] || {}).rows || [];
    for (const row of guestGames) {
      const ok = Object.entries(merge.humanGameFilter)
        .every(([f, v]) => String(row[f]) === String(v));
      if (ok && changedResultKeys.has(row.__key)) humanGameKeys.add(row.__key);
    }
  }

  // 2. Open the host. We modify the parsed franchise IN MEMORY and save it to the separate output
  //    path below — the host file on disk is never written to (saveOnChange is off), so the inputs
  //    are preserved as-is and no backup is needed (D6: superseded — see DECISIONS.md).
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  // autoUnempty:true lets us allocate new stat rows (debut players) by writing into empty records.
  const franchise = await openFranchise(host, config.schema || {}, { autoUnempty: true });

  const warnings = [];
  const applied = {};   // table -> {rows, fields}
  const skipped = {};   // table -> count
  const resultFields = new Set(merge.resultFields);
  const aggregateTables = new Set(merge.aggregateTables);
  const keyFieldsByTable = {};
  for (const def of config.tables.definitions) keyFieldsByTable[def.name] = def.keyFields || [];

  // Player-id hardening: map season stat rows to the PLAYER that owns them, in both host and
  // guest, so aggregate rows transplant by identity (not slot index). Aligned rows resolve to the
  // same index (no-op); divergent rows (a player whose stat row sits at a different index, or a
  // divergent roster signing) get remapped to the right host row or flagged+skipped, never
  // silently mis-applied. Reused for the team-record (standings) step below too.
  const statTables = [...aggregateTables];
  const guestFr = await openFranchise(guest, config.schema || {});
  let hostMap = null, guestMap = null;
  const remaps = [];   // {table, player, from, to} — identity saved a misaligned write
  const allocated = []; // {table, player, idx, slot, ...} — new stat rows created for debut players
  const boxExpect = []; // {table, player, idx, slot, ...} — per-game box-score rows created
  const gameHoldersAllocated = []; // {player, holderTableId, holderRow, playerRow} — GameStats holders created for debuts
  const teamBoxExpect = []; // {table, idx, cacheField, gameKey, sample} — per-game team box rows
  const seasonHoldersAllocated = []; // {player, holderTableId, holderRow, playerRow} — SeasonStats holders created for true debuts
  const careerAllocated = [];        // {player, tableId, row, playerRow, sample} — Career rows created for true debuts
  let hostPlayerTbl = null;          // shared: repoint Player.SeasonStats/CareerStats/GameStats when allocating for debuts
  if (statTables.length) {
    hostMap = await buildPlayerStatMap(franchise, { statTables });
    guestMap = await buildPlayerStatMap(guestFr, { statTables });
    for (const w of [...(hostMap.warnings || []), ...(guestMap.warnings || [])]) warnings.push(`playerMap: ${w}`);
    hostPlayerTbl = franchise.getTableByName('Player'); if (hostPlayerTbl) await hostPlayerTbl.readRecords();
    // Pre-read guest aggregate tables so a 'modified'-classified row can be re-read in full for allocation.
    for (const tn of statTables) { const gt = guestFr.getTableByName(tn); if (gt) await gt.readRecords(); }
  }

  // Apply a MODIFIED aggregate-table diff row to the host, by player identity:
  //  - ok / remapped: write the diff deltas into the player's existing host row
  //  - no-host-row: the guest player has stats but no host row this season — e.g. at season start a
  //    brand-new row collides positionally with leftover baseline content and gets tagged 'modified'
  //    rather than 'added'. Allocate a fresh host row from the guest's FULL values (the deltas are
  //    relative to the colliding baseline row, so they're unusable). allocateSeasonRow allocates a
  //    SeasonStats holder too if the player is a true debut with none.
  //  - orphan: positional fallback
  // Returns {rows, fields} or null.
  function applyAggregateModified(tbl, tableName, mod) {
    const gi = positionalIndex(mod.key);
    const applyDeltas = (rec) => {
      let touched = 0, fields = 0;
      for (const ch of mod.changes) if (setField(rec, ch.field, ch.to, tableName)) { touched++; fields++; }
      return touched ? { rows: 1, fields } : null;
    };
    if (gi == null || !guestMap || !hostMap) {
      const rec = gi == null ? null : tbl.records[gi];
      return rec ? applyDeltas(rec) : null;
    }
    const res = resolveHostAggregateRow(guestMap, hostMap, tableName, gi);
    if (res.status === 'no-host-row') {
      const guestVals = readGuestRowValues(tableName, gi);
      if (!guestVals) { warnings.push(`${tableName}: ${res.playerName} no-host-row, guest row ${gi} unreadable; skipped`); bump(skipped, `${tableName} (no host row)`); return null; }
      const alloc = allocateSeasonRow(tbl, tableName, res.playerKey, res.playerName, guestVals);
      return alloc ? { rows: 1, fields: alloc.fields } : null;
    }
    if (res.status === 'orphan') {
      warnings.push(`${tableName}: row ${gi} not player-linked; positional fallback`);
      const rec = tbl.records[gi];
      return rec ? applyDeltas(rec) : null;
    }
    if (res.status === 'remapped') remaps.push({ table: tableName, player: res.playerName, from: gi, to: res.hostRow });
    const rec = tbl.records[res.hostRow];
    return rec ? applyDeltas(rec) : null;
  }

  // Read a guest aggregate row's full scalar (non-reference) field values into a {field: value} object.
  function readGuestRowValues(tableName, gi) {
    const gt = guestFr.getTableByName(tableName);
    const grec = gt && gt.records && gt.records[gi];
    if (!grec) return null;
    const vals = {};
    for (const k of Object.keys(grec.fields)) {
      if (grec.fields[k].isReference) continue;
      vals[k] = safe(() => grec.getValueByKey(k));
    }
    return vals;
  }

  // Allocate a brand-new season stat row for a debut player (no host row yet): claim an empty
  // record, copy the guest row's values into it (autoUnempty un-empties + maintains the empty
  // linked-list), then link it from a free slot in the player's host SeasonStats holder.
  // Allocate a SeasonStats holder for a true-debut player who has none in the host (Player.SeasonStats
  // is null — a rookie with no prior season). Mirrors allocateGameHolder: clone the guest holder's
  // layout into a fresh host row (un-empties cleanly via its non-null slot), null all SeasonStatsN
  // slots so allocateSeasonRow can fill one, then point the host Player record at the new holder.
  // Updates hostMap so the caller's holderRef lookup succeeds. Returns the new ref or null.
  function allocateSeasonHolder(pkey, pname) {
    const gMeta = guestMap && guestMap.playerMeta.get(pkey);
    const hMeta = hostMap && hostMap.playerMeta.get(pkey);
    const gHolderRef = gMeta && gMeta.holderRef;
    if (!gHolderRef) { warnings.push(`${pname}: guest has no SeasonStats holder; cannot allocate host holder`); return null; }
    if (!hMeta || hMeta.playerRow == null || !hostPlayerTbl) { warnings.push(`${pname}: not in host roster; cannot allocate SeasonStats holder`); return null; }
    const holderT = franchise.getTableById(gHolderRef.tableId);
    const gHolderT = guestFr.getTableById(gHolderRef.tableId);
    if (!holderT || !gHolderT) { warnings.push(`${pname}: SeasonStats holder table ${gHolderRef.tableId} unresolved`); return null; }
    const gHolder = gHolderT.records[gHolderRef.rowNumber];
    if (!gHolder) { warnings.push(`${pname}: guest SeasonStats holder row ${gHolderRef.rowNumber} missing`); return null; }
    const idx = holderT.header.nextRecordToUse;
    if (idx == null || idx >= holderT.header.recordCapacity) { warnings.push(`SeasonStats holder table full; cannot allocate for ${pname}`); return null; }
    const newRow = holderT.records[idx];
    if (!newRow) { warnings.push(`${pname}: no SeasonStats holder record at ${idx}`); return null; }

    // Clone guest holder fields (un-empties via the non-null slot), then null all SeasonStatsN slots.
    for (const k of Object.keys(gHolder.fields)) {
      if (!newRow.fields[k]) continue;
      try { newRow.fields[k].value = gHolder.fields[k].value; } catch (e) { warnings.push(`${pname}: holder field ${k} copy failed (${e.message})`); }
    }
    if (newRow.isEmpty) { warnings.push(`${pname}: SeasonStats holder row ${idx} still empty after clone; aborted`); return null; }
    for (const k of Object.keys(newRow.fields)) {
      if (!/^SeasonStats\d+$/.test(k)) continue;
      try { newRow.fields[k].value = '0'.repeat(String(newRow.fields[k].value).length); } catch (e) { /* leave */ }
    }
    const prec = hostPlayerTbl.records[hMeta.playerRow];
    if (!prec || !prec.fields['SeasonStats']) { warnings.push(`${pname}: host Player row has no SeasonStats field`); return null; }
    try { prec.fields['SeasonStats'].value = holderT.getBinaryReferenceToRecord(idx); }
    catch (e) { warnings.push(`${pname}: Player.SeasonStats link failed (${e.message})`); return null; }
    hMeta.holderRef = { tableId: gHolderRef.tableId, rowNumber: idx };
    seasonHoldersAllocated.push({ player: pname, holderTableId: gHolderRef.tableId, holderRow: idx, playerRow: hMeta.playerRow });
    return hMeta.holderRef;
  }

  function allocateSeasonRow(tbl, tableName, pkey, pname, addRow) {
    const meta = pkey && hostMap && hostMap.playerMeta.get(pkey);
    let holderRef = meta && meta.holderRef;
    if (!holderRef) {
      // True debut (rookie, no prior season): allocate a SeasonStats holder first, then proceed.
      holderRef = allocateSeasonHolder(pkey, pname);
      if (!holderRef) { bump(skipped, `${tableName} (alloc: no holder)`); return null; }
    }
    const holder = franchise.getTableById(holderRef.tableId);
    if (!holder || !holder.records) { warnings.push(`${tableName}: holder table ${holderRef.tableId} unresolved`); return null; }
    const hrow = holder.records[holderRef.rowNumber];
    if (!hrow) { warnings.push(`${tableName}: ${pname} holder row ${holderRef.rowNumber} missing`); return null; }

    // Find a free SeasonStatsN slot on the holder (null reference).
    let freeSlot = null;
    for (const k of Object.keys(hrow.fields)) {
      if (!/^SeasonStats\d+$/.test(k)) continue;
      const v = hrow.fields[k] && hrow.fields[k].value;
      if (!v || /^0+$/.test(String(v))) { freeSlot = k; break; }
    }
    if (!freeSlot) { warnings.push(`${tableName}: ${pname} holder has no free slot; cannot allocate`); bump(skipped, `${tableName} (alloc: holder full)`); return null; }

    // Claim the next free record in the stat table (the game's own free-list head).
    const idx = tbl.header.nextRecordToUse;
    if (idx == null || idx >= tbl.header.recordCapacity) {
      warnings.push(`${tableName}: table full; cannot allocate row for ${pname}`); bump(skipped, `${tableName} (alloc: table full)`); return null;
    }
    const rec = tbl.records[idx];
    if (!rec) { warnings.push(`${tableName}: no record at next slot ${idx}`); return null; }

    let fields = 0;
    for (const [field, value] of Object.entries(addRow)) {
      if (setField(rec, field, value, tableName)) fields++;
    }
    if (rec.isEmpty) { warnings.push(`${tableName}: ${pname} row ${idx} still empty after write; allocation aborted`); return null; }

    // Link the holder slot to the freshly written row.
    try {
      hrow.fields[freeSlot].value = tbl.getBinaryReferenceToRecord(idx);
    } catch (e) {
      warnings.push(`${tableName}: ${pname} holder link failed (${e.message})`); return null;
    }
    allocated.push({
      table: tableName, player: pname, idx, slot: freeSlot,
      holderTableId: holderRef.tableId, holderRow: holderRef.rowNumber, expect: addRow,
    });
    return { rec, idx, fields };
  }

  // Allocate a per-game box-score row (a player's stat line for the merged game) in the host: claim
  // an empty record in the host Game*Stats table, copy the guest row's fields INCLUDING its two
  // references (SeasonGame + OpposingTeam — valid verbatim because those rows align host<->guest),
  // then link it into a free slot of the player's host GameStats holder.
  function allocateGameRow(hostT, tableName, guestRec, pname, gameHolderRef, targetSlot) {
    const idx = hostT.header.nextRecordToUse;
    if (idx == null || idx >= hostT.header.recordCapacity) {
      warnings.push(`${tableName}: table full; cannot allocate game row for ${pname}`); bump(skipped, `${tableName} (box: table full)`); return null;
    }
    const rec = hostT.records[idx];
    if (!rec) { warnings.push(`${tableName}: no record at ${idx}`); return null; }

    let fields = 0;
    for (const k of Object.keys(guestRec.fields)) {
      const gf = guestRec.fields[k];
      if (!gf || !rec.fields[k]) continue;
      try {
        if (gf.isReference) { rec.fields[k].value = gf.value; }       // ref verbatim (aligned rows)
        else { rec.fields[k].value = safe(() => guestRec.getValueByKey(k)); }
        fields++;
      } catch (e) { warnings.push(`${tableName}.${k} (${pname}): set failed (${e.message})`); }
    }
    if (rec.isEmpty) { warnings.push(`${tableName}: ${pname} game row ${idx} still empty after write; aborted`); return null; }

    // Link into the player's host GameStats holder. The holder slots are WEEK-INDEXED (GameStatsN =
    // the player's row for game N of the season), NOT densely packed — a player who missed a week
    // leaves an empty slot. So we must place the merged row in the SAME slot the guest used (host,
    // guest, and baseline share the holder layout), not the first free hole. Filling the first hole
    // mis-slots the row for any player with a gap (e.g. a QB who debuted in week 2), which displays
    // as 0 on the box-score player tab even though the row data is correct.
    const holderT = franchise.getTableById(gameHolderRef.tableId);
    const hrow = holderT && holderT.records[gameHolderRef.rowNumber];
    if (!hrow) { warnings.push(`${tableName}: ${pname} GameStats holder row missing; row written but unlinked`); return null; }
    if (!targetSlot || !hrow.fields[targetSlot]) {
      warnings.push(`${tableName}: ${pname} target holder slot "${targetSlot}" absent; row written but not linked`); return null;
    }
    const existing = hrow.fields[targetSlot].value;
    if (existing && !/^0+$/.test(String(existing))) {
      // Host already has a row in this week-slot (holder divergence) — placing ours elsewhere would
      // mis-slot it just like the old bug, so flag instead of clobbering.
      warnings.push(`${tableName}: ${pname} host holder slot ${targetSlot} already occupied; merged game row written but not linked (divergence)`);
      bump(skipped, `${tableName} (box: slot occupied)`); return null;
    }
    const freeSlot = targetSlot;
    try { hrow.fields[freeSlot].value = hostT.getBinaryReferenceToRecord(idx); }
    catch (e) { warnings.push(`${tableName}: ${pname} game holder link failed (${e.message})`); return null; }

    boxExpect.push({
      table: tableName, player: pname, idx, slot: freeSlot,
      holderTableId: gameHolderRef.tableId, holderRow: gameHolderRef.rowNumber,
      sgRef: guestRec.fields['SeasonGame'] && guestRec.fields['SeasonGame'].value,
    });
    return { idx, fields };
  }

  // Allocate a GameStats holder for a true-debut player who has none in the host (Player.GameStats is
  // null). Clone the guest holder's slot layout — which for a debut is all-null except the merged-game
  // slot(s) — so the new host holder has clean null references, then null the merged-game slot(s) so
  // allocateGameRow can fill them with host indices, and point the host Player record at the new row.
  function allocateGameHolder(holderT, holderTableId, hostPlayerTbl, hMeta, gHolder, mergedSlots, pname) {
    const idx = holderT.header.nextRecordToUse;
    if (idx == null || idx >= holderT.header.recordCapacity) {
      warnings.push(`BoxScore: GameStats holder table full; cannot allocate holder for ${pname}`);
      bump(skipped, 'GameStats holder (alloc: full)'); return null;
    }
    const newRow = holderT.records[idx];
    if (!newRow) { warnings.push(`BoxScore: no holder record at ${idx} for ${pname}`); return null; }

    // Pass 1: clone every field verbatim. The guest's non-null merged-game slot guarantees a non-zero
    // write, which un-empties the record (writing only zeros may not). Pass 2 then nulls the merged
    // slots so allocateGameRow can fill them with host indices without tripping its divergence guard.
    for (const k of Object.keys(gHolder.fields)) {
      if (!newRow.fields[k]) continue;
      try { newRow.fields[k].value = gHolder.fields[k].value; }
      catch (e) { warnings.push(`BoxScore: ${pname} holder field ${k} copy failed (${e.message})`); }
    }
    if (newRow.isEmpty) { warnings.push(`BoxScore: ${pname} holder row ${idx} still empty after clone; aborted`); return null; }
    for (const k of mergedSlots) {
      const gf = gHolder.fields[k];
      if (!gf || !newRow.fields[k]) continue;
      try { newRow.fields[k].value = '0'.repeat(String(gf.value).length); }
      catch (e) { warnings.push(`BoxScore: ${pname} holder slot ${k} null failed (${e.message})`); }
    }

    const prec = hostPlayerTbl.records[hMeta.playerRow];
    if (!prec || !prec.fields['GameStats']) { warnings.push(`BoxScore: ${pname} host Player row has no GameStats field; holder unlinked`); return null; }
    try { prec.fields['GameStats'].value = holderT.getBinaryReferenceToRecord(idx); }
    catch (e) { warnings.push(`BoxScore: ${pname} Player.GameStats link failed (${e.message})`); return null; }

    gameHoldersAllocated.push({ player: pname, holderTableId, holderRow: idx, playerRow: hMeta.playerRow });
    return { tableId: holderTableId, rowNumber: idx };
  }

  // helper: set one field on a host record, guarding refs/en* failures.
  function setField(rec, field, value, tableName) {
    const f = rec.fields[field];
    if (!f) { warnings.push(`${tableName}: field "${field}" absent on host row`); return false; }
    if (f.isReference) return false; // never copy references in v1
    try { f.value = value; return true; }
    catch (e) { warnings.push(`${tableName}.${field}: set failed (${e.message})`); return false; }
  }

  for (const [tableName, tdiff] of Object.entries(report.tables)) {
    const isResult = tableName === merge.resultTable;
    const isAggregate = aggregateTables.has(tableName);
    if (!isResult && !isAggregate) {
      // Career tables are handled by the identity-scoped career pass below, not this positional
      // diff path (the diff is polluted by provisional CPU sims) — so don't report them as skipped.
      if (merge.careerStats && /^Career/.test(tableName)) continue;
      // Per-game tables are handled by the box-score pass (holder-walk allocation), not the diff.
      if (merge.boxScore && (merge.gameTables || []).includes(tableName)) continue;
      const n = tdiff.added.length + tdiff.modified.length;
      if (n) skipped[tableName] = n;
      continue;
    }

    const tbl = franchise.getTableByName(tableName);
    if (!tbl) { warnings.push(`host missing table "${tableName}"`); continue; }
    await tbl.readRecords();

    let rowCount = 0, fieldCount = 0;

    // --- modified rows ---
    const rowFilter = (merge.rowFilters && merge.rowFilters[tableName]) || null; // require a changed field in this list
    let filteredOut = 0;
    for (const mod of tdiff.modified) {
      // For the result table, only transplant the guest's REAL played games.
      if (isResult && merge.humanGameFilter && !humanGameKeys.has(mod.key)) { filteredOut++; continue; }
      // For filtered aggregate tables (e.g. TeamStats), only transplant rows whose key fields changed
      // (isolates the real game's teams from provisional-sim pollution that never touches W/L).
      if (rowFilter && !mod.changes.some(c => rowFilter.includes(c.field))) { filteredOut++; continue; }
      if (isAggregate) {
        const r = applyAggregateModified(tbl, tableName, mod);
        if (r) { rowCount += r.rows; fieldCount += r.fields; }
        continue;
      }
      const rec = locateHostRecord(tbl, tableName, mod.key, keyFieldsByTable[tableName], warnings);
      if (!rec) continue;
      let touched = 0;
      for (const ch of mod.changes) {
        if (isResult && !resultFields.has(ch.field)) continue; // result: allowlist only
        if (setField(rec, ch.field, ch.to, tableName)) { touched++; fieldCount++; }
      }
      if (touched) rowCount++;
    }
    if (filteredOut) skipped[`${tableName} (provisional sims)`] = filteredOut;

    // --- added rows (new players' aggregate rows) ---
    // Skip added rows for filtered tables (e.g. TeamStats): there, "added" rows are provisional
    // per-game team-stat rows, not real new-entity rows we want.
    for (const add of (rowFilter ? [] : tdiff.added)) {
      if (isResult) { warnings.push(`${tableName}: unexpected ADDED game ${add.key} (skipped)`); continue; }

      if (isAggregate) {
        const gi = positionalIndex(add.key);
        const res = (guestMap && hostMap) ? resolveHostAggregateRow(guestMap, hostMap, tableName, gi) : { status: 'orphan' };
        if (res.status === 'ok' || res.status === 'remapped') {
          // Player already has a host row for this season -> write into it.
          const rec = tbl.records[res.hostRow];
          let touched = 0;
          for (const [field, value] of Object.entries(add.row)) if (setField(rec, field, value, tableName)) { touched++; fieldCount++; }
          if (touched) rowCount++;
        } else if (res.status === 'no-host-row') {
          // Debut player: create the row and link it from the holder.
          const alloc = allocateSeasonRow(tbl, tableName, res.playerKey, res.playerName, add.row);
          if (alloc) { rowCount++; fieldCount += alloc.fields; }
        } else {
          warnings.push(`${tableName}: added row ${add.key} not player-linked; skipped`);
          bump(skipped, `${tableName} (orphan add)`);
        }
        continue;
      }

      // Non-aggregate added rows: positional into an empty host slot.
      const idx = positionalIndex(add.key);
      if (idx == null) { warnings.push(`${tableName}: added row ${add.key} not positional (skipped)`); continue; }
      const rec = tbl.records[idx];
      if (!rec) { warnings.push(`${tableName}: no host slot at ${add.key} (skipped)`); continue; }
      if (!rec.isEmpty) { warnings.push(`${tableName}: host slot ${add.key} not empty; new-player row skipped`); continue; }
      let touched = 0;
      for (const [field, value] of Object.entries(add.row)) {
        if (setField(rec, field, value, tableName)) { touched++; fieldCount++; }
      }
      if (touched) rowCount++;
    }

    if (tdiff.removed.length) warnings.push(`${tableName}: ${tdiff.removed.length} removed rows ignored`);
    if (rowCount) applied[tableName] = { rows: rowCount, fields: fieldCount };
  }

  // --- Team-record (standings) transplant ---
  // W/L splits live on the Team record (id 5917), NOT in TeamStats. For each merged game's two
  // teams, copy the configured scalar fields guest->host. Clean: a game's two teams are untouched
  // by the provisional ticker sims, so their Team-record deltas are purely the real game.
  let expectedTeam = null;
  if (merge.teamRecordFields && merge.teamRecordFields.length && humanGameKeys.size) {
    const gsg = guestFr.getTableByName(merge.resultTable);
    await gsg.readRecords();
    const resultKeyFields = keyFieldsByTable[merge.resultTable] || [];
    const teamRows = new Set();
    let teamTableId = null;
    for (const rec of gsg.records) {
      if (!rec || rec.isEmpty) continue;
      const key = resultKeyFields.map(k => `${k}=${safe(() => rec.getValueByKey(k))}`).join('|');
      if (!humanGameKeys.has(key)) continue;
      for (const tf of ['HomeTeam', 'AwayTeam']) {
        const rd = rec.fields[tf] && rec.fields[tf].referenceData;
        if (rd && rd.tableId) { teamTableId = rd.tableId; teamRows.add(rd.rowNumber); }
      }
    }
    if (teamTableId && teamRows.size) {
      const gTeam = guestFr.getTableById(teamTableId); await gTeam.readRecords();
      const hTeam = franchise.getTableById(teamTableId); await hTeam.readRecords();
      expectedTeam = { teamTableId, rows: {} };
      let rows = 0, fields = 0;
      for (const row of teamRows) {
        const gr = gTeam.records[row], hr = hTeam.records[row];
        if (!gr || !hr) continue;
        let touched = 0;
        expectedTeam.rows[row] = {};
        for (const f of merge.teamRecordFields) {
          if (!hr.fields[f]) { warnings.push(`Team: field "${f}" absent`); continue; }
          if (hr.fields[f].isReference) continue;
          const val = safe(() => gr.getValueByKey(f));
          try { hr.fields[f].value = val; expectedTeam.rows[row][f] = val; touched++; fields++; }
          catch (e) { warnings.push(`Team.${f}: set failed (${e.message})`); }
        }
        if (touched) rows++;
      }
      if (rows) applied['Team (standings)'] = { rows, fields };
    }
  }

  // Allocate a Career row for a true-debut player who has none in the host (Player.CareerStats null).
  // Career is a DIRECT ref (no holder): claim a row in the position Career*Stats table, copy the guest
  // career values, and point the host Player record at it. Returns {fields, sample} or null.
  async function allocateCareerRow(pkey, pname, gRef) {
    const hMeta = hostMap && hostMap.playerMeta.get(pkey);
    if (!hMeta || hMeta.playerRow == null || !hostPlayerTbl) { warnings.push(`Career: ${pname} not in host roster; cannot allocate career row`); return null; }
    const gT = guestFr.getTableById(gRef.tableId); if (gT) await gT.readRecords();
    const hT = franchise.getTableById(gRef.tableId); if (hT) await hT.readRecords();
    if (!gT || !hT) { warnings.push(`Career: ${pname} career table ${gRef.tableId} unresolved`); return null; }
    const gRec = gT.records[gRef.rowNumber];
    if (!gRec) { warnings.push(`Career: ${pname} guest career row ${gRef.rowNumber} missing`); return null; }
    const idx = hT.header.nextRecordToUse;
    if (idx == null || idx >= hT.header.recordCapacity) { warnings.push(`Career: ${pname} career table full`); return null; }
    const rec = hT.records[idx];
    if (!rec) { warnings.push(`Career: ${pname} no career record at ${idx}`); return null; }
    let fields = 0; const sample = {};
    for (const k of Object.keys(gRec.fields)) {
      if (gRec.fields[k].isReference || !rec.fields[k] || rec.fields[k].isReference) continue;
      try { rec.fields[k].value = safe(() => gRec.getValueByKey(k)); fields++; if (Object.keys(sample).length < 3) sample[k] = safe(() => gRec.getValueByKey(k)); }
      catch (e) { warnings.push(`Career.${k} (${pname}): set failed (${e.message})`); }
    }
    if (rec.isEmpty) { warnings.push(`Career: ${pname} career row ${idx} still empty; aborted`); return null; }
    const prec = hostPlayerTbl.records[hMeta.playerRow];
    if (!prec || !prec.fields['CareerStats']) { warnings.push(`Career: ${pname} host Player has no CareerStats field`); return null; }
    try { prec.fields['CareerStats'].value = hT.getBinaryReferenceToRecord(idx); }
    catch (e) { warnings.push(`Career: ${pname} Player.CareerStats link failed (${e.message})`); return null; }
    careerAllocated.push({ player: pname, tableId: gRef.tableId, row: idx, playerRow: hMeta.playerRow, sample });
    return { fields, sample };
  }

  // --- Career-totals transplant (identity-scoped) ---
  // Each player has ONE cumulative career row (Player.CareerStats -> a position Career*Stats table,
  // direct, no holder). The baseline-vs-guest career diff is polluted by provisional CPU sims, so we
  // do NOT use it; instead we copy the career row guest->host for exactly the HUMAN-GAME players
  // (those whose season rows changed — a clean, provisional-free set). Career rows pre-exist for most
  // players; a true rookie debut has none in host, so we allocate one (allocateCareerRow).
  // Human-game participants = owners of the changed/added season rows (a provisional-clean set,
  // since season tables aren't polluted by provisional sims). Shared by career + box-score passes.
  const seasonPlayers = new Set();
  if (guestMap) {
    for (const tn of statTables) {
      const td = report.tables[tn];
      if (!td) continue;
      for (const m of [...td.modified, ...td.added]) {
        const info = guestMap.rowToPlayer.get(`${tn}#${positionalIndex(m.key)}`);
        if (info) seasonPlayers.add(info.key);
      }
    }
  }

  const careerExpect = [];
  if (merge.careerStats && guestMap && hostMap) {
    let crows = 0, cfields = 0;
    const hostCareerTables = new Map(); // tableId -> read table (host)
    for (const pkey of seasonPlayers) {
      const gMeta = guestMap.playerMeta.get(pkey) || {};
      const hMeta = hostMap.playerMeta.get(pkey) || {};
      const gRef = gMeta.careerRef, hRef = hMeta.careerRef;
      const pname = gMeta.name || pkey;
      if (!gRef) { warnings.push(`Career: ${pname} missing guest career ref; skipped`); continue; }
      if (!hRef) {
        // True debut: host has no career row yet — allocate one and link Player.CareerStats.
        const alloc = await allocateCareerRow(pkey, pname, gRef);
        if (alloc) { crows++; cfields += alloc.fields; }
        continue;
      }

      const gT = guestFr.getTableById(gRef.tableId); await gT.readRecords();
      let hT = hostCareerTables.get(hRef.tableId);
      if (!hT) { hT = franchise.getTableById(hRef.tableId); await hT.readRecords(); hostCareerTables.set(hRef.tableId, hT); }
      const gRec = gT.records[gRef.rowNumber], hRec = hT.records[hRef.rowNumber];
      if (!gRec || !hRec) { warnings.push(`Career: ${pname} career row missing`); continue; }

      let touched = 0; const sample = {};
      for (const k of Object.keys(gRec.fields)) {
        const gf = gRec.fields[k];
        if (!gf || gf.isReference) continue;
        if (!hRec.fields[k] || hRec.fields[k].isReference) continue;
        const val = safe(() => gRec.getValueByKey(k));
        try { hRec.fields[k].value = val; touched++; cfields++; if (Object.keys(sample).length < 3) sample[k] = val; }
        catch (e) { warnings.push(`Career.${k} (${pname}): set failed (${e.message})`); }
      }
      if (touched) { crows++; careerExpect.push({ player: pname, tableId: hRef.tableId, row: hRef.rowNumber, sample }); }
    }
    if (crows) applied['Career (game players)'] = { rows: crows, fields: cfields };
  }

  // --- Box-score (per-game player line) transplant ---
  // The player-card game log is built from Player.GameStats -> a GameStats[] holder -> per-game
  // Game*Stats rows (each carrying its own SeasonGame + OpposingTeam refs; NO player back-ref).
  // We iterate EVERY guest player (the merged game's two teams self-select — only their players hold
  // a row referencing the merged SeasonGame), find each player's merged-game Game row(s) by walking
  // THEIR guest holder, then allocate+link the equivalent row in host at the SAME week-indexed slot.
  // Iterating all players (not just owners of a changed tracked-season row) catches 0-stat lines and
  // players whose only change was an untracked season category. (SeasonGame.*PlayerStatCache is empty
  // for all games, even ones that display — the log doesn't route through it — so we don't touch it.)
  if (merge.boxScore && guestMap && hostMap && humanGameKeys.size) {
    const gameTables = merge.gameTables || ['GameOffensiveStats', 'GameDefensiveStats', 'GameKickingStats'];

    // Guest SeasonGame row indices for the merged game(s).
    const resultKeyFields = keyFieldsByTable[merge.resultTable] || [];
    const gsg = guestFr.getTableByName(merge.resultTable); await gsg.readRecords();
    const mergedGameIdx = new Set();
    for (let i = 0; i < gsg.records.length; i++) {
      const r = gsg.records[i]; if (!r || r.isEmpty) continue;
      const key = resultKeyFields.map(k => `${k}=${safe(() => r.getValueByKey(k))}`).join('|');
      if (humanGameKeys.has(key)) mergedGameIdx.add(i);
    }

    // Pre-read host game tables, the GameStats holder table(s), and the host Player table (the last
    // two are needed to write holder links + repoint Player.GameStats for debut-holder allocation).
    const hostGameTbl = {};
    for (const tn of gameTables) { const t = franchise.getTableByName(tn); if (t) { await t.readRecords(); hostGameTbl[tn] = t; } }
    const holderIds = new Set();
    for (const meta of guestMap.playerMeta.values()) { if (meta.gameHolderRef) holderIds.add(meta.gameHolderRef.tableId); }
    for (const hid of holderIds) { const ht = franchise.getTableById(hid); if (ht) await ht.readRecords(); }
    // hostPlayerTbl is the shared handle read up front (used for debut SeasonStats/GameStats links).

    let grows = 0, gfields = 0, holdersMade = 0;
    for (const [pkey, gMeta] of guestMap.playerMeta) {
      const gHolderRef = gMeta.gameHolderRef;
      if (!gHolderRef) continue;                         // guest player has never recorded a game
      const hMeta = hostMap.playerMeta.get(pkey);
      const pname = gMeta.name || pkey;
      if (!hMeta) continue;                              // guest-only player (divergent roster) — can't write

      const gHolderT = guestFr.getTableById(gHolderRef.tableId); await gHolderT.readRecords();
      const gHolder = gHolderT.records[gHolderRef.rowNumber];
      if (!gHolder) continue;

      // Collect this player's merged-game rows from their guest holder.
      const mergedRows = []; // {slotK, tn, gRec}
      for (const slotK of Object.keys(gHolder.fields)) {
        if (!/^GameStats\d+$/.test(slotK)) continue;
        const sf = gHolder.fields[slotK];
        if (!sf || !sf.isReference || !sf.referenceData) continue;
        const v = sf.value; if (!v || /^0+$/.test(String(v))) continue;
        const gT = guestFr.getTableById(sf.referenceData.tableId);
        const tn = gT && gT.name;
        if (!gameTables.includes(tn)) continue;
        await gT.readRecords();
        const gRec = gT.records[sf.referenceData.rowNumber];
        const sgr = gRec && gRec.fields['SeasonGame'];
        if (!sgr || !sgr.referenceData || !mergedGameIdx.has(sgr.referenceData.rowNumber)) continue;
        mergedRows.push({ slotK, tn, gRec });
      }
      if (!mergedRows.length) continue;

      // Resolve the host GameStats holder, allocating one for true-debut players who lack it.
      let hHolderRef = hMeta.gameHolderRef;
      if (!hHolderRef) {
        const holderT = franchise.getTableById(gHolderRef.tableId);
        if (!holderT) { warnings.push(`BoxScore: ${pname} holder table ${gHolderRef.tableId} unresolved; skipped`); continue; }
        const mergedSlots = new Set(mergedRows.map(r => r.slotK));
        hHolderRef = allocateGameHolder(holderT, gHolderRef.tableId, hostPlayerTbl, hMeta, gHolder, mergedSlots, pname);
        if (!hHolderRef) continue; // allocation failed (warned)
        holdersMade++;
      }

      for (const { slotK, tn, gRec } of mergedRows) {
        const hostT = hostGameTbl[tn];
        if (!hostT) { warnings.push(`BoxScore: host missing ${tn}`); continue; }
        // Mirror the guest's holder slot index (slots are week-indexed; see allocateGameRow).
        const res = allocateGameRow(hostT, tn, gRec, pname, hHolderRef, slotK);
        if (res) { grows++; gfields += res.fields; }
      }
    }
    if (grows) applied['Box score (per-game lines)'] = { rows: grows, fields: gfields };
    if (holdersMade) applied['Box score (debut holders)'] = { rows: holdersMade, fields: holdersMade };
  }

  // --- Team box-score (per-game team stat rows + SeasonGame cache links) ---
  // The box-score PAGE reads team totals from SeasonGame.{Home,Away}TeamStatCache -> per-game
  // TeamStats rows. Those are empty in host (unplayed), so the page shows 0s + default (Bears) logos.
  // For each merged game, allocate the 2 per-game TeamStats rows guest->host and repoint the host
  // SeasonGame's cache fields. (TeamStats per-game rows are pure scalar — no refs to rewrite.)
  if (merge.teamBoxScore && humanGameKeys.size) {
    const tsName = merge.teamStatsTable || 'TeamStats';
    const cacheFields = merge.teamCacheFields || ['HomeTeamStatCache', 'AwayTeamStatCache'];
    const gTs = guestFr.getTableByName(tsName), hTs = franchise.getTableByName(tsName);
    const gSg = guestFr.getTableByName(merge.resultTable), hSg = franchise.getTableByName(merge.resultTable);
    if (gTs && hTs && gSg && hSg) {
      await gTs.readRecords(); await hTs.readRecords(); await gSg.readRecords(); await hSg.readRecords();
      const resultKeyFields = keyFieldsByTable[merge.resultTable] || [];
      const usedTeamIdx = new Set(); // guard: each allocation must consume a fresh free-list head
      let trows = 0, tfields = 0;
      for (const gRec of gSg.records) {
        if (!gRec || gRec.isEmpty) continue;
        const key = resultKeyFields.map(k => `${k}=${safe(() => gRec.getValueByKey(k))}`).join('|');
        if (!humanGameKeys.has(key)) continue;
        const hRec = locateHostRecord(hSg, merge.resultTable, key, resultKeyFields, warnings);
        if (!hRec) continue;

        for (const cacheField of cacheFields) {
          const gcf = gRec.fields[cacheField];
          if (!gcf || !gcf.referenceData) continue;
          const cv = gcf.value; if (!cv || /^0+$/.test(String(cv))) continue;
          const gTeamRow = gTs.records[gcf.referenceData.rowNumber];
          if (!gTeamRow) { warnings.push(`TeamBox: guest ${cacheField} row missing`); continue; }

          const idx = hTs.header.nextRecordToUse;
          if (idx == null || idx >= hTs.header.recordCapacity) { warnings.push(`${tsName}: full; cannot allocate team box row`); continue; }
          if (usedTeamIdx.has(idx)) { warnings.push(`${tsName}: nextRecordToUse stuck at ${idx} (free-list not advancing); aborting team box for ${cacheField}`); continue; }
          const hRow = hTs.records[idx];
          if (!hRow) continue;

          let touched = 0; const sample = {};
          for (const k of Object.keys(gTeamRow.fields)) {
            const gf = gTeamRow.fields[k];
            if (!gf || !hRow.fields[k]) continue;
            try {
              if (gf.isReference) hRow.fields[k].value = gf.value;
              else hRow.fields[k].value = safe(() => gTeamRow.getValueByKey(k));
              touched++; tfields++;
              if (['TOTALYARDS', 'FIRSTDOWNS', 'OFFPASSYARDS', 'OFFRUSHYARDS'].includes(k)) sample[k] = safe(() => gTeamRow.getValueByKey(k));
            } catch (e) { warnings.push(`${tsName}.${k}: set failed (${e.message})`); }
          }
          if (hRow.isEmpty) { warnings.push(`${tsName}: team box row ${idx} still empty; aborted`); continue; }
          try { hRec.fields[cacheField].value = hTs.getBinaryReferenceToRecord(idx); }
          catch (e) { warnings.push(`${cacheField} link failed (${e.message})`); continue; }
          usedTeamIdx.add(idx);

          // Link the allocated team-stat row into the team's TeamGameStatsRegSeason array — the
          // per-team, WEEK-INDEXED list the box-score PAGE actually reads. The SeasonGame cache alone
          // does NOT render team totals (proven: caches set + array missing -> page shows 0s). Mirror
          // the exact slot the guest used (host/guest share the array layout, like the GameStats holder).
          const teamField = cacheField.replace('StatCache', ''); // HomeTeamStatCache -> HomeTeam
          let arrayInfo = null;
          const gTeamRef = gRec.fields[teamField] && gRec.fields[teamField].referenceData;
          if (gTeamRef && !(gTeamRef.tableId === 0 && gTeamRef.rowNumber === 0)) {
            const gTeam = guestFr.getTableById(gTeamRef.tableId); await gTeam.readRecords();
            const hTeam = franchise.getTableById(gTeamRef.tableId); await hTeam.readRecords();
            const gArrF = gTeam.records[gTeamRef.rowNumber].fields['TeamGameStatsRegSeason'];
            const hArrF = hTeam.records[gTeamRef.rowNumber].fields['TeamGameStatsRegSeason'];
            const gArrRd = gArrF && gArrF.referenceData, hArrRd = hArrF && hArrF.referenceData;
            if (gArrRd && hArrRd && !(gArrRd.tableId === 0 && gArrRd.rowNumber === 0)) {
              const gArrT = guestFr.getTableById(gArrRd.tableId); await gArrT.readRecords();
              const hArrT = franchise.getTableById(hArrRd.tableId); await hArrT.readRecords();
              const gArr = gArrT.records[gArrRd.rowNumber], hArr = hArrT.records[hArrRd.rowNumber];
              const guestStatRow = gcf.referenceData.rowNumber;
              // Find the guest slot that points at the guest's per-game team-stat row for this game.
              let slot = null;
              for (const k of Object.keys(gArr.fields)) {
                const sf = gArr.fields[k];
                if (sf && sf.isReference && sf.referenceData && sf.referenceData.rowNumber === guestStatRow && !/^0+$/.test(String(sf.value))) { slot = k; break; }
              }
              if (!slot) { warnings.push(`TeamBox: ${teamField} guest array slot for stat row ${guestStatRow} not found; team totals may not render`); }
              else {
                const existing = hArr.fields[slot] && hArr.fields[slot].value;
                if (existing && !/^0+$/.test(String(existing))) {
                  warnings.push(`TeamBox: host ${teamField} array slot ${slot} already occupied; not linked (divergence)`);
                } else {
                  try { hArr.fields[slot].value = hTs.getBinaryReferenceToRecord(idx); arrayInfo = { arrTableId: hArrRd.tableId, arrRow: hArrRd.rowNumber, slot }; }
                  catch (e) { warnings.push(`TeamBox: ${teamField} array link failed (${e.message})`); }
                }
              }
            }
          }

          trows++;
          teamBoxExpect.push({ table: tsName, idx, cacheField, gameKey: key, sample, array: arrayInfo });
        }
      }
      if (trows) applied['Team box score'] = { rows: trows, fields: tfields };
    }
  }

  // 3. Save merged file.
  await franchise.save(out);

  // 4. Reload-verify: re-open output and confirm a sample of transplanted values landed.
  const verify = await verifyMerge(out, report, config, merge, humanGameKeys, expectedTeam, guestMap, hostMap, allocated, careerExpect, boxExpect, teamBoxExpect, gameHoldersAllocated, seasonHoldersAllocated, careerAllocated);

  return { applied, skipped, warnings, verify, remaps, allocated, boxScore: boxExpect.length, gameHolders: gameHoldersAllocated.length, seasonHolders: seasonHoldersAllocated.length, careerNew: careerAllocated.length, teamBox: teamBoxExpect.length };
}

function positionalIndex(key) {
  const m = /^#(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

/** Locate a host record for a diff key: positional "#i" or a natural key "a=..|b=..". */
function locateHostRecord(tbl, tableName, key, keyFields, warnings) {
  const idx = positionalIndex(key);
  if (idx != null) {
    const rec = tbl.records[idx];
    if (!rec) warnings.push(`${tableName}: no host record at index ${idx}`);
    return rec || null;
  }
  // natural key: parse "field=value|field=value"
  const want = {};
  for (const part of key.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0) want[part.slice(0, eq)] = part.slice(eq + 1);
  }
  for (const rec of tbl.records) {
    if (!rec || rec.isEmpty) continue;
    let match = true;
    for (const k of keyFields) {
      if (String(safe(() => rec.getValueByKey(k))) !== String(want[k])) { match = false; break; }
    }
    if (match) return rec;
  }
  warnings.push(`${tableName}: no host row matching key ${key}`);
  return null;
}

/** Re-open the saved file and confirm transplanted values match the guest change-set. */
async function verifyMerge(outPath, report, config, merge, humanGameKeys, expectedTeam, guestMap, hostMap, allocated, careerExpect, boxExpect, teamBoxExpect, gameHoldersAllocated, seasonHoldersAllocated, careerAllocated) {
  const f = await openFranchise(outPath, config.schema || {});
  const keyFieldsByTable = {};
  for (const def of config.tables.definitions) keyFieldsByTable[def.name] = def.keyFields || [];
  const resultFields = new Set(merge.resultFields);
  const aggregateTables = new Set(merge.aggregateTables);

  let checked = 0, ok = 0, mismatches = [];
  for (const [tableName, tdiff] of Object.entries(report.tables)) {
    const isResult = tableName === merge.resultTable;
    if (!isResult && !aggregateTables.has(tableName)) continue;
    const tbl = f.getTableByName(tableName);
    if (!tbl) continue;
    await tbl.readRecords();
    const rowFilter = (merge.rowFilters && merge.rowFilters[tableName]) || null;
    for (const mod of tdiff.modified) {
      if (isResult && merge.humanGameFilter && humanGameKeys && !humanGameKeys.has(mod.key)) continue;
      if (rowFilter && !mod.changes.some(c => rowFilter.includes(c.field))) continue;
      let rec;
      if (!isResult && guestMap && hostMap) {
        // Aggregate: read back the SAME host row the apply step wrote (by player identity).
        const gi = positionalIndex(mod.key);
        const res = resolveHostAggregateRow(guestMap, hostMap, tableName, gi);
        if (res.status === 'no-host-row') continue; // skipped on apply; nothing to verify
        rec = res.status === 'orphan' ? tbl.records[gi] : tbl.records[res.hostRow];
      } else {
        rec = locateHostRecord(tbl, tableName, mod.key, keyFieldsByTable[tableName], []);
      }
      if (!rec) continue;
      for (const ch of mod.changes) {
        if (isResult && !resultFields.has(ch.field)) continue;
        if (rec.fields[ch.field] && rec.fields[ch.field].isReference) continue;
        checked++;
        const got = safe(() => rec.getValueByKey(ch.field));
        if (String(got) === String(ch.to)) ok++;
        else if (mismatches.length < 20) mismatches.push(`${tableName}[${mod.key}].${ch.field}: got ${got}, want ${ch.to}`);
      }
    }
  }
  // Team-record (standings) fields
  if (expectedTeam) {
    const tt = f.getTableById(expectedTeam.teamTableId);
    if (tt) {
      await tt.readRecords();
      for (const [row, fieldVals] of Object.entries(expectedTeam.rows)) {
        const rec = tt.records[Number(row)];
        if (!rec) continue;
        for (const [field, want] of Object.entries(fieldVals)) {
          checked++;
          const got = safe(() => rec.getValueByKey(field));
          if (String(got) === String(want)) ok++;
          else if (mismatches.length < 20) mismatches.push(`Team[${row}].${field}: got ${got}, want ${want}`);
        }
      }
    }
  }

  // Allocated (debut-player) rows: confirm the new row persisted, its values landed, and the
  // holder slot actually points at it (the link is what makes the row visible in-game).
  for (const a of (allocated || [])) {
    const tbl = f.getTableByName(a.table);
    if (!tbl) continue;
    await tbl.readRecords();
    const rec = tbl.records[a.idx];
    checked++;
    if (!rec || rec.isEmpty) { mismatches.push(`alloc ${a.table}#${a.idx} (${a.player}) empty after reload`); continue; }
    ok++;
    for (const [field, want] of Object.entries(a.expect)) {
      if (rec.fields[field] && rec.fields[field].isReference) continue;
      checked++;
      const got = safe(() => rec.getValueByKey(field));
      if (String(got) === String(want)) ok++;
      else if (mismatches.length < 20) mismatches.push(`alloc ${a.table}#${a.idx}.${field}: got ${got}, want ${want}`);
    }
    // Holder link
    const holder = f.getTableById(a.holderTableId);
    if (holder) {
      await holder.readRecords();
      const hr = holder.records[a.holderRow];
      const rd = hr && hr.fields[a.slot] && hr.fields[a.slot].referenceData;
      checked++;
      if (rd && rd.rowNumber === a.idx) ok++;
      else mismatches.push(`alloc ${a.table}: holder ${a.slot} -> ${rd && rd.rowNumber}, want ${a.idx}`);
    }
  }

  // Career rows: confirm a sample of each transplanted player's career values landed.
  for (const c of (careerExpect || [])) {
    const t = f.getTableById(c.tableId);
    if (!t) continue;
    await t.readRecords();
    const rec = t.records[c.row];
    if (!rec) { mismatches.push(`career ${c.player} row ${c.row} missing`); checked++; continue; }
    for (const [field, want] of Object.entries(c.sample)) {
      checked++;
      const got = safe(() => rec.getValueByKey(field));
      if (String(got) === String(want)) ok++;
      else if (mismatches.length < 20) mismatches.push(`career ${c.player}.${field}: got ${got}, want ${want}`);
    }
  }

  // Box-score rows: confirm each per-game row persisted, points at the right SeasonGame, and is
  // linked from the player's GameStats holder.
  for (const b of (boxExpect || [])) {
    const t = f.getTableByName(b.table);
    if (!t) continue;
    await t.readRecords();
    const rec = t.records[b.idx];
    checked++;
    if (!rec || rec.isEmpty) { mismatches.push(`box ${b.table}#${b.idx} (${b.player}) empty after reload`); continue; }
    ok++;
    // SeasonGame ref landed
    checked++;
    const sgVal = rec.fields['SeasonGame'] && rec.fields['SeasonGame'].value;
    if (sgVal && b.sgRef && String(sgVal) === String(b.sgRef)) ok++;
    else mismatches.push(`box ${b.table}#${b.idx} (${b.player}): SeasonGame ref ${sgVal} != ${b.sgRef}`);
    // holder link
    const holder = f.getTableById(b.holderTableId);
    if (holder) {
      await holder.readRecords();
      const hr = holder.records[b.holderRow];
      const rd = hr && hr.fields[b.slot] && hr.fields[b.slot].referenceData;
      checked++;
      if (rd && rd.rowNumber === b.idx) ok++;
      else mismatches.push(`box ${b.table} (${b.player}): holder ${b.slot} -> ${rd && rd.rowNumber}, want ${b.idx}`);
    }
  }

  // Allocated GameStats holders (debut players): confirm the host Player record now points at the
  // freshly-created holder row (the link that makes the player's game log reachable).
  for (const h of (gameHoldersAllocated || [])) {
    const pt = f.getTableByName('Player');
    if (!pt) continue;
    await pt.readRecords();
    const prec = pt.records[h.playerRow];
    checked++;
    const rd = prec && prec.fields['GameStats'] && prec.fields['GameStats'].referenceData;
    if (rd && rd.tableId === h.holderTableId && rd.rowNumber === h.holderRow) ok++;
    else mismatches.push(`gameHolder ${h.player}: Player.GameStats -> ${rd && rd.tableId}#${rd && rd.rowNumber}, want ${h.holderTableId}#${h.holderRow}`);
  }

  // Allocated SeasonStats holders (true debuts): confirm Player.SeasonStats points at the new holder.
  for (const h of (seasonHoldersAllocated || [])) {
    const pt = f.getTableByName('Player');
    if (!pt) continue;
    await pt.readRecords();
    const prec = pt.records[h.playerRow];
    checked++;
    const rd = prec && prec.fields['SeasonStats'] && prec.fields['SeasonStats'].referenceData;
    if (rd && rd.tableId === h.holderTableId && rd.rowNumber === h.holderRow) ok++;
    else mismatches.push(`seasonHolder ${h.player}: Player.SeasonStats -> ${rd && rd.tableId}#${rd && rd.rowNumber}, want ${h.holderTableId}#${h.holderRow}`);
  }

  // Allocated Career rows (true debuts): confirm the row persisted with its values AND Player.CareerStats
  // points at it.
  for (const c of (careerAllocated || [])) {
    const t = f.getTableById(c.tableId);
    if (t) {
      await t.readRecords();
      const rec = t.records[c.row];
      checked++;
      if (!rec || rec.isEmpty) mismatches.push(`careerNew ${c.player} row ${c.row} empty after reload`);
      else {
        ok++;
        for (const [field, want] of Object.entries(c.sample)) {
          checked++;
          const got = safe(() => rec.getValueByKey(field));
          if (String(got) === String(want)) ok++;
          else if (mismatches.length < 20) mismatches.push(`careerNew ${c.player}.${field}: got ${got}, want ${want}`);
        }
      }
    }
    const pt = f.getTableByName('Player');
    if (pt) {
      await pt.readRecords();
      const prec = pt.records[c.playerRow];
      checked++;
      const rd = prec && prec.fields['CareerStats'] && prec.fields['CareerStats'].referenceData;
      if (rd && rd.tableId === c.tableId && rd.rowNumber === c.row) ok++;
      else mismatches.push(`careerNew ${c.player}: Player.CareerStats -> ${rd && rd.tableId}#${rd && rd.rowNumber}, want ${c.tableId}#${c.row}`);
    }
  }

  // Team box-score rows: confirm each per-game team row persisted with its stats AND the host
  // SeasonGame cache field now points at it.
  if (teamBoxExpect && teamBoxExpect.length) {
    const keyFields = keyFieldsByTable[merge.resultTable] || [];
    const hSg = f.getTableByName(merge.resultTable);
    if (hSg) await hSg.readRecords();
    for (const b of teamBoxExpect) {
      const t = f.getTableByName(b.table);
      if (!t) continue;
      await t.readRecords();
      const rec = t.records[b.idx];
      checked++;
      if (!rec || rec.isEmpty) { mismatches.push(`teambox ${b.table}#${b.idx} empty after reload`); continue; }
      ok++;
      for (const [field, want] of Object.entries(b.sample)) {
        checked++;
        const got = safe(() => rec.getValueByKey(field));
        if (String(got) === String(want)) ok++;
        else if (mismatches.length < 20) mismatches.push(`teambox ${b.table}#${b.idx}.${field}: got ${got}, want ${want}`);
      }
      // cache pointer on the host SeasonGame
      if (hSg) {
        const gameRec = locateHostRecord(hSg, merge.resultTable, b.gameKey, keyFields, []);
        const rd = gameRec && gameRec.fields[b.cacheField] && gameRec.fields[b.cacheField].referenceData;
        checked++;
        if (rd && rd.rowNumber === b.idx) ok++;
        else mismatches.push(`teambox ${b.cacheField} -> ${rd && rd.rowNumber}, want ${b.idx}`);
      }
      // TeamGameStatsRegSeason array slot now points at the allocated team row (what the page reads)
      if (b.array) {
        const at = f.getTableById(b.array.arrTableId);
        if (at) {
          await at.readRecords();
          const arr = at.records[b.array.arrRow];
          const rd = arr && arr.fields[b.array.slot] && arr.fields[b.array.slot].referenceData;
          checked++;
          if (rd && rd.rowNumber === b.idx) ok++;
          else mismatches.push(`teambox array ${b.cacheField} slot ${b.array.slot} -> ${rd && rd.rowNumber}, want ${b.idx}`);
        }
      }
    }
  }

  return { checked, ok, mismatches, pass: checked > 0 && ok === checked };
}

/**
 * Preview what a merge WOULD do, without writing — for the GUI confirm screen.
 * Returns the guest's real played game(s) (team names + score) and how many player season-stat
 * lines come with them.
 */
async function previewMerge({ baseline, guest, config }) {
  const merge = config.merge;
  if (!merge) throw new Error('config.merge policy missing');
  const baseSnap = await snapshot(baseline, config, null);
  const guestSnap = await snapshot(guest, config, null);
  const report = diffSnapshots(baseSnap, guestSnap);

  const guestRows = (guestSnap.tables[merge.resultTable] || {}).rows || [];
  const changedKeys = new Set(((report.tables[merge.resultTable] || {}).modified || []).map(m => m.key));
  const humanRows = guestRows.filter(r =>
    changedKeys.has(r.__key) &&
    Object.entries(merge.humanGameFilter || {}).every(([f, v]) => String(r[f]) === String(v)));

  const fr = await openFranchise(guest, config.schema || {});
  const teamName = await buildTeamResolver(fr, merge.resultTable);
  const games = humanRows.map(r => ({
    home: teamName(r.HomeTeam), away: teamName(r.AwayTeam),
    homeScore: r.HomeScore, awayScore: r.AwayScore,
    week: (Number(r.SeasonWeek) + 1), // SeasonWeek is 0-indexed
  }));

  // Count both MODIFIED and ADDED season-stat rows: early in a season a player's first game CREATES
  // their season row (added), not modifies an existing one, so a Week-1 game is almost all added rows.
  // (Season tables aren't polluted by provisional ticker sims, so added rows are real game players.)
  let statLines = 0;
  for (const t of (merge.aggregateTables || [])) {
    const td = report.tables[t] || {};
    statLines += (td.modified || []).length + (td.added || []).length;
  }

  const warnings = [...(baseSnap.meta.warnings || []), ...(guestSnap.meta.warnings || [])];
  return { games, statLines, warnings };
}

/** Returns a fn(refBinaryString) -> team display name, with the Team table pre-read. */
async function buildTeamResolver(franchise, resultTable) {
  const sg = franchise.getTableByName(resultTable);
  await sg.readRecords();
  for (const r of sg.records) {
    if (!r || r.isEmpty) continue;
    const rd = r.fields['HomeTeam'] && r.fields['HomeTeam'].referenceData;
    if (rd && rd.tableId) {
      const t = franchise.getTableById(rd.tableId) || franchise.getTableByUniqueId(rd.tableId);
      if (t) await t.readRecords();
      break;
    }
  }
  return (refString) => {
    try {
      const rec = franchise.getReferencedRecord(refString);
      return (rec && (safe(() => rec.getValueByKey('DisplayName')) || safe(() => rec.getValueByKey('ShortName')))) || 'Team';
    } catch { return 'Team'; }
  };
}

module.exports = { applyMerge, previewMerge };
