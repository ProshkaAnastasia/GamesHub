const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, RoomManager } = require('../game');
test('offline lobby timeout removes players and transfers host, reconnect resets timeout', () => {
  const room = new Room('TEST');
  room.addPlayer('a', 'A'); room.addPlayer('b', 'B');
  room.setConnected('a', false);
  const disconnected = room.players.get('a').disconnectedAt;
  assert.equal(room.expireOfflineLobbyPlayers(disconnected + 119999, 120000), false);
  room.setConnected('a', true);
  assert.equal(room.expireOfflineLobbyPlayers(disconnected + 120001, 120000), false);
  room.setConnected('a', false);
  assert.equal(room.expireOfflineLobbyPlayers(room.players.get('a').disconnectedAt + 120000, 120000), true);
  assert.equal(room.players.has('a'), false);
  assert.equal(room.hostId, 'b');
});
test('active and finished parties keep offline players; restart preserves offline age', () => {
  const room = new Room('TEST'); room.addPlayer('a', 'A'); room.setConnected('a', false);
  const timestamp = room.players.get('a').disconnectedAt;
  const restored = Room.fromData(JSON.parse(JSON.stringify(room)));
  assert.equal(restored.players.get('a').disconnectedAt, timestamp);
  for (const status of ['playing', 'finished']) {
    restored.status = status;
    assert.equal(restored.expireOfflineLobbyPlayers(timestamp + 999999, 120000), false);
    assert.equal(restored.players.has('a'), true);
  }
});

test('matchmaking fills the same occupied lobby, ignoring offline players and ineligible rooms', () => {
  const manager = Object.create(RoomManager.prototype);
  manager.rooms = new Map();
  function lobby(code, online, offline = 0, visibility = 'public', gameType = 'codenames') {
    const room = new Room(code, visibility); room.gameType = gameType;
    for (let i = 0; i < online + offline; i++) {
      room.addPlayer(String(i), 'Player');
      if (i >= online) room.setConnected(String(i), false);
    }
    manager.rooms.set(code, room); return room;
  }
  const empty = lobby('AAAA', 0, 7);
  const occupied = lobby('BBBB', 1, 1);
  lobby('CCCC', 8); lobby('DDDD', 7, 0, 'private');
  lobby('EEEE', 7).status = 'playing'; lobby('FFFF', 4, 0, 'public', 'decoder');
  for (let i = 0; i < 10; i++) assert.equal(manager.findPublicRoom('codenames'), occupied);
  occupied.addPlayer('new', 'New');
  assert.equal(manager.findPublicRoom('codenames'), occupied);
  occupied.status = 'playing';
  assert.equal(manager.findPublicRoom('codenames'), empty);
  const tie = lobby('GGGG', 0); tie.createdAt = empty.createdAt;
  assert.equal(manager.findPublicRoom('codenames'), empty);
});
