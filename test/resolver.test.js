'use strict';

/**
 * Unit test for the player-id hardening resolver (no save file needed).
 * Proves resolveHostAggregateRow does the right thing when guest/host stat-row indices
 * align, diverge (roster reindex), diverge into a new signing, or hit a stale season row.
 *
 * Run: node test/resolver.test.js   (expects "RESOLVER TESTS PASSED")
 */

const { resolveHostAggregateRow } = require('../src/playerStatMap');

// Helpers to hand-build the map shape buildPlayerStatMap produces.
function mkMap(rows /* [{table,row,player,year}] */, meta /* {player:name} */) {
  const rowToPlayer = new Map();
  const playerToRow = new Map();
  const playerMeta = new Map();
  for (const r of rows) {
    rowToPlayer.set(`${r.table}#${r.row}`, { key: r.player, year: r.year });
    playerToRow.set(`${r.player}::${r.table}::${r.year}`, r.row);
  }
  for (const [k, name] of Object.entries(meta)) playerMeta.set(k, { name });
  return { rowToPlayer, playerToRow, playerMeta };
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
  else console.log(`  ok   ${label}`);
}
const T = 'SeasonOffensiveStats';

// Host: P1 current(yr1)=#50, P1 prior(yr0)=#200, P2 current(yr1)=#51.
const host = mkMap([
  { table: T, row: 50,  player: 'P1', year: 1 },
  { table: T, row: 200, player: 'P1', year: 0 },
  { table: T, row: 51,  player: 'P2', year: 1 },
], { P1: 'Player One', P2: 'Player Two' });

// Guest: P1 current sits at a DIFFERENT index (#99) — a roster reindex. P2 aligned (#51).
// PX is a divergent signing the host never made. P1 prior season also present at #200.
const guest = mkMap([
  { table: T, row: 99,  player: 'P1', year: 1 },
  { table: T, row: 200, player: 'P1', year: 0 },
  { table: T, row: 51,  player: 'P2', year: 1 },
  { table: T, row: 120, player: 'PX', year: 1 },
], { P1: 'Player One', P2: 'Player Two', PX: 'New Signing' });

function r(idx) { return resolveHostAggregateRow(guest, host, T, idx); }

// 1. Divergent index, same player+season -> remap to the correct host row (NOT the same index).
check('divergent index remaps to right player row',
  r(99), { status: 'remapped', hostRow: 50, playerKey: 'P1', playerName: 'Player One' });

// 2. Aligned index -> 'ok', same row (no-op).
check('aligned index is a no-op',
  r(51), { status: 'ok', hostRow: 51, playerKey: 'P2', playerName: 'Player Two' });

// 3. Divergent signing (player absent in host) -> skip, never mis-write.
check('divergent signing has no host row',
  r(120), { status: 'no-host-row', hostRow: null, playerKey: 'PX', playerName: 'New Signing' });

// 4. Multi-season: a prior-season row resolves to the prior-season host row, not the current one.
check('prior-season row maps to prior-season host row',
  r(200), { status: 'ok', hostRow: 200, playerKey: 'P1', playerName: 'Player One' });

// 5. Unlinked/orphan guest row -> positional fallback signalled.
check('orphan row falls back',
  r(777), { status: 'orphan', hostRow: null, playerKey: null, playerName: null });

if (failures) { console.log(`\n${failures} RESOLVER TEST(S) FAILED`); process.exit(1); }
console.log('\nRESOLVER TESTS PASSED');
