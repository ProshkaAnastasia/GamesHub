const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Room, RoomManager } = require('../game');

function publicRoom(game = 'decoder', count = 3) {
  const room = new Room('TEST', 'public');
  room.gameType = game;
  for (let i = 0; i < count; i++) room.addPlayer(String(i), `Player ${i}`);
  return room;
}

test('public countdown starts at minimum, survives arrivals and cancels below minimum', () => {
  const room = publicRoom('decoder', 2);
  assert.equal(room.hostId, null);
  assert.equal(room.updateStartDeadline(1000, 15000), null);
  room.addPlayer('2', 'Player 2');
  assert.equal(room.updateStartDeadline(1000, 15000), 16000);
  room.addPlayer('3', 'Player 3');
  assert.equal(room.updateStartDeadline(2000, 15000), 16000);
  room.setConnected('2', false);
  room.setConnected('3', false);
  assert.equal(room.updateStartDeadline(3000, 15000), null);
  room.setConnected('2', true);
  assert.equal(room.updateStartDeadline(4000, 15000), 19000);
  assert.ok(room.startGame().ok);
  assert.equal(room.updateStartDeadline(19000, 15000), null);
  assert.ok(room.startGame().error);
});

test('matching uses waiting public rooms of the chosen game, never private/full/started', () => {
  const manager = Object.create(RoomManager.prototype);
  const privateRoom = new Room('PRIV');
  privateRoom.gameType = 'decoder';
  const full = publicRoom('decoder', 8);
  const started = publicRoom();
  started.status = 'playing';
  const ttr = publicRoom('ttr', 2);
  const waiting = publicRoom('decoder', 2);
  manager.rooms = new Map([['private', privateRoom], ['full', full], ['started', started], ['ttr', ttr], ['waiting', waiting]]);
  assert.equal(manager.findPublicRoom('decoder'), waiting);
  assert.equal(manager.findPublicRoom('ttr'), ttr);
  assert.equal(manager.findPublicRoom('unknown'), null);
  assert.equal(manager.listSummaries().some(r => r.code === 'PRIV'), false);
  manager.rooms.delete('waiting');
  assert.equal(manager.findPublicRoom('decoder'), null);
});

test('private invitation and room visibility persist; countdown resets on restart', () => {
  const room = new Room('PRIV');
  room.addPlayer('host', 'Host');
  assert.ok(room.setGameType('host', 'decoder').ok);
  const restored = Room.fromData(JSON.parse(JSON.stringify(room)));
  assert.equal(restored.visibility, 'private');
  assert.equal(restored.inviteToken, room.inviteToken);
  assert.equal(restored.hostId, 'host');
  const queue = publicRoom();
  queue.updateStartDeadline(1000, 15000);
  const restoredQueue = Room.fromData(JSON.parse(JSON.stringify(queue)));
  assert.equal(restoredQueue.visibility, 'public');
  assert.equal(restoredQueue.startDeadline, null);
  assert.equal(restoredQueue.canStart(), false);
});

test('leaving is allowed, ends an active party, and blocks further game actions', () => {
  const room = publicRoom();
  room.startGame();
  assert.equal(room.canPlayerLeaveSafely(room.game.sharedPlayerId).safe, true);
  room.removePlayer('0');
  assert.equal(room.status, 'finished');
  assert.match(room.game.winReason, /Player 0/);
  assert.ok(room.submitClues('1', ['a', 'b', 'c']).error);
});

test('Ticket to Ride counts and deals only connected participants', () => {
  const room = publicRoom('ttr', 3);
  room.setConnected('2', false);
  assert.ok(room.startGame().ok);
  assert.deepEqual(room.game.playerIds, ['0', '1']);
  assert.equal(room.players.get('2').role, 'spectator');
  room.removePlayer('2');
  assert.equal(room.status, 'playing');
});

test('offline participants may return without changing status or roles after restore', () => {
  const room = publicRoom();
  room.startGame();
  const snapshot = JSON.parse(JSON.stringify(room));
  const restored = Room.fromData(snapshot);
  assert.equal(restored.status, 'playing');
  assert.equal(restored.players.size, 3);
  restored.setConnected('0', true);
  assert.equal(restored.canForceEnd('0'), true);
  restored.setConnected('1', true);
  restored.setConnected('2', true);
  assert.equal(restored.canForceEnd('0'), false);
  assert.equal(restored.game.sharedPlayerId, room.game.sharedPlayerId);
});

test('private finish permissions respect host presence and reject spectators', () => {
  const room = new Room('PRIV');
  for (const id of ['host', 'a', 'b']) room.addPlayer(id, id);
  room.setGameType('host', 'decoder');
  room.startGame();
  room.players.set('watcher', { id: 'watcher', name: 'Watcher', role: 'spectator', connected: true });
  assert.equal(room.canForceEnd('host'), true);
  assert.equal(room.canForceEnd('a'), false);
  room.setConnected('b', false);
  assert.equal(room.canForceEnd('a'), false);
  room.setConnected('host', false);
  assert.equal(room.canForceEnd('a'), true);
  assert.equal(room.canForceEnd('watcher'), false);
  assert.equal(room.canManagePrivate('a'), true);
  room.setConnected('host', true);
  assert.equal(room.canManagePrivate('a'), false);
});
