'use strict';

/**
 * Self-test for the diff engine using synthetic snapshots. No save file needed.
 * Simulates: shared baseline at start of Week 1  vs  User B's save after they
 * played their Week 1 game (Miami beat FSU 31-17) and signed a recruit.
 */

const assert = require('assert');
const { diffSnapshots } = require('./src/diff');

function snap(source, tables) {
  return { meta: { source }, tables };
}

const baseline = snap('baseline_week1.json', {
  SeasonGame: {
    keyFields: ['SeasonWeek', 'HomeTeam', 'AwayTeam'],
    rows: [
      { __key: 'SeasonWeek=1|HomeTeam=MIA|AwayTeam=FSU', __index: 0, SeasonWeek: 1, HomeTeam: 'MIA', AwayTeam: 'FSU', HomeScore: 0, AwayScore: 0, GamePlayed: false },
      { __key: 'SeasonWeek=1|HomeTeam=ALA|AwayTeam=UGA', __index: 1, SeasonWeek: 1, HomeTeam: 'ALA', AwayTeam: 'UGA', HomeScore: 0, AwayScore: 0, GamePlayed: false },
    ],
  },
  Player: {
    keyFields: ['PLYR_ASSETNAME'],
    rows: [
      { __key: 'PLYR_ASSETNAME=qb_smith', __index: 0, PLYR_ASSETNAME: 'qb_smith', TeamIndex: 12, Overall: 88 },
    ],
  },
});

const userB = snap('userB_after_week1.json', {
  SeasonGame: {
    keyFields: ['SeasonWeek', 'HomeTeam', 'AwayTeam'],
    rows: [
      // User B played MIA vs FSU -> score + played flag now set
      { __key: 'SeasonWeek=1|HomeTeam=MIA|AwayTeam=FSU', __index: 0, SeasonWeek: 1, HomeTeam: 'MIA', AwayTeam: 'FSU', HomeScore: 31, AwayScore: 17, GamePlayed: true },
      // The ALA/UGA game is User A's; untouched in B's copy
      { __key: 'SeasonWeek=1|HomeTeam=ALA|AwayTeam=UGA', __index: 1, SeasonWeek: 1, HomeTeam: 'ALA', AwayTeam: 'UGA', HomeScore: 0, AwayScore: 0, GamePlayed: false },
    ],
  },
  Player: {
    keyFields: ['PLYR_ASSETNAME'],
    rows: [
      { __key: 'PLYR_ASSETNAME=qb_smith', __index: 0, PLYR_ASSETNAME: 'qb_smith', TeamIndex: 12, Overall: 88 },
      // New signed recruit appears in B's roster
      { __key: 'PLYR_ASSETNAME=wr_jones', __index: 1, PLYR_ASSETNAME: 'wr_jones', TeamIndex: 12, Overall: 79 },
    ],
  },
});

const report = diffSnapshots(baseline, userB);

// Assertions
const sg = report.tables.SeasonGame;
assert.strictEqual(sg.modified.length, 1, 'exactly one game changed');
assert.strictEqual(sg.modified[0].key, 'SeasonWeek=1|HomeTeam=MIA|AwayTeam=FSU');
const changedFields = sg.modified[0].changes.map(c => c.field).sort();
assert.deepStrictEqual(changedFields, ['AwayScore', 'GamePlayed', 'HomeScore'], 'score + played flag flagged');

const pl = report.tables.Player;
assert.strictEqual(pl.added.length, 1, 'one new recruit detected');
assert.strictEqual(pl.added[0].row.PLYR_ASSETNAME, 'wr_jones');

assert.strictEqual(report.summary.added, 1);
assert.strictEqual(report.summary.modified, 1);
assert.strictEqual(report.summary.removed, 0);

console.log('SELFTEST PASSED');
console.log('  SeasonGame modified:', JSON.stringify(sg.modified[0].changes));
console.log('  Player added:', pl.added[0].row.PLYR_ASSETNAME);
console.log('  Summary:', JSON.stringify(report.summary));

// Player-id hardening resolver (no save file needed) runs as part of the self-test.
require('./test/resolver.test');
