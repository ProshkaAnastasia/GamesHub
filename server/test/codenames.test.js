const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
const moduleGame = require('../games/codenames');
const { validPayload } = require('../security');
function setup() {
  const room = new Room('TEST');
  for (const id of ['a', 'a2', 'b', 'b2']) room.addPlayer(id, id);
  assert.ok(room.setGameType('a', 'codenames').ok);
  assert.ok(room.startGame().ok);
  return room;
}
const operative = game => game.teamOrder[game.activeTeam][1];
const captain = game => game.captains[game.activeTeam];
function clue(room, count = 2) { assert.ok(room.codenamesClue(captain(room.game), 'Абстракция', count).ok); }

test('Codenames creates a unique 25-card field and balanced teams with one captain each', () => {
  const room = setup(), game = room.game;
  assert.equal(new Set(game.board.map(c => c.word)).size, 25);
  assert.equal(game.remaining(game.startingTeam), 9);
  assert.equal(game.remaining(game.startingTeam === 'A' ? 'B' : 'A'), 8);
  assert.equal(game.board.filter(c => c.kind === 'neutral').length, 7);
  assert.equal(game.board.filter(c => c.kind === 'assassin').length, 1);
  assert.equal(room.teamOrder.A.length, 2);
  assert.equal(room.teamOrder.B.length, 2);
  assert.equal(moduleGame.canStart({}, new Map([...room.players].slice(0, 3))), true);
  assert.equal(moduleGame.canStart({}, new Map([...room.players].slice(0, 1))), false);
});

test('only captains see unrevealed identities; players and spectators receive null', () => {
  const room = setup(), game = room.game;
  const agent = operative(game);
  assert.ok(room.viewFor(captain(game)).codenames.board.every(c => c.kind));
  assert.ok(room.viewFor(agent).codenames.board.every(c => c.kind === null));
  room.joinInProgress('watch', 'Watcher');
  assert.ok(room.viewFor('watch').codenames.board.every(c => c.kind === null));
  assert.ok(room.codenamesClue(agent, 'Тест', 1).error);
  assert.ok(room.codenamesReveal('watch', 0).error);
  clue(room);
  assert.ok(room.codenamesReveal(captain(game), 0).error);
  assert.ok(room.codenamesReveal(game.teamOrder[game.activeTeam === 'A' ? 'B' : 'A'][1], 0).error);
});

test('clue validation rejects board words, spaces, bad counts and repeated clue submission', () => {
  const room = setup(), game = room.game, id = captain(game);
  assert.ok(room.codenamesClue(id, game.board[0].word, 1).error);
  assert.ok(room.codenamesClue(id, 'Два слова', 1).error);
  assert.ok(room.codenamesClue(id, 'Слово', -1).error);
  clue(room);
  assert.ok(room.codenamesClue(id, 'Слово', 2).error);
});

test('correct guesses allow number + 1; ending turn requires at least one guess', () => {
  const room = setup(), game = room.game, initial = game.activeTeam;
  clue(room, 1);
  assert.ok(room.codenamesEndTurn(operative(game)).error);
  const picks = game.board.map((c, i) => c.kind === initial ? i : -1).filter(i => i >= 0);
  const agent = operative(game);
  assert.ok(room.codenamesReveal(agent, picks[0]).ok);
  assert.equal(game.guessesLeft, 1);
  assert.ok(room.codenamesReveal(agent, picks[0]).error);
  assert.ok(room.codenamesReveal(agent, picks[1]).ok);
  assert.notEqual(game.activeTeam, initial);
  assert.equal(game.phase, 'clue');
  assert.equal(game.round, 2);
});

test('neutral or enemy card ends the turn; assassin loses immediately', () => {
  for (const kind of ['neutral', 'enemy', 'assassin']) {
    const room = setup(), game = room.game, initial = game.activeTeam;
    const target = kind === 'enemy' ? (initial === 'A' ? 'B' : 'A') : kind;
    clue(room);
    const index = game.board.findIndex(c => c.kind === target);
    assert.ok(room.codenamesReveal(operative(game), index).ok);
    assert.equal(game.board[index].revealed, true);
    if (kind === 'assassin') {
      assert.equal(room.status, 'finished');
      assert.notEqual(game.winner, initial);
      assert.ok(room.viewFor('a2').codenames.board.every(c => c.kind));
    } else {
      assert.equal(game.phase, 'clue');
      assert.notEqual(game.activeTeam, initial);
    }
  }
});

test('revealing the last enemy agent awards victory to the enemy', () => {
  const room = setup(), game = room.game;
  const enemy = game.activeTeam === 'A' ? 'B' : 'A';
  const cards = game.board.filter(c => c.kind === enemy);
  cards.slice(1).forEach(c => { c.revealed = true; });
  clue(room);
  room.codenamesReveal(operative(game), game.board.indexOf(cards[0]));
  assert.equal(room.status, 'finished');
  assert.equal(game.winner, enemy);
});

test('zero and infinity clues allow unlimited correct guesses and manual end of turn', () => {
  for (const count of [0, 'unlimited']) {
    const room = setup(), game = room.game;
    clue(room, count);
    assert.equal(game.guessesLeft, 25);
    room.codenamesReveal(operative(game), game.board.findIndex(c => c.kind === game.activeTeam));
    assert.equal(game.phase, 'guessing');
    assert.ok(room.codenamesEndTurn(operative(game)).ok);
    assert.equal(game.phase, 'clue');
  }
});

test('persistence preserves secrets, captain roles, turn and archive, replay gets a new board', () => {
  const room = setup();
  clue(room);
  room.codenamesReveal(operative(room.game), room.game.board.findIndex(c => c.kind === room.game.activeTeam));
  const restored = Room.fromData(JSON.parse(JSON.stringify(room)));
  assert.deepEqual(restored.game.board, room.game.board);
  assert.deepEqual(restored.game.captains, room.game.captains);
  assert.equal(restored.game.guessesLeft, 2);
  const agent = operative(restored.game);
  assert.equal(restored.viewFor(agent).codenames.board.filter(c => c.kind).length, 1);
  restored.forceEndGame();
  assert.ok(restored.playAgain().ok);
  assert.equal(restored.pastGames[0].codenames.board.length, 25);
  for (const player of restored.players.values()) player.connected = true;
  assert.ok(restored.startGame().ok);
  assert.equal(restored.game.phase, 'clue');
  assert.ok(restored.game.board.every(c => !room.game.board.some(old => old.word === c.word)));
});

test('security accepts Codenames actions and rejects malformed fields', () => {
  assert.equal(validPayload('find-game', { name: 'Test', gameType: 'codenames' }), true);
  assert.equal(validPayload('set-game-type', { gameType: 'codenames' }), true);
  assert.equal(validPayload('codenames-clue', { word: 'Слово', count: 'unlimited' }), true);
  assert.equal(validPayload('codenames-reveal', { index: 24 }), true);
  assert.equal(validPayload('codenames-reveal', { index: 25 }), false);
  assert.equal(validPayload('codenames-clue', { word: [], count: 1 }), false);
});
