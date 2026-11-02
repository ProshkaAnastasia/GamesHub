const path = require('path');
const { readConfig, loadSecret, createIdentity, createLimiter, validPayload } = require('./security');
const config = readConfig();
const identity = createIdentity(loadSecret(process.env.DATA_DIR || path.join(__dirname, 'data')));
const allow = createLimiter();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { RoomManager } = require('./game');
// таймер автопродолжения раунда специфичен для «Декодера» (фаза reveal);
// у будущих типов игр может не быть такой фазы вовсе — это нормально,
// проверка на room.game.phase === 'reveal' ниже просто не сработает для них
const { REVEAL_TIME_MS } = require('./games/decoder');
const { CITIES, ROUTES } = require('./games/ttr/map');
const { TRAIN_COLORS } = require('./games/ttr/rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: config.origins, credentials: true },
  maxHttpBufferSize: 16 * 1024,
  allowRequest: (req, done) => done(null, io.engine.clientsCount < config.maxConnections && config.origins.includes(req.headers.origin) && allow(`connect:${req.socket.remoteAddress}`, config.connectionsPerMinute, 60000)),
});

const PORT = process.env.PORT || 3000;
server.headersTimeout = 15000;
server.requestTimeout = 30000;
const manager = new RoomManager();
const DISCONNECT_GRACE_MS = 25 * 1000;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  // Inline styles are used by the existing renderer; scripts remain same-origin.
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (config.secureCookie) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.post('/api/session', (req, res) => {
  if (!config.origins.includes(req.headers.origin)) return res.sendStatus(403);
  if (!allow(`session:${req.socket.remoteAddress}`, config.connectionsPerMinute, 60000)) return res.sendStatus(429);
  res.set('Cache-Control', 'no-store');
  let id = identity.verify(req.headers.cookie);
  if (!id) {
    const session = identity.issue();
    id = session.id;
    res.set('Set-Cookie', `gameshub_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${config.secureCookie ? '; Secure' : ''}`);
  }
  res.json({ playerId: id });
});
io.use((socket, next) => {
  const id = identity.verify(socket.request.headers.cookie);
  if (!id) return next(new Error('Сессия истекла. Перезагрузите страницу.'));
  socket.data.playerId = id;
  next();
});

// проект активно меняется день ото дня — без явного запрета кеширования
// браузеры (особенно Safari) иногда придерживают старую копию styles.css/
// app.js дольше, чем нужно, и правки визуально "не применяются", хотя файл
// на диске уже другой. Версионирования файлов тут нет, поэтому проще
// запретить кеш полностью, чем гоняться за конкретным браузером.
// Только html/css/js — эти правятся каждый день. Карту TTR (~2.4МБ SVG) и
// картинки карт сюда не включаем: no-store заставлял браузер перекачивать
// их заново при каждом заходе на экран игры, а не только при правках, и на
// нестабильном соединении это иногда обрывало загрузку карты на середине
// (белый экран, "загрузка карты" зависает навсегда — грузится один раз и
// не перезапрашивается, см. loadTtrAssets в app.js).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/.test(filePath)) res.set('Cache-Control', 'no-store');
  },
}));

// статичные данные карты TTR (города/маршруты/цвета карт) — не зависят от
// конкретной комнаты, клиент запрашивает их один раз и кэширует
app.get('/api/ttr/map', (req, res) => {
  res.json({ cities: CITIES, routes: ROUTES, trainColors: TRAIN_COLORS });
});

// socket.id -> { roomCode, playerId }
const sessions = new Map();
// `${roomCode}::${playerId}` -> таймер отложенного удаления после обрыва связи
const disconnectTimers = new Map();

function timerKey(roomCode, playerId) {
  return `${roomCode}::${playerId}`;
}

function clearDisconnectTimer(roomCode, playerId) {
  const key = timerKey(roomCode, playerId);
  const timer = disconnectTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(key);
  }
}

// roomCode -> таймер автоматического старта следующего раунда после результата
const revealTimers = new Map();

function scheduleRevealAdvance(room, delayMs = REVEAL_TIME_MS) {
  const existing = revealTimers.get(room.code);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    revealTimers.delete(room.code);
    const res = room.nextRound();
    if (res.ok) broadcastRoom(room);
  }, Math.max(0, delayMs));
  revealTimers.set(room.code, timer);
}

function broadcastRoom(room) {
  manager.save(room);
  for (const player of room.players.values()) {
    for (const [sockId, session] of sessions) {
      if (session.roomCode === room.code && session.playerId === player.id) {
        io.to(sockId).emit('room-update', room.viewFor(player.id));
      }
    }
  }
}

io.on('connection', (socket) => {
  // Guard every application handler, including malformed payloads and callbacks.
  function onEvent(event, handler) {
    return socket.on(event, (payload, callback) => {
      const cb = typeof callback === 'function' ? callback : () => {};
      if (!identity.verify(socket.request.headers.cookie)) return cb({ error: 'Сессия истекла. Обновите страницу.' });
      const ip = socket.handshake.address;
      if (!allow(`events:${socket.data.playerId}`, config.eventsPerMinute, 60000)
          || !allow(`ip-events:${ip}`, config.eventsPerMinute * 10, 60000)) return cb({ error: 'Слишком много действий. Подождите немного.' });
      if (!validPayload(event, payload)) return cb({ error: 'Неверный формат запроса' });
      if (['join-room', 'rejoin-room'].includes(event) && !allow(`join:${ip}`, config.joinsPerMinute, 60000)) return cb({ error: 'Слишком много попыток входа' });
      if (event === 'create-room' && !allow(`create:${ip}`, config.createsPerHour, 3600000)) return cb({ error: 'Слишком много созданных комнат' });
      try { handler(payload, cb); }
      catch (error) {
        console.error(`Ошибка события ${event}:`, error.message);
        cb({ error: 'Не удалось выполнить действие' });
      }
    });
  };
  onEvent('list-rooms', (_, cb) => {
    cb?.({ ok: true, rooms: config.publicRooms ? manager.listSummaries() : [] });
  });

  onEvent('create-room', ({ name }, cb) => {
    try {
      if (manager.rooms.size >= config.maxRooms) return cb({ error: 'Достигнут лимит комнат' });
      if (!detachRoom(socket, cb)) return;
      const room = manager.createRoom();
      const playerId = socket.data.playerId;
      room.addPlayer(playerId, (name || 'Игрок').trim() || 'Игрок');
      socket.join(room.code);
      clearDisconnectTimer(room.code, playerId);
      sessions.set(socket.id, { roomCode: room.code, playerId });
      cb?.({ ok: true, roomCode: room.code });
      broadcastRoom(room);
    } catch (e) {
      cb?.({ error: 'Не удалось создать комнату' });
    }
  });

  onEvent('join-room', ({ name, roomCode, invite }, cb) => {
    const room = manager.get(roomCode);
    if (!room) return cb?.({ error: 'Комната не найдена' });
    if (config.requireInvite && invite !== room.inviteToken) return cb({ error: 'Для входа нужна ссылка-приглашение' });
    if (room.players.has(socket.data.playerId)) return cb({ error: 'Используйте восстановление подключения' });
    if (room.players.size >= 8) return cb?.({ error: 'Комната заполнена' });
    if (!detachRoom(socket, cb)) return;
    const playerId = socket.data.playerId;
    const trimmedName = (name || 'Игрок').trim() || 'Игрок';
    // партия уже идёт — подключаем зрителем, а если это TTR и она ещё
    // позволяет добавить живого игрока (см. Room.joinInProgress) — игроком
    const player = room.status === 'lobby'
      ? room.addPlayer(playerId, trimmedName)
      : room.joinInProgress(playerId, trimmedName);
    socket.join(room.code);
    clearDisconnectTimer(room.code, playerId);
    sessions.set(socket.id, { roomCode: room.code, playerId });
    cb?.({ ok: true, roomCode: room.code, role: player.role || 'player' });
    broadcastRoom(room);
  });

  onEvent('rejoin-room', ({ roomCode }, cb) => {
    const clientId = socket.data.playerId;
    const room = manager.get(roomCode);
    if (!room || !clientId) return cb?.({ error: 'Комната не найдена' });
    const player = room.players.get(clientId);
    if (!player) return cb?.({ error: 'Игрок не найден в комнате' });
    if (!detachRoom(socket, cb, room.code)) return;
    clearDisconnectTimer(room.code, clientId);
    room.setConnected(clientId, true);
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: clientId });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  onEvent('choose-team', ({ team }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.setTeam(s.playerId, team);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('set-game-type', ({ gameType }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.setGameType(s.playerId, gameType);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('start-game', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может начать игру' });
    const res = room.startGame();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('submit-clues', ({ clues }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.submitClues(s.playerId, clues);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('update-guess', ({ kind, guess }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.updateGuessDraft(s.playerId, kind, guess);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('lock-guess', ({ kind }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.lockGuess(s.playerId, kind);
    cb?.(res);
    if (res.ok) {
      broadcastRoom(room);
      // следующий раунд начинается сам через паузу — никто не жмёт кнопку
      if (room.status === 'playing' && room.game?.phase === 'reveal') scheduleRevealAdvance(room);
    }
  });

  onEvent('update-tiebreak-guess', ({ words }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.updateTiebreakGuess(s.playerId, words);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('lock-tiebreak-guess', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.lockTiebreakGuess(s.playerId);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  // --- Ticket to Ride ---
  onEvent('draw-card', ({ source }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.drawCard(s.playerId, source);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('claim-route', ({ routeId, payment }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.claimRoute(s.playerId, routeId, payment);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('resolve-tunnel', ({ decision }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.resolveTunnel(s.playerId, decision);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('draw-tickets', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.drawTickets(s.playerId);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('choose-tickets', ({ keepIndices }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.chooseTickets(s.playerId, keepIndices);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('build-station', ({ routeId, payment }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.buildStation(s.playerId, routeId, payment);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('force-end-game', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может завершить игру' });
    const res = room.forceEndGame();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('play-again', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может начать новую игру' });
    const res = room.playAgain();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('send-chat', ({ text, replyTo }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.sendMessage(s.playerId, text, replyTo);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('edit-chat', ({ id, text }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.editMessage(s.playerId, id, text);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('mark-chat-read', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.markChatRead(s.playerId);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  onEvent('leave-room', (_, cb) => {
    // осознанный выход разрешён только тогда, когда он не ломает текущий
    // раунд команды; обрыв связи (когда игрок ничего не выбирал) — другое
    // дело, там game просто ставится на паузу баннером, т.к. это не отменить
    const s = sessions.get(socket.id);
    if (!s) return cb?.({ ok: true });
    const room = manager.get(s.roomCode);
    if (room) {
      const check = room.canPlayerLeaveSafely(s.playerId);
      if (!check.safe) return cb?.({ error: check.reason });
    }
    sessions.delete(socket.id);
    if (room) {
      clearDisconnectTimer(room.code, s.playerId);
      socket.leave(room.code);
      if (!hasConnection(s.roomCode, s.playerId)) room.removePlayer(s.playerId);
      broadcastRoom(room);
    }
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function hasConnection(roomCode, playerId) {
  return [...sessions.values()].some(s => s.roomCode === roomCode && s.playerId === playerId);
}
function detachRoom(socket, cb, nextRoomCode) {
  const previous = sessions.get(socket.id);
  if (!previous || previous.roomCode === nextRoomCode) return true;
  const room = manager.get(previous.roomCode);
  const check = room?.canPlayerLeaveSafely(previous.playerId);
  if (check && !check.safe) { cb({ error: check.reason }); return false; }
  sessions.delete(socket.id);
  socket.leave(previous.roomCode);
  if (room && !hasConnection(previous.roomCode, previous.playerId)) {
    clearDisconnectTimer(previous.roomCode, previous.playerId);
    room.removePlayer(previous.playerId);
    broadcastRoom(room);
  }
  return true;
}

function handleDisconnect(socket) {
  const s = sessions.get(socket.id);
  if (!s) return;
  sessions.delete(socket.id);
  const room = manager.get(s.roomCode);
  if (!room || hasConnection(s.roomCode, s.playerId)) return;

  // помечаем игрока офлайн сразу, но даём время вернуться (например, после
  // перезагрузки страницы), прежде чем окончательно убрать его из комнаты
  room.setConnected(s.playerId, false);
  broadcastRoom(room);

  const key = timerKey(s.roomCode, s.playerId);
  const timer = setTimeout(() => {
    disconnectTimers.delete(key);
    const player = room.players.get(s.playerId);
    if (player && !player.connected) {
      if (!hasConnection(s.roomCode, s.playerId)) room.removePlayer(s.playerId);
      broadcastRoom(room);
    }
  }, DISCONNECT_GRACE_MS);
  disconnectTimers.set(key, timer);
}

// восстановленные из файлов комнаты могли остановиться на фазе результата —
// доигрываем оставшееся время таймера (или сразу переходим дальше, если
// пауза уже истекла, пока сервер был выключен)
for (const room of manager.rooms.values()) {
  if (room.status === 'playing' && room.game?.phase === 'reveal' && room.game.revealDeadline) {
    const remaining = room.game.revealDeadline - Date.now();
    if (remaining <= 0) {
      const res = room.nextRound();
      if (res.ok) manager.save(room);
    } else {
      scheduleRevealAdvance(room, remaining);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Декодер запущен на порту ${server.address().port}`);
});
