const { test } = require('node:test');
const assert = require('node:assert/strict');
const decoder = require('../games/decoder');
const { Room } = require('../game');

function setup(shared = true) {
  const room = new Room('TEST');
  for (const id of shared ? ['a', 'b', 'shared'] : ['a', 'a2', 'b', 'b2']) room.addPlayer(id, id);
  room.setGameType('a', 'decoder');
  for (const [id, team] of shared ? [['a', 'A'], ['b', 'B'], ['shared', 'AB']] : [['a', 'A'], ['a2', 'A'], ['b', 'B'], ['b2', 'B']]) {
    room.players.get(id).team = team;
    (room.teamOrder[team] ||= []).push(id);
  }
  // Fixed roles isolate the rule tests from random lobby assignment.
  room.game = decoder.create(room.players, room.teamOrder, room.usedWords);
  room.status = 'playing';
  return room;
}

function clues(room) {
  const game = room.game;
  for (const t of ['A', 'B']) assert.ok(room.submitClues(game.getEncryptorId(t), ['один', 'два', 'три']).ok);
  assert.equal(game.phase, 'guessing');
}

function answer(room, id, kind, guess) {
  assert.ok(room.updateGuessDraft(id, kind, guess).ok);
  assert.ok(room.lockGuess(id, kind).ok);
}

function finishRound(room) {
  const game = room.game;
  const decodingTeam = game.getPlayerTeam('shared');
  for (const t of ['A', 'B']) {
    answer(room, t === decodingTeam ? 'shared' : t.toLowerCase(), 'own', game.teams[t].current.code);
  }
  // Deliberately miss interceptions so that round two can start.
  for (const t of ['A', 'B']) {
    const code = [...game.teams[t === 'A' ? 'B' : 'A'].current.code].reverse();
    answer(room, t.toLowerCase(), 'intercept', code);
  }
}

test('shared player alternates teams, sees both word sets, never receives the other code', () => {
  const room = setup();
  const game = room.game;
  assert.equal(game.getEncryptorId('A'), 'shared');
  assert.equal(game.getEncryptorId('B'), 'b');
  assert.equal(game.teams.A.words.length, 4);
  assert.equal(game.teams.B.words.length, 4);
  assert.equal(new Set([...game.teams.A.words, ...game.teams.B.words]).size, 8);
  let tv = room.viewFor('shared').teamView;
  assert.equal(tv.myTeamKey, 'A');
  assert.deepEqual(tv.myCode, game.teams.A.current.code);
  assert.deepEqual(tv.myWords, game.teams.A.words);
  assert.equal(tv.sharedWords, undefined);
  assert.equal(tv.oppWords, null);
  assert.equal(room.viewFor('a').teamView.myCode, null);
  assert.equal(room.viewFor('a').teamView.sharedWords, undefined);
  assert.equal(room.viewFor('a').teamView.oppWords, null);
  assert.ok(room.submitClues('a', ['1', '2', '3']).error);
  clues(room);
  tv = room.viewFor('shared').teamView;
  assert.equal(tv.myTeamKey, 'B');
  assert.deepEqual(tv.myWords, game.teams.B.words);
  assert.equal(tv.sharedWords, undefined);
  assert.equal(tv.oppWords, null);
  assert.equal(tv.myCode, null);
  assert.equal(tv.isEncryptor, false);
  assert.ok(room.updateGuessDraft('shared', 'intercept', [1, 2, 3]).error);
  assert.ok(room.lockGuess('shared', 'intercept').error);
  assert.ok(room.updateGuessDraft('b', 'own', [1, 2, 3]).error);
  finishRound(room);
  assert.equal(game.phase, 'reveal');
  assert.equal(game.teams.A.miscommunications, 0);
  assert.equal(game.teams.B.miscommunications, 0);
  assert.ok(room.nextRound().ok);
  assert.equal(game.getEncryptorId('A'), 'a');
  assert.equal(game.getEncryptorId('B'), 'shared');
  assert.equal(room.viewFor('shared').teamView.myTeamKey, 'B');
  assert.deepEqual(room.viewFor('shared').teamView.myWords, game.teams.B.words);
  clues(room);
  assert.equal(room.viewFor('shared').teamView.myTeamKey, 'A');
  assert.deepEqual(room.viewFor('shared').teamView.myWords, game.teams.A.words);
  finishRound(room);
  assert.equal(game.round, 2);
  assert.equal(game.phase, 'reveal');
});

test('shared role and alternating roles survive serialization and play again', () => {
  const room = setup();
  clues(room);
  finishRound(room);
  room.nextRound();
  const restored = Room.fromData(JSON.parse(JSON.stringify(room)));
  assert.equal(restored.game.sharedPlayerId, 'shared');
  assert.equal(restored.game.getEncryptorId('B'), 'shared');
  assert.equal(restored.viewFor('shared').teamView.myTeamKey, 'B');
  assert.equal(restored.game.teamBlockedInfo('B').blocked, true);
  for (const id of ['a', 'b', 'shared']) restored.setConnected(id, true);
  assert.equal(restored.game.teamBlockedInfo('B').blocked, false);
  assert.equal(restored.canPlayerLeaveSafely('shared').safe, true);
  restored.forceEndGame();
  assert.ok(restored.playAgain().ok);
  assert.equal(restored.pastGames[0].sharedPlayerId, 'shared');
  assert.ok(restored.startGame().ok);
  assert.equal(restored.game.getEncryptorId('A'), restored.game.sharedPlayerId);
});

test('only regular players submit tiebreak; shared player cannot affect it', () => {
  const room = setup();
  room.game.startTiebreak(true);
  assert.ok(room.updateTiebreakGuess('shared', room.game.teams.B.words).error);
  assert.ok(room.lockTiebreakGuess('shared').error);
  assert.ok(room.updateTiebreakGuess('a', room.game.teams.B.words).ok);
  assert.ok(room.lockTiebreakGuess('a').ok);
  assert.ok(room.updateTiebreakGuess('b', room.game.teams.A.words).ok);
  assert.ok(room.lockTiebreakGuess('b').ok);
  assert.equal(room.status, 'finished');
  assert.equal(room.game.winner, 'draw');
});

test('normal four-player round and server digit validation still work', () => {
  const room = setup(false);
  assert.equal(room.game.sharedPlayerId, null);
  clues(room);
  assert.ok(room.updateGuessDraft('a2', 'own', [0, 5, 9]).ok);
  assert.ok(room.lockGuess('a2', 'own').error);
  answer(room, 'a2', 'own', room.game.teams.A.current.code);
  answer(room, 'b2', 'own', room.game.teams.B.current.code);
  answer(room, 'a', 'intercept', room.game.teams.B.current.code);
  answer(room, 'b', 'intercept', room.game.teams.A.current.code);
  assert.equal(room.game.phase, 'reveal');
  assert.equal(room.game.teams.A.interceptions, 1);
  assert.equal(room.game.teams.B.interceptions, 1);
});

test('shared game uses normal victory conditions after two interceptions', () => {
  const room = setup();
  for (let round = 1; round <= 2; round++) {
    clues(room);
    const game = room.game;
    const decodingTeam = game.getPlayerTeam('shared');
    for (const t of ['A', 'B']) answer(room, t === decodingTeam ? 'shared' : t.toLowerCase(), 'own', game.teams[t].current.code);
    answer(room, 'a', 'intercept', game.teams.B.current.code);
    answer(room, 'b', 'intercept', [...game.teams.A.current.code].reverse());
    if (round === 1) assert.ok(room.nextRound().ok);
  }
  assert.equal(room.status, 'finished');
  assert.equal(room.game.winner, 'A');
  assert.equal(room.game.teams.B.interceptions, 2);
});

test('lobby starts from online count and assigns balanced teams for 3–8 players', () => {
  for (let count = 2; count <= 9; count++) {
    const room = new Room('TEST');
    for (let i = 0; i < count; i++) room.addPlayer(String(i), String(i));
    room.setGameType('0', 'decoder');
    assert.equal(room.canStart(), count >= 3 && count <= 8);
    const result = room.startGame();
    if (count < 3 || count > 8) { assert.ok(result.error); continue; }
    assert.ok(result.ok);
    const { A, B, AB = [] } = room.teamOrder;
    assert.equal(new Set([...A, ...B, ...AB]).size, count);
    assert.equal(A.length, count === 3 ? 1 : Math.ceil(count / 2));
    assert.equal(B.length, count === 3 ? 1 : Math.floor(count / 2));
    assert.equal(AB.length, count === 3 ? 1 : 0);
    for (const p of room.players.values()) assert.ok(room.teamOrder[p.team].includes(p.id));
  }
});

test('offline players are excluded; every new game assigns teams afresh', () => {
  const room = new Room('TEST');
  for (let i = 0; i < 5; i++) room.addPlayer(String(i), String(i));
  room.setGameType('0', 'decoder');
  room.setConnected('4', false);
  assert.ok(room.startGame().ok);
  assert.equal(room.players.get('4').team, null);
  assert.equal(room.players.get('4').role, 'spectator');
  const previousOrder = room.teamOrder;
  room.forceEndGame();
  room.playAgain();
  assert.deepEqual(room.teamOrder, {});
  assert.ok([...room.players.values()].every(p => p.team === null));
  room.setConnected('4', true);
  assert.ok(room.startGame().ok);
  assert.notEqual(room.teamOrder, previousOrder);
  assert.equal(room.teamOrder.A.length + room.teamOrder.B.length, 5);
  assert.equal(room.players.get('4').role, 'player');
});

test('manual team selection is rejected and two online players cannot start', () => {
  const room = new Room('TEST');
  for (const id of ['a', 'b', 'c']) room.addPlayer(id, id);
  room.setGameType('a', 'decoder');
  assert.ok(room.setTeam('a', 'AB').error);
  room.setConnected('c', false);
  assert.equal(room.canStart(), false);
  assert.ok(room.startGame().error);
});
