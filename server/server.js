const path = require('path');
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
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const manager = new RoomManager();
const DISCONNECT_GRACE_MS = 25 * 1000;

app.use(express.static(path.join(__dirname, '..', 'public')));

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
    const sockId = [...sessions.entries()].find(
      ([, s]) => s.roomCode === room.code && s.playerId === player.id
    )?.[0];
    if (sockId) {
      io.to(sockId).emit('room-update', room.viewFor(player.id));
    }
  }
}

io.on('connection', (socket) => {
  socket.on('list-rooms', (_, cb) => {
    cb?.({ ok: true, rooms: manager.listSummaries() });
  });

  socket.on('create-room', ({ name, clientId }, cb) => {
    try {
      const room = manager.createRoom();
      const playerId = clientId || socket.id;
      room.addPlayer(playerId, (name || 'Игрок').trim() || 'Игрок');
      socket.join(room.code);
      sessions.set(socket.id, { roomCode: room.code, playerId });
      cb?.({ ok: true, roomCode: room.code });
      broadcastRoom(room);
    } catch (e) {
      cb?.({ error: 'Не удалось создать комнату' });
    }
  });

  socket.on('join-room', ({ name, roomCode, clientId }, cb) => {
    const room = manager.get(roomCode);
    if (!room) return cb?.({ error: 'Комната не найдена' });
    if (room.status !== 'lobby') return cb?.({ error: 'Игра уже началась' });
    if (room.players.size >= 8) return cb?.({ error: 'Комната заполнена' });
    const playerId = clientId || socket.id;
    room.addPlayer(playerId, (name || 'Игрок').trim() || 'Игрок');
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId });
    cb?.({ ok: true, roomCode: room.code });
    broadcastRoom(room);
  });

  socket.on('rejoin-room', ({ roomCode, clientId }, cb) => {
    const room = manager.get(roomCode);
    if (!room || !clientId) return cb?.({ error: 'Комната не найдена' });
    const player = room.players.get(clientId);
    if (!player) return cb?.({ error: 'Игрок не найден в комнате' });
    clearDisconnectTimer(room.code, clientId);
    room.setConnected(clientId, true);
    socket.join(room.code);
    sessions.set(socket.id, { roomCode: room.code, playerId: clientId });
    cb?.({ ok: true });
    broadcastRoom(room);
  });

  socket.on('choose-team', ({ team }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.setTeam(s.playerId, team);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('set-game-type', ({ gameType }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.setGameType(s.playerId, gameType);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('start-game', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может начать игру' });
    const res = room.startGame();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('submit-clues', ({ clues }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.submitClues(s.playerId, clues);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('update-guess', ({ kind, guess }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.updateGuessDraft(s.playerId, kind, guess);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('lock-guess', ({ kind }, cb) => {
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

  socket.on('update-tiebreak-guess', ({ words }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.updateTiebreakGuess(s.playerId, words);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('lock-tiebreak-guess', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.lockTiebreakGuess(s.playerId);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  // --- Ticket to Ride ---
  socket.on('draw-card', ({ source }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.drawCard(s.playerId, source);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('claim-route', ({ routeId, payment }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.claimRoute(s.playerId, routeId, payment);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('resolve-tunnel', ({ decision }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.resolveTunnel(s.playerId, decision);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('draw-tickets', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.drawTickets(s.playerId);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('choose-tickets', ({ keepIndices }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.chooseTickets(s.playerId, keepIndices);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('build-station', ({ routeId, payment }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.buildStation(s.playerId, routeId, payment);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('force-end-game', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может завершить игру' });
    const res = room.forceEndGame();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('play-again', (_, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    if (room.hostId !== s.playerId) return cb?.({ error: 'Только хост может начать новую игру' });
    const res = room.playAgain();
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('send-chat', ({ text, replyTo }, cb) => {
    const s = sessions.get(socket.id);
    const room = s && manager.get(s.roomCode);
    if (!room) return cb?.({ error: 'Нет комнаты' });
    const res = room.sendMessage(s.playerId, text, replyTo);
    cb?.(res);
    if (res.ok) broadcastRoom(room);
  });

  socket.on('leave-room', (_, cb) => {
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
      room.removePlayer(s.playerId);
      broadcastRoom(room);
    }
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    handleDisconnect(socket);
  });
});

function handleDisconnect(socket) {
  const s = sessions.get(socket.id);
  if (!s) return;
  sessions.delete(socket.id);
  const room = manager.get(s.roomCode);
  if (!room) return;

  // помечаем игрока офлайн сразу, но даём время вернуться (например, после
  // перезагрузки страницы), прежде чем окончательно убрать его из комнаты
  room.setConnected(s.playerId, false);
  broadcastRoom(room);

  const key = timerKey(s.roomCode, s.playerId);
  const timer = setTimeout(() => {
    disconnectTimers.delete(key);
    const player = room.players.get(s.playerId);
    if (player && !player.connected) {
      room.removePlayer(s.playerId);
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
  console.log(`Декодер запущен на порту ${PORT}`);
});
