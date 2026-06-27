'use strict';

/**
 * DIFF: compare two snapshots (baseline vs. modified) and emit a structured
 * change report. This is the heart of the merge workflow: pointed at
 * (shared baseline) vs. (User B's post-game save), it tells you exactly which
 * rows User B changed — i.e. the rows you'd transplant onto User A's save.
 *
 * Pure function over snapshot JSON — no game library involved — so it runs and
 * is testable with zero save files today.
 *
 * Report shape:
 * {
 *   meta: { baseline, modified, generatedAt },
 *   tables: {
 *     <TableName>: {
 *       added:    [ { key, row } ],
 *       removed:  [ { key, row } ],
 *       modified: [ { key, changes: [ { field, from, to } ] } ],
 *       unchanged: <count>
 *     }
 *   },
 *   summary: { tablesChanged, added, removed, modified }
 * }
 */

function diffSnapshots(baseline, modified, { ignoreFields = [], ignoreInternal = true } = {}) {
  const ignore = new Set([...ignoreFields, ...(ignoreInternal ? ['__key', '__index'] : [])]);
  const report = { meta: buildMeta(baseline, modified), tables: {}, summary: { tablesChanged: 0, added: 0, removed: 0, modified: 0 } };

  const tableNames = unionKeys(baseline.tables, modified.tables);

  for (const name of tableNames) {
    const a = (baseline.tables[name] && baseline.tables[name].rows) || [];
    const b = (modified.tables[name] && modified.tables[name].rows) || [];

    const aMap = indexByKey(a);
    const bMap = indexByKey(b);

    const added = [];
    const removed = [];
    const modifiedRows = [];
    let unchanged = 0;

    for (const [key, brow] of bMap) {
      if (!aMap.has(key)) {
        added.push({ key, row: strip(brow, ignore) });
      } else {
        const changes = fieldChanges(aMap.get(key), brow, ignore);
        if (changes.length) modifiedRows.push({ key, changes });
        else unchanged++;
      }
    }
    for (const [key, arow] of aMap) {
      if (!bMap.has(key)) removed.push({ key, row: strip(arow, ignore) });
    }

    const changed = added.length || removed.length || modifiedRows.length;
    if (changed) report.summary.tablesChanged++;
    report.summary.added += added.length;
    report.summary.removed += removed.length;
    report.summary.modified += modifiedRows.length;

    report.tables[name] = { added, removed, modified: modifiedRows, unchanged };
  }

  return report;
}

function fieldChanges(arow, brow, ignore) {
  const keys = new Set([...Object.keys(arow), ...Object.keys(brow)]);
  const changes = [];
  for (const k of keys) {
    if (ignore.has(k)) continue;
    const from = arow[k];
    const to = brow[k];
    if (!valueEqual(from, to)) changes.push({ field: k, from: from ?? null, to: to ?? null });
  }
  return changes;
}

function valueEqual(x, y) {
  if (x === y) return true;
  if (x == null && y == null) return true;
  return String(x) === String(y);
}

function indexByKey(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.__key, r);
  return m;
}

function unionKeys(a = {}, b = {}) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

function strip(row, ignore) {
  const out = {};
  for (const k of Object.keys(row)) if (!ignore.has(k)) out[k] = row[k];
  return out;
}

function buildMeta(baseline, modified) {
  return {
    baseline: (baseline.meta && baseline.meta.source) || 'baseline',
    modified: (modified.meta && modified.meta.source) || 'modified',
    generatedAt: new Date().toISOString(),
  };
}

function printSummary(report) {
  const s = report.summary;
  console.log(`\nDiff: ${report.meta.baseline}  ->  ${report.meta.modified}`);
  console.log(`Tables changed: ${s.tablesChanged}   +${s.added} rows  -${s.removed} rows  ~${s.modified} rows\n`);
  for (const [name, t] of Object.entries(report.tables)) {
    if (!t.added.length && !t.removed.length && !t.modified.length) continue;
    console.log(`  ${name}: +${t.added.length} / -${t.removed.length} / ~${t.modified.length}  (unchanged ${t.unchanged})`);
    for (const m of t.modified.slice(0, 5)) {
      const preview = m.changes.slice(0, 4).map(c => `${c.field}: ${c.from}→${c.to}`).join(', ');
      console.log(`      [${m.key}] ${preview}${m.changes.length > 4 ? ' …' : ''}`);
    }
  }
  console.log('');
}

module.exports = { diffSnapshots, printSummary };
