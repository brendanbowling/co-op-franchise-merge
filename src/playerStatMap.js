'use strict';

/**
 * PLAYER-ID HARDENING: map each season stat row to the PLAYER that owns it, so the
 * merge can transplant a guest's changed stat row onto the SAME player's row in the
 * host — by identity, not by slot index.
 *
 * Why this exists: the season stat tables carry no in-row player identity. The only
 * link is FROM the Player record: Player.SeasonStats -> a holder row (table "SeasonStats[]")
 * whose sub-reference slots each point at a position-specific season table
 * (SeasonOffensiveStats / SeasonDefensiveStats / SeasonKickingStats / ...). Slots are
 * polymorphic (slot name is NOT the position), so we classify by the TARGET table name.
 *
 * Matching by slot index alone breaks when a roster transaction (FA sign / trade / call-up)
 * allocates a player's stat row at a different index in two diverging saves. Keying by a
 * stable player identity (FirstName|LastName|BirthDate|DraftTeam|DraftPick — verified unique
 * and collision-free across the full Player table) makes the transplant robust.
 *
 * Library-coupled (walks references), so it lives behind the openFranchise seam.
 */

const { safe } = require('./openFranchise');

/** Stable cross-file player identity. Composite natural key (no reliance on row position). */
function playerKey(rec) {
  const g = k => safe(() => rec.getValueByKey(k));
  return [g('FirstName'), g('LastName'), g('PLYR_BIRTHDATE'), g('PLYR_DRAFTTEAM'), g('PLYR_DRAFTPICK')].join('|');
}

function isNullRef(field) {
  const v = field && field.value;
  return !v || /^0+$/.test(String(v));
}

// Players keep ONE stat row PER SEASON; the holder links to all of them across years. The merge
// must target the row for the SAME season, so rows are keyed by (player, table, seasonYear).
// (Without the year, a current-season write could land on a prior-season row at a different index.)
const SEASON_YEAR_FIELD = 'SEAS_YEAR';

/**
 * Build the player<->season-stat-row maps for one opened franchise.
 * @param {object} franchise opened FranchiseFile
 * @param {object} opts
 * @param {string[]} opts.statTables target season tables to map (e.g. config.merge.aggregateTables)
 * @returns {Promise<{rowToPlayer: Map, playerToRow: Map, playerMeta: Map, warnings: string[]}>}
 *   rowToPlayer: `${tableName}#${rowIndex}` -> { key, year }
 *   playerToRow: `${playerKey}::${tableName}::${year}` -> rowIndex
 *   playerMeta:  playerKey -> { name, teamIndex, playerRow }
 */
async function buildPlayerStatMap(franchise, { statTables }) {
  const want = new Set(statTables);
  const warnings = [];
  const player = franchise.getTableByName('Player');
  if (!player) { warnings.push('Player table not found; player-id map empty'); return empty(warnings); }
  await player.readRecords();

  // Discover the SeasonStats holder table id dynamically (more robust than hardcoding).
  let holderId = null;
  for (const r of player.records) {
    if (!r || r.isEmpty) continue;
    const sf = r.fields['SeasonStats'];
    if (sf && sf.isReference && !isNullRef(sf) && sf.referenceData) { holderId = sf.referenceData.tableId; break; }
  }
  if (holderId == null) { warnings.push('No player with a SeasonStats link; player-id map empty'); return empty(warnings); }
  const holder = franchise.getTableById(holderId);
  if (!holder) { warnings.push(`SeasonStats holder table ${holderId} not resolvable`); return empty(warnings); }
  await holder.readRecords();

  // Pre-read the wanted stat tables so we can read each row's season year.
  const tableById = new Map();  // tableId -> { name, table } (only for wanted tables; null name otherwise)
  const rowToPlayer = new Map();
  const playerToRow = new Map();
  const playerMeta = new Map();

  async function classify(tableId) {
    if (tableById.has(tableId)) return tableById.get(tableId);
    const t = franchise.getTableById(tableId);
    const name = (t && t.name) || null;
    let entry = { name, table: null };
    if (name && want.has(name)) { await t.readRecords(); entry.table = t; }
    tableById.set(tableId, entry);
    return entry;
  }

  for (let i = 0; i < player.records.length; i++) {
    const r = player.records[i];
    if (!r || r.isEmpty) continue;
    const key = playerKey(r);
    const sf = r.fields['SeasonStats'];
    const holderRef = (sf && sf.isReference && !isNullRef(sf) && sf.referenceData)
      ? { tableId: sf.referenceData.tableId, rowNumber: sf.referenceData.rowNumber } : null;
    const cf = r.fields['CareerStats'];
    const careerRef = (cf && cf.isReference && !isNullRef(cf) && cf.referenceData)
      ? { tableId: cf.referenceData.tableId, rowNumber: cf.referenceData.rowNumber } : null;
    const gmf = r.fields['GameStats'];
    const gameHolderRef = (gmf && gmf.isReference && !isNullRef(gmf) && gmf.referenceData)
      ? { tableId: gmf.referenceData.tableId, rowNumber: gmf.referenceData.rowNumber } : null;
    if (!playerMeta.has(key)) {
      playerMeta.set(key, {
        name: `${safe(() => r.getValueByKey('FirstName')) || ''} ${safe(() => r.getValueByKey('LastName')) || ''}`.trim(),
        teamIndex: safe(() => r.getValueByKey('TeamIndex')),
        playerRow: i,
        holderRef,      // {tableId, rowNumber} of this player's SeasonStats holder row (for allocation)
        careerRef,      // {tableId, rowNumber} of this player's single cumulative career row
        gameHolderRef,  // {tableId, rowNumber} of this player's GameStats holder (per-game box scores)
      });
    }

    if (!holderRef) continue;
    const hrow = holder.records[holderRef.rowNumber];
    if (!hrow) continue;

    for (const fk of Object.keys(hrow.fields)) {
      const hf = hrow.fields[fk];
      if (!hf || !hf.isReference || isNullRef(hf) || !hf.referenceData) continue;
      const rd = hf.referenceData;
      const { name: tn, table } = await classify(rd.tableId);
      if (!tn || !want.has(tn)) continue;

      const srec = table && table.records[rd.rowNumber];
      const year = srec ? safe(() => srec.getValueByKey(SEASON_YEAR_FIELD)) : null;

      const rowSlot = `${tn}#${rd.rowNumber}`;
      if (!rowToPlayer.has(rowSlot)) rowToPlayer.set(rowSlot, { key, year });

      const pr = `${key}::${tn}::${year}`;
      if (playerToRow.has(pr) && playerToRow.get(pr) !== rd.rowNumber) {
        warnings.push(`${tn}: ${playerMeta.get(key).name} has two rows for season ${year} (#${playerToRow.get(pr)}, #${rd.rowNumber}); keeping first`);
        continue;
      }
      playerToRow.set(pr, rd.rowNumber);
    }
  }

  return { rowToPlayer, playerToRow, playerMeta, warnings, holderId };
}

function empty(warnings) {
  return { rowToPlayer: new Map(), playerToRow: new Map(), playerMeta: new Map(), warnings, holderId: null };
}

/**
 * Resolve which HOST row a guest aggregate change should be written to, by player identity.
 * @returns {{ status: string, hostRow: number|null, playerKey: string|null, playerName: string|null }}
 *   status: 'ok'       host row found at the SAME index (aligned; no-op remap)
 *           'remapped' host row found at a DIFFERENT index (identity saved us)
 *           'no-host-row' guest player has no host row in this table (divergent roster -> skip)
 *           'orphan'   guest row not linked from any player (fall back to positional)
 */
function resolveHostAggregateRow(guestMap, hostMap, tableName, guestRowIndex) {
  const info = guestMap.rowToPlayer.get(`${tableName}#${guestRowIndex}`);
  if (!info) return { status: 'orphan', hostRow: null, playerKey: null, playerName: null };
  const { key: pkey, year } = info;
  const name = (guestMap.playerMeta.get(pkey) || {}).name || pkey;
  const hostRow = hostMap.playerToRow.get(`${pkey}::${tableName}::${year}`);
  if (hostRow == null) return { status: 'no-host-row', hostRow: null, playerKey: pkey, playerName: name };
  return { status: hostRow === guestRowIndex ? 'ok' : 'remapped', hostRow, playerKey: pkey, playerName: name };
}

module.exports = { buildPlayerStatMap, resolveHostAggregateRow, playerKey };
