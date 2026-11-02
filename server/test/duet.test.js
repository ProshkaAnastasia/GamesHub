const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
function setup(n = 2) {
  const room = new Room('DUET');
  for (let i = 0; i < n; i++) room.addPlayer(`p${i}`, `Player ${i}`);
  room.setGameType('p0', 'codenames');
  assert.ok(room.startGame().ok);
  return room;
}
function clue(room, side = 'A') {
  room.game.activeTeam = side;
  assert.ok(room.codenamesClue(room.teamOrder[side][0], 'Абстракция', 1).ok);
}
const pickPair = (game, a, b) => game.keys.A.findIndex((kind, i) => kind === a && game.keys.B[i] === b);

test('two/three players automatically get Duet, four get classic, with exact key distribution', () => {
  for (const n of [2, 3, 4]) {
    const room = setup(n), game = room.game;
    if (n === 4) { assert.notEqual(game.mode, 'duet'); continue; }
    assert.equal(game.mode, 'duet');
    assert.equal(room.teamOrder.A.length, Math.ceil(n / 2));
    assert.equal(room.teamOrder.B.length, 1);
    assert.equal(game.tokensLeft, 9);
    for (const side of ['A', 'B']) {
      assert.equal(game.keys[side].filter(k => k === 'agent').length, 9);
      assert.equal(game.keys[side].filter(k => k === 'assassin').length, 3);
      assert.equal(game.keys[side].filter(k => k === 'neutral').length, 13);
    }
    assert.equal(game.keys.A.filter((k, i) => k === 'agent' && game.keys.B[i] === 'agent').length, 3);
    assert.equal(game.totalRemaining(), 15);
    assert.equal(new Set(game.board.map(c => c.word)).size, 25);
    for (const target of ['agent', 'assassin', 'neutral']) assert.equal(game.keys.A.filter((k, i) => k === 'assassin' && game.keys.B[i] === target).length, 1);
  }
});

test('each side receives only its own key; spectators see no secret map', () => {
  const room = setup(3), game = room.game;
  for (const side of ['A', 'B']) for (const id of room.teamOrder[side]) {
    const view = room.viewFor(id).codenames;
    assert.deepEqual(view.board.map(c => c.kind), game.keys[side]);
    assert.equal(view.keys, undefined);
    assert.ok(view.board.every(c => c.keys === undefined));
    assert.equal(view.remaining[side === 'A' ? 'B' : 'A'], null);
  }
  room.joinInProgress('watch', 'Watcher');
  assert.ok(room.viewFor('watch').codenames.board.every(c => c.kind === null));
  clue(room);
  assert.ok(room.codenamesReveal('watch', 0).error);
  assert.ok(room.codenamesReveal(room.teamOrder.A[0], 0).error);
});

test('guesses use partner key, so a personal assassin can be a correct guess', () => {
  const room = setup(), game = room.game;
  const index = pickPair(game, 'agent', 'assassin');
  clue(room);
  assert.ok(room.codenamesReveal(room.teamOrder.B[0], index).ok);
  assert.equal(game.board[index].found, true);
  assert.equal(game.finished, false);
  assert.equal(game.totalRemaining(), 14);
  for (const id of room.players.keys()) assert.equal(room.viewFor(id).codenames.board[index].kind, 'agent');
});

test('bystander is marked for the guesser only; other side can discover an agent there', () => {
  const room = setup(), game = room.game;
  const index = pickPair(game, 'neutral', 'agent');
  clue(room);
  assert.ok(room.codenamesReveal(room.teamOrder.B[0], index).ok);
  assert.deepEqual(game.board[index].bystanders, { A: false, B: true });
  assert.equal(game.board[index].revealed, false);
  assert.equal(game.tokensLeft, 8);
  assert.equal(game.activeTeam, 'B');
  assert.ok(room.codenamesClue(room.teamOrder.B[0], 'Понятие', 1).ok);
  assert.ok(room.codenamesReveal(room.teamOrder.A[0], index).ok);
  assert.equal(game.board[index].found, true);
  assert.equal(game.board[index].revealed, true);
});

test('bystander cannot be guessed twice in same direction; two marks cover a neutral', () => {
  const room = setup(), game = room.game;
  const index = pickPair(game, 'neutral', 'neutral');
  clue(room);
  room.codenamesReveal(room.teamOrder.B[0], index);
  assert.ok(room.viewFor(room.teamOrder.B[0]).codenames.board[index].blocked);
  clue(room);
  assert.ok(room.codenamesReveal(room.teamOrder.B[0], index).error);
  // Let the next side try it using the opposite key.
  game.phase = 'clue';
  clue(room, 'B');
  room.codenamesReveal(room.teamOrder.A[0], index);
  assert.equal(game.board[index].revealed, true);
  assert.equal(game.board[index].found, false);
  assert.equal(game.totalRemaining(), 15);
});

test('Duet guesses are unlimited by clue number; either member of a pair may act', () => {
  const room = setup(3), game = room.game;
  clue(room, 'B');
  const ids = room.teamOrder.A;
  assert.ok(room.codenamesEndTurn(ids[0]).error);
  const indices = game.keys.B.flatMap((k, i) => k === 'agent' ? [i] : []);
  for (let i = 0; i < 3; i++) assert.ok(room.codenamesReveal(ids[i % 2], indices[i]).ok);
  assert.equal(game.phase, 'guessing');
  assert.equal(game.tokensLeft, 9);
  assert.ok(room.codenamesEndTurn(ids[1]).ok);
  assert.equal(game.tokensLeft, 8);
});

test('partner assassin causes a shared loss and finish reveals both keys', () => {
  const room = setup(), game = room.game;
  clue(room);
  room.codenamesReveal(room.teamOrder.B[0], game.keys.A.indexOf('assassin'));
  assert.equal(room.status, 'finished');
  assert.equal(game.winner, 'coop-lose');
  assert.deepEqual(room.viewFor('p0').codenames.keys, game.keys);
  assert.ok(room.codenamesReveal(room.teamOrder.B[0], 0).error);
});

test('ninth completed turn enables sudden death: no clues, either side may guess, any error loses', () => {
  const room = setup(), game = room.game;
  game.tokensLeft = 1;
  clue(room);
  room.codenamesReveal(room.teamOrder.B[0], pickPair(game, 'neutral', 'neutral'));
  assert.equal(game.phase, 'sudden-death');
  assert.equal(game.tokensLeft, 0);
  assert.ok(room.codenamesClue(room.teamOrder.A[0], 'Тест', 1).error);
  assert.ok(room.viewFor(room.teamOrder.A[0]).codenames.canGuess);
  assert.ok(room.viewFor(room.teamOrder.B[0]).codenames.canGuess);
  assert.ok(room.codenamesEndTurn(room.teamOrder.B[0]).error);
  const another = game.keys.A.findIndex((kind, i) => kind === 'neutral' && !game.board[i].bystanders.B);
  room.codenamesReveal(room.teamOrder.B[0], another);
  assert.equal(game.winner, 'coop-lose');
});

test('finding all 15 agents wins jointly, including in sudden death', () => {
  for (const sudden of [false, true]) {
    const room = setup(), game = room.game;
    const last = pickPair(game, 'agent', 'agent');
    game.board.forEach((card, i) => {
      if (i !== last && (game.keys.A[i] === 'agent' || game.keys.B[i] === 'agent')) { card.found = true; card.revealed = true; }
    });
    clue(room);
    if (sudden) { game.tokensLeft = 0; game.phase = 'sudden-death'; }
    room.codenamesReveal(room.teamOrder.B[0], last);
    assert.equal(game.totalRemaining(), 0);
    assert.equal(game.winner, 'coop-win');
    assert.equal(room.status, 'finished');
  }
});

test('a side with no remaining clues is skipped', () => {
  const room = setup(), game = room.game;
  game.board.forEach((card, i) => { if (game.keys.A[i] === 'agent') { card.found = true; card.revealed = true; } });
  clue(room, 'B');
  room.codenamesReveal(room.teamOrder.A[0], game.keys.B.findIndex((k, i) => k === 'agent' && !game.board[i].found));
  room.codenamesEndTurn(room.teamOrder.A[0]);
  assert.equal(game.activeTeam, 'B');
});

test('save/rejoin retains two keys, directional marks and mode; replay reevaluates player count', () => {
  const room = setup(3), game = room.game;
  clue(room);
  room.codenamesReveal(room.teamOrder.B[0], pickPair(game, 'neutral', 'agent'));
  const restored = Room.fromData(JSON.parse(JSON.stringify(room)));
  assert.equal(restored.game.mode, 'duet');
  assert.deepEqual(restored.game.keys, game.keys);
  assert.deepEqual(restored.game.board, game.board);
  assert.equal(restored.game.tokensLeft, 8);
  for (const p of restored.players.values()) p.connected = true;
  restored.joinInProgress('fourth', 'Fourth');
  assert.equal(restored.game.mode, 'duet');
  assert.equal(restored.players.get('fourth').role, 'spectator');
  restored.forceEndGame(); restored.playAgain();
  assert.equal(restored.pastGames[0].codenames.mode, 'duet');
  assert.deepEqual(restored.pastGames[0].codenames.keys, game.keys);
  assert.ok(restored.startGame().ok);
  assert.notEqual(restored.game.mode, 'duet');
});
