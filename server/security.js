const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function positiveInt(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Security limits must be positive integers');
  return n;
}
function readConfig(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(s => new URL(s.trim()).origin);
  if (origins.some(origin => !/^https?:\/\//.test(origin))) throw new Error('ALLOWED_ORIGINS must contain HTTP(S) origins');
  return {
    origins, secureCookie: env.COOKIE_SECURE === 'true',
    publicRooms: env.PUBLIC_ROOM_LIST === 'true', requireInvite: env.REQUIRE_INVITE !== 'false',
    maxRooms: positiveInt(env.MAX_ROOMS, 500),
    maxConnections: positiveInt(env.MAX_CONNECTIONS, 200),
    eventsPerMinute: positiveInt(env.EVENTS_PER_MINUTE, 180),
    joinsPerMinute: positiveInt(env.JOINS_PER_MINUTE, 30),
    createsPerHour: positiveInt(env.CREATES_PER_HOUR, 10),
    connectionsPerMinute: positiveInt(env.CONNECTIONS_PER_MINUTE, 120),
  };
}
function loadSecret(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'session-key');
  try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const secret = fs.readFileSync(file);
  if (secret.length < 32) throw new Error('Session key is too short');
  return secret;
}
function createIdentity(secret) {
  const sign = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return {
    issue() {
      const id = crypto.randomUUID();
      const payload = `${id}.${Date.now() + 30 * 86400000}`;
      return { id, token: `${payload}.${sign(payload)}` };
    },
    verify(cookie = '') {
      const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('gameshub_session='))?.slice(17);
      if (!token || token.length > 200) return null;
      const [id, expires, signature, extra] = token.split('.');
      if (extra || !/^[a-f0-9-]{36}$/.test(id || '') || !/^\d+$/.test(expires || '') || Number(expires) <= Date.now()) return null;
      const expected = Buffer.from(sign(`${id}.${expires}`));
      const actual = Buffer.from(signature || '');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? id : null;
    },
  };
}
// A bounded window map; expired entries are pruned even under a stream of new IPs.
function createLimiter(maxKeys = 10000) {
  const entries = new Map();
  return (key, limit, windowMs) => {
    const now = Date.now();
    for (const [k, entry] of entries) if (entry.until <= now) entries.delete(k);
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= maxKeys) return false;
      entry = { count: 0, until: now + windowMs };
      entries.set(key, entry);
    }
    return ++entry.count <= limit;
  };
}
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, n = 100) => typeof v === 'string' && v.length <= n;
const code = v => typeof v === 'string' && /^[A-Z2-9]{4}$/i.test(v);
const words = (v, n, length) => Array.isArray(v) && v.length === n && v.every(w => str(w, length));
const payment = v => obj(v) && Object.entries(v).every(([k, n]) => ['pink', 'white', 'blue', 'yellow', 'orange', 'black', 'red', 'green', 'locomotive'].includes(k) && Number.isInteger(n) && n >= 0 && n <= 110);
const emptyEvents = new Set(['list-rooms', 'start-game', 'lock-tiebreak-guess', 'draw-tickets', 'force-end-game', 'play-again', 'mark-chat-read', 'leave-room']);
function validPayload(event, p) {
  if (!obj(p)) return false;
  if (emptyEvents.has(event)) return true;
  switch (event) {
    case 'create-room': return str(p.name, 80);
    case 'join-room': return str(p.name, 80) && code(p.roomCode) && (p.invite === undefined || str(p.invite, 100));
    case 'rejoin-room': return code(p.roomCode);
    case 'choose-team': return ['A', 'B', 'AB'].includes(p.team);
    case 'set-game-type': return ['decoder', 'ttr'].includes(p.gameType);
    case 'submit-clues': return words(p.clues, 3, 60);
    case 'update-guess': return ['own', 'intercept'].includes(p.kind) && Array.isArray(p.guess) && p.guess.length === 3 && p.guess.every(n => n === null || (Number.isInteger(n) && n >= 1 && n <= 4));
    case 'lock-guess': return ['own', 'intercept'].includes(p.kind);
    case 'update-tiebreak-guess': return words(p.words, 4, 30);
    case 'draw-card': return p.source === 'deck' || (Number.isInteger(p.source) && p.source >= 0 && p.source < 5);
    case 'claim-route': case 'build-station': return str(p.routeId) && payment(p.payment);
    case 'resolve-tunnel': return p.decision === null || (obj(p.decision) && (p.decision.extraPayment === undefined || payment(p.decision.extraPayment)));
    case 'choose-tickets': return Array.isArray(p.keepIndices) && p.keepIndices.length <= 10 && p.keepIndices.every(n => Number.isInteger(n) && n >= 0 && n < 10);
    case 'send-chat': return str(p.text, 300) && (p.replyTo == null || str(p.replyTo));
    case 'edit-chat': return str(p.id) && str(p.text, 300);
    default: return false;
  }
}
module.exports = { readConfig, loadSecret, createIdentity, createLimiter, validPayload };
