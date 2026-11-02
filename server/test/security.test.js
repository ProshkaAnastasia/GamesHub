const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createIdentity, createLimiter, validPayload, readConfig, loadSecret, allowedSocketOrigin } = require('../security');

test('signed identity cannot be forged using a public player ID', () => {
  const identity = createIdentity(crypto.randomBytes(32));
  const session = identity.issue();
  assert.equal(identity.verify(`gameshub_session=${session.token}; other=1`), session.id);
  assert.equal(identity.verify(`gameshub_session=${session.token.replace(session.id, crypto.randomUUID())}`), null);
  assert.equal(identity.verify(`gameshub_session=${session.id}`), null);
  assert.equal(identity.verify(''), null);
  assert.equal(createIdentity(crypto.randomBytes(32)).verify(`gameshub_session=${session.token}`), null);
});

test('all socket events reject malformed payloads', () => {
  const cases = {
    'find-game': { name: 'Имя', gameType: 'decoder' },
    'create-room': { name: 'Имя' }, 'join-room': { name: 'Имя', roomCode: 'AB23' },
    'rejoin-room': { roomCode: 'AB23' }, 'choose-team': { team: 'A' },
    'set-game-type': { gameType: 'decoder' }, 'submit-clues': { clues: ['a', 'b', 'c'] },
    'update-guess': { kind: 'own', guess: [1, 2, null] }, 'lock-guess': { kind: 'own' },
    'update-tiebreak-guess': { words: ['', '', '', ''] }, 'draw-card': { source: 0 },
    'claim-route': { routeId: 'route', payment: { red: 2 } },
    'build-station': { routeId: 'route', payment: { blue: 1 } },
    'resolve-tunnel': { decision: null }, 'choose-tickets': { keepIndices: [0] },
    'send-chat': { text: 'hi' }, 'edit-chat': { id: 'msg', text: 'hi' },
    'my-rooms': {}, 'start-game': {}, 'list-rooms': {}, 'lock-tiebreak-guess': {}, 'draw-tickets': {},
    'force-end-game': {}, 'play-again': {}, 'mark-chat-read': {}, 'leave-room': {},
  };
  for (const [event, payload] of Object.entries(cases)) {
    assert.equal(validPayload(event, payload), true, event);
    for (const bad of [null, [], 1, 'text']) assert.equal(validPayload(event, bad), false, event);
  }
  assert.equal(validPayload('create-room', { name: 3 }), false);
  assert.equal(validPayload('submit-clues', { clues: [1, 2, 3] }), false);
  assert.equal(validPayload('claim-route', { routeId: 'r', payment: { red: -1 } }), false);
  assert.equal(validPayload('update-guess', { kind: 'own', guess: [0, 2, 9] }), false);
  assert.equal(validPayload('send-chat', { text: 'x'.repeat(301) }), false);
});

test('limiter caps requests and memory; defaults are private', () => {
  const allow = createLimiter(1);
  assert.equal(allow('one', 2, 60000), true);
  assert.equal(allow('one', 2, 60000), true);
  assert.equal(allow('one', 2, 60000), false);
  assert.equal(allow('two', 2, 60000), false);
  const config = readConfig({});
  assert.equal(config.matchStartDelayMs, 15000);
  assert.equal(config.publicRooms, false);
  assert.throws(() => readConfig({ EVENTS_PER_MINUTE: '-1' }));
  assert.throws(() => readConfig({ ALLOWED_ORIGINS: '*' }));
});

test('session signing key survives restart without exposing it in room state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gameshub-key-'));
  try {
    const first = createIdentity(loadSecret(dir));
    const session = first.issue();
    assert.equal(createIdentity(loadSecret(dir)).verify(`gameshub_session=${session.token}`), session.id);
    assert.equal(fs.statSync(path.join(dir, 'session-key')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same-origin polling without Origin is allowed; foreign origins and hosts are rejected', () => {
  const origins = ['http://localhost:3000'];
  const check = headers => allowedSocketOrigin({ headers }, origins);
  assert.equal(check({ origin: origins[0] }), true);
  assert.equal(check({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(check({ host: 'evil.example', 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(check({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(check({ origin: 'https://evil.example', host: 'localhost:3000', 'sec-fetch-site': 'same-origin' }), false);
});
