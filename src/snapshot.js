'use strict';

/**
 * SNAPSHOT: read the merge-relevant tables (from the title config) into a
 * normalized, diff-friendly JSON file. A snapshot is a pure data structure
 * with no library objects, so two snapshots can be compared offline.
 *
 * Snapshot shape:
 * {
 *   meta: { source, gameYear, schemaVersion, generatedAt, title },
 *   tables: {
 *     <TableName>: {
 *       keyFields: string[],
 *       fields: string[],          // union of field keys seen
 *       rows: [ { __key, __index, ...fieldValues } ]
 *     }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { openFranchise, fileMeta, safe } = require('./openFranchise');

async function snapshot(filePath, config, outPath, { limitPerTable = null } = {}) {
  const schemaCfg = (config.schema) || {};
  const franchise = await openFranchise(filePath, schemaCfg);

  const meta = {
    ...fileMeta(franchise, filePath),
    title: config.title,
    generatedAt: new Date().toISOString(),
  };

  const defs = (config.tables && config.tables.definitions) || [];
  const out = { meta, tables: {} };
  const warnings = [];

  for (const def of defs) {
    const tbl = franchise.getTableByName(def.name);
    if (!tbl) {
      warnings.push(`Table "${def.name}" not found in file (name may differ — run inspect).`);
      continue;
    }

    try {
      await tbl.readRecords();
    } catch (err) {
      warnings.push(`Failed reading "${def.name}": ${err.message}`);
      continue;
    }

    const records = tbl.records || [];
    const fieldSet = new Set();
    const rows = [];
    let keyMissingWarned = false;

    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec || rec.isEmpty) continue;

      const values = {};
      const fieldKeys = safeKeys(rec);
      for (const k of fieldKeys) {
        fieldSet.add(k);
        values[k] = readField(rec, k);
      }

      // Build a stable cross-file identity key from configured keyFields.
      let key;
      if (def.keyFields && def.keyFields.length) {
        const present = def.keyFields.every(k => k in values);
        if (present) {
          key = def.keyFields.map(k => `${k}=${values[k]}`).join('|');
        } else {
          if (!keyMissingWarned) {
            warnings.push(`"${def.name}": one or more keyFields ${JSON.stringify(def.keyFields)} not present; using positional identity.`);
            keyMissingWarned = true;
          }
          key = `#${i}`;
        }
      } else {
        key = `#${i}`;
      }

      rows.push({ __key: key, __index: i, ...values });
      if (limitPerTable && rows.length >= limitPerTable) break;
    }

    out.tables[def.name] = {
      keyFields: def.keyFields || [],
      fields: [...fieldSet],
      rowCount: rows.length,
      rows,
    };
  }

  if (warnings.length) out.meta.warnings = warnings;

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
  return out;
}

function safeKeys(rec) {
  try { return Object.keys(rec.fields || {}); } catch { return []; }
}

function readField(rec, key) {
  try {
    const f = rec.fields[key];
    // Prefer formatted value; fall back to raw.
    if (f && 'value' in f) return f.value;
    return rec[key];
  } catch {
    return null;
  }
}

module.exports = { snapshot };
