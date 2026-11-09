const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the browser's notification decision without requiring an audio device.
function client() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
  const start = source.indexOf('  function updateTeamTurnSound(view)');
  const end = source.indexOf('  function updateCcTurnSound(view)', start);
  let sounds = 0;
  const context = { state: { teamLastTurnKey: null }, enabled: true,
    getTeamSoundEnabled: () => context.enabled, playTurnSound: () => sounds++ };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { update: view => context.updateTeamTurnSound(view), count: () => sounds,
    mute: () => { context.enabled = false; } };
}
const base = () => ({ code: 'TEST', status: 'playing', round: 1, pastGames: [],
  me: { team: 'A', role: 'player' } });

test('Codenames alerts the active team at clue and guessing phases, once per phase', () => {
  for (const isCaptain of [true, false]) {
    const c = client();
    const v = { ...base(), gameType: 'codenames', phase: 'clue', codenames: { activeTeam: 'B', isCaptain } };
    c.update(v); assert.equal(c.count(), 0);
    v.codenames.activeTeam = 'A'; c.update(v); assert.equal(c.count(), 1);
    c.update(v); assert.equal(c.count(), 1);
    v.phase = 'guessing'; c.update(v); assert.equal(c.count(), 2);
    v.codenames.guessesLeft = 1; c.update(v); assert.equal(c.count(), 2);
    v.round++; v.codenames.activeTeam = 'B'; c.update(v); assert.equal(c.count(), 2);
    v.me.role = 'spectator'; v.codenames.activeTeam = 'A'; c.update(v); assert.equal(c.count(), 2);
  }
});

test('Duet alerts the clue side, then its guessing partner, including last chance', () => {
  const a = client(), b = client();
  const v = { ...base(), gameType: 'codenames', phase: 'clue', codenames: { mode: 'duet', activeTeam: 'A' } };
  const update = () => { a.update({ ...v, codenames: { ...v.codenames, ownSide: 'A' } }); b.update({ ...v, codenames: { ...v.codenames, ownSide: 'B' } }); };
  update(); assert.equal(a.count(), 1); assert.equal(b.count(), 0);
  v.phase = 'guessing'; update(); assert.equal(a.count(), 1); assert.equal(b.count(), 1);
  update(); assert.equal(b.count(), 1);
  v.phase = 'sudden-death'; v.codenames.canGuess = true; update();
  assert.equal(a.count(), 2); assert.equal(b.count(), 2);
});

test('Decoder alerts both teams at phase changes, including shared players, and respects mute and finish', () => {
  const c = client();
  const v = { ...base(), gameType: 'decoder', phase: 'clue-giving', teamView: { myTeamKey: 'A', mySubmittedClues: false, isSharedPlayer: true } };
  c.update(v); assert.equal(c.count(), 1);
  v.teamView.mySubmittedClues = true; c.update(v); assert.equal(c.count(), 1);
  v.phase = 'guessing'; c.update(v); assert.equal(c.count(), 2);
  v.teamView.ownGuess = [1, 2, 3]; c.update(v); assert.equal(c.count(), 2);
  v.phase = 'reveal'; c.update(v); assert.equal(c.count(), 2);
  v.phase = 'tiebreak'; c.update(v); assert.equal(c.count(), 2);
  v.teamView.isSharedPlayer = false; v.round++; c.update(v); assert.equal(c.count(), 3);
  c.mute(); v.round++; c.update(v); assert.equal(c.count(), 3);
  v.status = 'finished'; c.update(v); assert.equal(c.count(), 3);
});
