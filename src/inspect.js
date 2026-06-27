'use strict';

/**
 * INSPECT: open a save and print every table with id, capacity, and how many
 * records are actually populated. This is the first thing you run against a
 * CFB 27 save to discover real table names (which then go into the config).
 */

const { openFranchise, fileMeta, safe } = require('./openFranchise');

async function inspect(filePath, schemaCfg = {}, { filter = null, json = false } = {}) {
  const franchise = await openFranchise(filePath, schemaCfg);
  const meta = fileMeta(franchise, filePath);

  const rows = (franchise.tables || []).map((t, i) => ({
    index: i,
    name: safe(() => t.name) || '(unnamed)',
    tableId: safe(() => t.header && t.header.tableId),
    capacity: safe(() => t.header && t.header.recordCapacity),
    members: safe(() => t.header && t.header.numMembers),
  }));

  const filtered = filter
    ? rows.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()))
    : rows;

  if (json) {
    return { meta, tables: filtered };
  }

  // Pretty print
  console.log(`\nFile: ${meta.source}`);
  console.log(`Game year: ${meta.gameYear ?? '?'}   Type: ${meta.type ?? '?'}   Schema: ${meta.schemaVersion ?? '?'}`);
  console.log(`Tables: ${meta.tableCount}${filter ? `  (showing ${filtered.length} matching "${filter}")` : ''}\n`);
  console.log(pad('IDX', 5) + pad('NAME', 40) + pad('TABLE_ID', 12) + pad('CAP', 8) + 'COLS');
  console.log('-'.repeat(78));
  for (const r of filtered) {
    console.log(
      pad(String(r.index), 5) +
      pad(r.name, 40) +
      pad(String(r.tableId ?? '-'), 12) +
      pad(String(r.capacity ?? '-'), 8) +
      String(r.members ?? '-')
    );
  }
  console.log('');
  return { meta, tables: filtered };
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }

module.exports = { inspect };
