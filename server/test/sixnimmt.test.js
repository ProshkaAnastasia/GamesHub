const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
const moduleGame = require('../games/sixnimmt');
const { validPayload } = require('../security');
function room(count = 3) {
  const r = new Room('COWS');
  for (let i = 0; i < count; i++) r.addPlayer(`p${i}`, `Player ${i}`);
  assert.ok(r.setGameType('p0', 'sixnimmt').ok);
  assert.ok(r.startGame().ok);
  return r;
}
function fixed() {
  const r = room(2), g = r.game;
  g.rows = [[10], [30], [50], [70]];
  g.hands = { p0: [20, 21], p1: [40, 41] };
  return r;
}
test('104 unique cards, ten-card hands for 2–10, penalties and private views', () => {
  assert.deepEqual([1,5,10,11,55,100].map(moduleGame.heads), [1,2,3,5,7,3]);
  for (const count of [2, 10]) {
    const r = room(count), g = r.game;
    const cards = [...Object.values(g.hands).flat(), ...g.rows.flat()];
    assert.equal(new Set(cards).size, count * 10 + 4);
    assert.ok(cards.every(n => n >= 1 && n <= 104));
    assert.equal(g.hands.p0.length, 10);
    assert.ok(r.sixnimmtSelect('p0', g.hands.p0[0]).ok);
    assert.equal(r.viewFor('p1').sixnimmt.selectedCard, null);
    assert.deepEqual(r.viewFor('p1').sixnimmt.revealed, []);
    assert.equal(r.viewFor('p1').sixnimmt.hands, undefined);
    r.joinInProgress('watch', 'Watcher');
    assert.deepEqual(r.viewFor('watch').sixnimmt.hand, []);
    assert.ok(r.sixnimmtSelect('watch', 1).error);
    assert.ok(r.sixnimmtNext('watch').error);
  }
});
test('simultaneous reveal sorts cards and selects the nearest smaller row', () => {
  const r = fixed(), g = r.game;
  assert.ok(r.sixnimmtSelect('p1', 40).ok);
  assert.deepEqual(g.rows, [[10],[30],[50],[70]]);
  assert.ok(r.sixnimmtSelect('p1', 41).error);
  assert.ok(r.sixnimmtSelect('p0', 104).error);
  assert.ok(r.sixnimmtSelect('p0', 20).ok);
  assert.deepEqual(g.revealed.map(m => m.card), [20,40]);
  assert.deepEqual(g.rows, [[10,20],[30,40],[50],[70]]);
  assert.equal(g.phase, 'review');
  assert.ok(r.sixnimmtNext('p0').ok);
  assert.equal(g.phase, 'review');
  assert.ok(r.sixnimmtNext('p1').ok);
  assert.equal(g.phase, 'choosing');
  assert.equal(g.turn, 2);
});
test('sixth card takes five cards; low cards pause and continue in sorted order after row choice', () => {
  const r = fixed(), g = r.game;
  g.rows[0] = [5,10,11,12,15];
  r.sixnimmtSelect('p0', 20); r.sixnimmtSelect('p1', 40);
  assert.deepEqual(g.rows[0], [20]);
  assert.equal(g.scores.p0, 13);
  const low = fixed(), h = low.game;
  h.hands = { p0: [2,3], p1: [9,8] };
  low.sixnimmtSelect('p1', 9); low.sixnimmtSelect('p0', 2);
  assert.equal(h.phase, 'choosing-row');
  assert.equal(h.pendingPlayerId, 'p0');
  assert.ok(low.sixnimmtRow('p1', 0).error);
  assert.ok(low.sixnimmtRow('p0', 4).error);
  assert.ok(low.sixnimmtRow('p0', 2).ok);
  assert.equal(h.scores.p0, 3);
  assert.deepEqual(h.rows[2], [2,9]);
  assert.equal(h.phase, 'review');
});
test('pending row survives save/restore; complete game, round-end threshold, archive and replay', () => {
  let r = room(4);
  for (let step = 0; !r.game.finished && step < 2000; step++) {
    const g = r.game;
    if (g.phase === 'choosing') for (const id of g.playerIds) assert.ok(r.sixnimmtSelect(id, g.hands[id][0]).ok);
    else if (g.phase === 'choosing-row') {
      const before = JSON.stringify(r);
      r = Room.fromData(JSON.parse(before));
      // Restore marks players offline until their authenticated connection returns.
      for (const id of r.game.playerIds) r.setConnected(id, true);
      assert.ok(r.sixnimmtRow(r.game.pendingPlayerId, 0).ok);
    } else if (g.phase === 'review') for (const id of g.playerIds) assert.ok(r.sixnimmtNext(id).ok);
  }
  assert.equal(r.status, 'finished');
  assert.equal(r.game.turn, 10);
  assert.ok(Math.max(...Object.values(r.game.scores)) >= 66);
  assert.ok(r.game.rows.every(row => row.length >= 1 && row.length <= 5));
  assert.ok(r.sixnimmtNext('p0').error);
  assert.ok(r.playAgain().ok);
  assert.equal(r.pastGames[0].sixnimmt.history.length % 10, 0);
  assert.ok(r.startGame().ok);
  assert.equal(r.game.handNumber, 1);
  assert.equal(r.game.scores.p0, 0);
});
test('security validates card and row numbers and registers matchmaking', () => {
  for (const card of [0, 105, '2', 1.5, null]) assert.equal(validPayload('sixnimmt-select', {card}), false);
  for (const row of [-1, 4, '0', null]) assert.equal(validPayload('sixnimmt-row', {row}), false);
  assert.equal(validPayload('sixnimmt-select', {card:104}), true);
  assert.equal(validPayload('sixnimmt-row', {row:3}), true);
  assert.equal(validPayload('sixnimmt-next', {}), true);
  assert.equal(validPayload('find-game', {name:'Cow',gameType:'sixnimmt'}), true);
});

test('66 points only end the match after all ten cards; equal lowest scores share victory', () => {
  const r = fixed(), g = r.game;
  g.scores.p0 = 66;
  r.sixnimmtSelect('p0', 20); r.sixnimmtSelect('p1', 40);
  assert.equal(g.finished, false);
  r.sixnimmtNext('p0'); r.sixnimmtNext('p1');
  g.scores.p1 = 66;
  r.sixnimmtSelect('p0', 21); r.sixnimmtSelect('p1', 41);
  assert.equal(r.status, 'finished');
  assert.equal(g.winner, 'draw');
  assert.match(g.winReason, /Разделённая победа/);
});
