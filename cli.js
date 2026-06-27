#!/usr/bin/env node
'use strict';

/**
 * Madden NFL 26 Offline Franchise Merge — command-line interface.
 * Built on the madden-franchise library.
 *
 * Commands:
 *   inspect  <save> [--game madden26] [--filter <substr>] [--json]
 *   snapshot <save> --out <file.json> [--game madden26] [--limit N]
 *   diff     <baseline.json> <modified.json> [--out <report.json>]
 *   selftest
 */

const fs = require('fs');
const path = require('path');

function loadConfig(game) {
  const p = path.join(__dirname, 'config', `${game}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`No config for game "${game}" at ${p}. Available: ${listConfigs().join(', ')}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listConfigs() {
  return fs.readdirSync(path.join(__dirname, 'config'))
    .filter(f => f.endsWith('.json') && !f.includes('template'))
    .map(f => f.replace('.json', ''));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  try {
    switch (cmd) {
      case 'inspect': {
        const { inspect } = require('./src/inspect');
        const save = args._[0];
        if (!save) return usageExit('inspect <save> [--game madden26] [--filter x] [--json]');
        const cfg = loadConfig(args.game || 'madden26');
        const res = await inspect(save, cfg.schema || {}, { filter: args.filter || null, json: !!args.json });
        if (args.json) console.log(JSON.stringify(res, null, 2));
        break;
      }
      case 'snapshot': {
        const { snapshot } = require('./src/snapshot');
        const save = args._[0];
        if (!save || !args.out) return usageExit('snapshot <save> --out <file.json> [--game madden26] [--limit N]');
        const cfg = loadConfig(args.game || 'madden26');
        const res = await snapshot(save, cfg, args.out, { limitPerTable: args.limit ? Number(args.limit) : null });
        console.log(`Wrote ${args.out}`);
        if (res.meta.warnings) res.meta.warnings.forEach(w => console.log('  ! ' + w));
        for (const [n, t] of Object.entries(res.tables)) console.log(`  ${n}: ${t.rowCount} rows, ${t.fields.length} fields`);
        break;
      }
      case 'diff': {
        const { diffSnapshots, printSummary } = require('./src/diff');
        const [aPath, bPath] = args._;
        if (!aPath || !bPath) return usageExit('diff <baseline.json> <modified.json> [--out report.json]');
        const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
        const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
        const report = diffSnapshots(a, b);
        printSummary(report);
        if (args.out) { fs.writeFileSync(args.out, JSON.stringify(report, null, 2)); console.log(`Wrote ${args.out}`); }
        break;
      }
      case 'merge': {
        const { applyMerge } = require('./src/applyMerge');
        const [baseline, host, guest] = args._;
        if (!baseline || !host || !guest || !args.out) {
          return usageExit('merge <baseline> <host> <guest> --out <merged.save> [--game madden26]');
        }
        const cfg = loadConfig(args.game || 'madden26');
        const res = await applyMerge({ baseline, host, guest, out: args.out, config: cfg });
        console.log(`\nMerged -> ${args.out}`);
        console.log('(inputs unchanged — only the output file was written)');
        console.log('Applied:');
        for (const [t, v] of Object.entries(res.applied)) console.log(`  ${t}: ${v.rows} rows, ${v.fields} fields`);
        if (res.remaps && res.remaps.length) {
          console.log(`Player-id remaps (identity prevented a misaligned write): ${res.remaps.length}`);
          res.remaps.slice(0, 15).forEach(r => console.log(`  ~ ${r.table}: ${r.player} guest#${r.from} -> host#${r.to}`));
        }
        if (res.allocated && res.allocated.length) {
          console.log(`New rows allocated (debut players): ${res.allocated.length}`);
          res.allocated.slice(0, 15).forEach(a => console.log(`  + ${a.table}#${a.idx} for ${a.player} (holder ${a.slot})`));
        }
        if (res.boxScore) console.log(`Box-score per-game rows transplanted: ${res.boxScore}`);
        if (res.teamBox) console.log(`Team box-score rows transplanted: ${res.teamBox}`);
        if (Object.keys(res.skipped).length) {
          console.log('Skipped (per policy):');
          for (const [t, n] of Object.entries(res.skipped)) console.log(`  ${t}: ${n} rows`);
        }
        console.log(`Verify: ${res.verify.ok}/${res.verify.checked} transplanted values confirmed ${res.verify.pass ? 'PASS' : 'FAIL'}`);
        res.verify.mismatches.forEach(m => console.log(`  ! ${m}`));
        if (res.warnings.length) { console.log('Warnings:'); res.warnings.slice(0, 30).forEach(w => console.log(`  ! ${w}`)); }
        break;
      }
      case 'selftest': {
        require('./selftest');
        break;
      }
      default:
        usageExit(null);
    }
  } catch (err) {
    console.error('\nError:', err.message);
    process.exit(1);
  }
}

function usageExit(line) {
  if (line) console.error('Usage: node cli.js ' + line);
  else console.error(`Madden Franchise Merge — commands:
  inspect  <save> [--game madden26] [--filter <substr>] [--json]
  snapshot <save> --out <file.json> [--game madden26] [--limit N]
  diff     <baseline.json> <modified.json> [--out <report.json>]
  merge    <baseline> <host> <guest> --out <merged.save> [--game madden26]
  selftest`);
  process.exit(line ? 1 : 0);
}

main();
