'use strict';

/**
 * Thin wrapper over the `madden-franchise` library so the rest of the tool
 * never touches the library directly. When the format lineage carries to
 * CFB 27, only this file (plus the title config) should need attention.
 */

const path = require('path');
const maddenFranchise = require('madden-franchise');
const { create } = maddenFranchise;

/**
 * Open a franchise/FTC save and return the parsed FranchiseFile.
 * @param {string} filePath absolute or relative path to the save
 * @param {object} schemaCfg { schemaDirectory, schemaOverride } from a title config
 */
async function openFranchise(filePath, schemaCfg = {}, opts = {}) {
  const settings = {
    autoParse: true,
    // autoUnempty lets a write to an EMPTY record un-empty it and maintain the empty linked-list
    // (needed to allocate new stat rows). Only affects previously-empty records — normal writes to
    // existing records are unaffected — so it's safe to enable for the host write path.
    autoUnempty: opts.autoUnempty === true,
    saveOnChange: false,
  };
  if (schemaCfg.schemaDirectory) {
    settings.schemaDirectory = path.resolve(schemaCfg.schemaDirectory);
  }
  if (schemaCfg.schemaOverride) {
    // schemaOverride expects an object describing the schema file to force.
    settings.schemaOverride = schemaCfg.schemaOverride;
  }

  const franchise = await create(filePath, settings);
  return franchise;
}

/**
 * Lightweight metadata about an opened file.
 */
function fileMeta(franchise, filePath) {
  return {
    source: path.basename(filePath),
    gameYear: safe(() => franchise.gameYear),
    type: safe(() => franchise.type),
    schemaVersion: safe(() => franchise.schema && franchise.schema.meta && franchise.schema.meta.dataVersion),
    tableCount: safe(() => franchise.tables && franchise.tables.length),
  };
}

function safe(fn, fallback = null) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch { return fallback; }
}

module.exports = { openFranchise, fileMeta, safe };
