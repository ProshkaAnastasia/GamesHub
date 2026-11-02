const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const origin = 'http://localhost:3000';
const request = (socket, event, payload = {}) => socket.timeout(3000).emitWithAck(event, payload);
function update(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('room-update', handler); reject(new Error('room update timeout')); }, 3000);
    function handler(view) {
      if (predicate(view)) { clearTimeout(timer); socket.off('room-update', handler); resolve(view); }
    }
    socket.on('room-update', handler);
  });
}

test('real connections enforce identity, invites, origin, validation and multiple tabs', { timeout: 20000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshub-security-'));
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ALLOWED_ORIGINS: origin, EVENTS_PER_MINUTE: '100', PUBLIC_ROOM_LIST: 'false', MATCH_START_DELAY_MS: '350', DISCONNECT_GRACE_MS: '250' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    sockets.forEach(s => s.disconnect());
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let logs = '';
    child.stdout.on('data', chunk => { logs += chunk; const match = logs.match(/порту (\d+)/); if (match) resolve(match[1]); });
    child.stderr.on('data', chunk => { logs += chunk; });
    child.on('exit', () => reject(new Error(logs)));
    setTimeout(() => reject(new Error(`server startup timeout: ${logs}`)), 5000).unref();
  });
  const base = `http://127.0.0.1:${port}`;
  async function session() {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: origin } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    return { cookie: cookie.split(';')[0], ...(await response.json()) };
  }
  async function connect(auth, requestOrigin = origin, shouldFail = false) {
    const socket = io(base, { transports: ['websocket'], reconnection: false, extraHeaders: { Origin: requestOrigin, Cookie: auth?.cookie || '' } });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', () => shouldFail ? reject(new Error('unexpected connection')) : resolve());
      socket.once('connect_error', err => shouldFail ? resolve() : reject(err));
    });
    return socket;
  }
  assert.equal((await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  const hostAuth = await session();
  const guestAuth = await session();
  await connect(null, origin, true);
  await connect(hostAuth, 'https://evil.example', true);
  const host = await connect(hostAuth);
  const guest = await connect(guestAuth);
  const initialView = update(host);
  const created = await request(host, 'create-room', { name: 'Host', clientId: 'forged-id' });
  assert.ok(created.ok);
  const view = await initialView;
  assert.equal(view.me.id, hostAuth.playerId);
  assert.equal((await request(guest, 'rejoin-room', { roomCode: view.code, clientId: hostAuth.playerId })).ok, undefined);
  assert.ok((await request(guest, 'join-room', { name: 'Guest', roomCode: view.code })).error);
  assert.ok((await request(guest, 'join-room', { name: 'Guest', roomCode: view.code, invite: view.inviteToken })).ok);
  assert.deepEqual((await request(guest, 'list-rooms')).rooms, []);
  assert.ok((await request(guest, 'force-end-game')).error);
  for (const [event, payload] of [['send-chat', { text: 3 }], ['submit-clues', null], ['create-room', { name: [] }]]) {
    assert.ok((await request(guest, event, payload)).error);
  }
  // A non-function callback must not crash the process.
  guest.emit('send-chat', { text: 'ok' }, 'not a callback');
  assert.ok((await request(host, 'list-rooms')).ok);
  const secondTab = await connect(hostAuth);
  assert.ok((await request(secondTab, 'rejoin-room', { roomCode: view.code })).ok);
  const firstUpdate = update(host, v => v.chat.some(m => m.text === 'both tabs'));
  const secondUpdate = update(secondTab, v => v.chat.some(m => m.text === 'both tabs'));
  await request(guest, 'send-chat', { text: 'both tabs' });
  await Promise.all([firstUpdate, secondUpdate]);
  host.disconnect();
  const stillOnline = update(secondTab, v => v.chat.some(m => m.text === 'still online'));
  await request(guest, 'send-chat', { text: 'still online' });
  assert.equal((await stillOnline).players.find(p => p.id === hostAuth.playerId).connected, true);
  const detached = update(secondTab, v => !v.players.some(p => p.id === guestAuth.playerId));
  assert.ok((await request(guest, 'create-room', { name: 'Other room' })).ok);
  await detached;
  // Public queues never expose or use private invitations and have no host.
  const thirdAuth = await session();
  const third = await connect(thirdAuth);
  const firstPublic = update(secondTab, v => v.visibility === 'public');
  assert.ok((await request(secondTab, 'find-game', { name: 'Host', gameType: 'decoder' })).ok);
  const publicView = await firstPublic;
  assert.equal(publicView.hostId, null);
  assert.equal(publicView.gameType, 'decoder');
  assert.equal(publicView.inviteToken, null);
  assert.notEqual(publicView.code, view.code);
  assert.ok((await request(secondTab, 'start-game')).error);
  assert.ok((await request(secondTab, 'set-game-type', { gameType: 'ttr' })).error);
  assert.ok((await request(third, 'join-room', { name: 'Third', roomCode: publicView.code })).error);
  assert.ok((await request(guest, 'find-game', { name: 'Guest', gameType: 'decoder' })).ok);
  const countdown = update(secondTab, v => !!v.startDeadline);
  assert.ok((await request(third, 'find-game', { name: 'Third', gameType: 'decoder' })).ok);
  assert.equal((await countdown).players.length, 3);
  const cancelled = update(secondTab, v => v.startDeadline === null && v.players.length === 2);
  assert.ok((await request(third, 'leave-room')).ok);
  await cancelled;
  const playing = update(secondTab, v => v.status === 'playing');
  assert.ok((await request(third, 'find-game', { name: 'Third', gameType: 'decoder' })).ok);
  const playingView = await playing;
  assert.equal(playingView.players.length, 3);
  assert.ok(playingView.sharedPlayerId);
  // Disconnect has no automatic expiry; authenticated players can resume or finish manually.
  third.disconnect();
  const returned = await connect(thirdAuth);
  assert.ok((await request(returned, 'rejoin-room', { roomCode: publicView.code })).ok);
  const active = update(secondTab, v => v.status === 'playing' && v.chat.some(m => m.text === 'returned'));
  await request(returned, 'send-chat', { text: 'returned' });
  await active;
  const offline = update(secondTab, v => v.canForceEnd && v.status === 'playing');
  returned.disconnect();
  await offline;
  // Even the old grace interval must no longer end the game.
  await new Promise(resolve => setTimeout(resolve, 400));
  const returnRooms = await request(secondTab, 'my-rooms');
  assert.equal(returnRooms.rooms.find(r => r.code === publicView.code).status, 'playing');
  const again = await connect(thirdAuth);
  const ownRooms = await request(again, 'my-rooms');
  assert.ok(ownRooms.rooms.some(r => r.code === publicView.code));
  assert.ok((await request(again, 'rejoin-room', { roomCode: publicView.code })).ok);
  assert.ok((await request(secondTab, 'force-end-game')).error);
  const canFinish = update(secondTab, v => v.canForceEnd);
  again.disconnect();
  await canFinish;
  const ended = update(secondTab, v => v.status === 'finished');
  assert.ok((await request(secondTab, 'force-end-game')).ok);
  assert.match((await ended).winReason, /завершена игроком/);
  const nextQueue = update(secondTab, v => v.visibility === 'public' && v.status === 'lobby');
  assert.ok((await request(secondTab, 'find-game', { name: 'Host', gameType: 'decoder' })).ok);
  assert.notEqual((await nextQueue).code, publicView.code);
  let limited = false;
  for (let i = 0; i < 110; i++) {
    const result = await request(secondTab, 'list-rooms');
    if (result.error?.includes('Слишком много')) { limited = true; break; }
  }
  assert.equal(limited, true);
});
