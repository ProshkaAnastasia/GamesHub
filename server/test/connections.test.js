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
    env: { ...process.env, PORT: '0', DATA_DIR: dir, ALLOWED_ORIGINS: origin, EVENTS_PER_MINUTE: '100', PUBLIC_ROOM_LIST: 'false', REQUIRE_INVITE: 'true' },
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
  let limited = false;
  for (let i = 0; i < 110; i++) {
    const result = await request(secondTab, 'list-rooms');
    if (result.error?.includes('Слишком много')) { limited = true; break; }
  }
  assert.equal(limited, true);
});
