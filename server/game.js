// Room — общая «оболочка» комнаты: игроки, команды-слоты, чат, статус,
// персистентность и архив прошлых партий. Все правила конкретной игры
// (сейчас — только «Декодер») живут в подключаемых модулях из ./games и
// доступны через this.game — Room ничего не знает об их внутреннем
// устройстве, только вызывает общий контракт (см. ./games/decoder/index.js).
const store = require('./store');
const { randomBytes } = require('crypto');
const { GAME_MODULES, GAME_LIST, DEFAULT_GAME_TYPE } = require('./games');

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

class Room {
  constructor(code, visibility = 'private') {
    this.code = code;
    this.visibility = visibility;
    this.startDeadline = null;
    this.inviteToken = randomBytes(24).toString('hex');
    this.createdAt = Date.now();
    this.hostId = null;
    this.players = new Map(); // id -> {id, name, team, connected}
    this.status = 'lobby'; // lobby | playing | finished
    // null, пока хост явно не выберет игру — до этого момента состав
    // команд/цветов настраивать нельзя (см. setTeam/canStart)
    this.gameType = null;
    // {A: [ids...], B: [ids...]} — порядок выбора команды игроками; переживает
    // «играть ещё раз» (используется для ротации шифровальщика заново
    // каждую партию), формой ключей заведует выбранный игровой модуль
    this.teamOrder = {};
    this.usedWords = new Set(); // слова, уже сыгранные в этой комнате — не повторяем, пока не закончатся все
    this.chat = []; // {id, playerId, name, team, text, ts, replyTo, edited} — общий чат комнаты, живёт дольше одной игры
    // playerId -> ts последнего открытия чата этим игроком — приблизительный
    // статус прочтения ("прочитано" = чат открывали после ts сообщения), не
    // по каждому сообщению отдельно (см. markChatRead)
    this.chatRead = {};
    // архив завершённых игр в этой комнате — заполняется в playAgain(),
    // прежде чем состояние игры сбрасывается для новой партии; секретов
    // тут уже нет (игра окончена), поэтому храним данные как есть
    this.pastGames = [];
    // экземпляр выбранного игрового модуля — существует, пока идёт партия
    // или показывается её результат; null в лобби
    this.game = null;
  }

  get module() {
    return GAME_MODULES[this.gameType];
  }

  addPlayer(id, name) {
    const player = { id, name: name.slice(0, 20), team: null, connected: true };
    this.players.set(id, player);
    if (this.visibility === 'private' && !this.hostId) this.hostId = id;
    return player;
  }

  // вход в уже идущую партию (status !== 'lobby') — отдельный путь от
  // addPlayer выше: по умолчанию зритель, но если это TTR и партия ещё
  // позволяет добавить живого игрока (не финальный круг, есть свободное
  // место) — TicketToRideGame.addPlayer сам раздаст стартовую руку/билеты
  // "с колёс", и роль станет 'player'. Декодер такого метода не имеет —
  // там подключение всегда зрителем (см. CLAUDE.md/план про причины)
  joinInProgress(id, name) {
    const player = { id, name: name.slice(0, 20), team: null, connected: true, role: 'spectator' };
    this.players.set(id, player);
    if (this.visibility === 'private' && !this.hostId) this.hostId = id;
    if (this.gameType === 'ttr' && this.game && typeof this.game.addPlayer === 'function') {
      const res = this.game.addPlayer(id);
      if (res.ok) player.role = 'player';
    }
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    player.left = true;
    if (this.status === 'playing' && player.role !== 'spectator') {
      this.forceEndGame(`Игрок ${player.name} вышел — партия завершена. Можно найти новую игру.`);
    }
    // если игра ещё в лобби — удаляем совсем
    if (this.status === 'lobby') {
      this.players.delete(id);
      [...(this.module?.teamKeys || []), this.module?.sharedTeamKey].filter(Boolean).forEach(t => {
        this.teamOrder[t] = (this.teamOrder[t] || []).filter(pid => pid !== id);
      });
    }
    // При осознанном выходе хост передаёт права следующему
    // онлайн-игроку — иначе комната зависла бы навсегда без возможности
    // нажать «начать игру» / «следующий раунд» / «играть ещё раз»
    if (this.hostId === id) {
      const others = [...this.players.values()].filter(p => p.id !== id);
      const online = others.find(p => p.connected);
      this.hostId = (online || others[0] || null)?.id ?? null;
    }
  }

  setConnected(id, connected) {
    const player = this.players.get(id);
    if (player) {
      if (!connected && player.connected) player.disconnectedAt = Date.now();
      player.connected = connected;
      if (connected) delete player.disconnectedAt;
    }
  }

  expireOfflineLobbyPlayers(now, timeoutMs) {
    if (this.status !== 'lobby') return false;
    const expired = [...this.players.values()].filter(p => !p.connected
      && Number.isFinite(p.disconnectedAt) && now - p.disconnectedAt >= timeoutMs);
    expired.forEach(p => this.removePlayer(p.id));
    return expired.length > 0;
  }

  // чат работает в любой момент жизни комнаты (лобби/игра/финал), не
  // привязан к конкретной партии — переживает «играть ещё раз»
  sendMessage(playerId, text, replyToId) {
    const player = this.players.get(playerId);
    if (!player) return { error: 'Игрок не найден' };
    const trimmed = (text || '').trim().slice(0, 300);
    if (!trimmed) return { error: 'Пустое сообщение' };
    // сохраняем не ссылку на оригинал, а готовый снимок — если оригинал
    // потом выпадет за пределы истории в 200 сообщений, цитата в ответе
    // всё равно останется читаемой
    let replyTo = null;
    if (replyToId) {
      const original = this.chat.find((m) => m.id === replyToId);
      if (original) replyTo = { id: original.id, name: original.name, text: original.text.slice(0, 140) };
    }
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId,
      name: player.name,
      team: player.team,
      text: trimmed,
      ts: Date.now(),
      replyTo,
    };
    this.chat.push(message);
    // ограничиваем историю, чтобы комната не росла бесконечно
    if (this.chat.length > 200) this.chat = this.chat.slice(-200);
    return { ok: true, message };
  }

  // редактировать можно только своё сообщение — чужой id молча не найдёт
  // совпадения по playerId и вернёт ошибку, а не тихо облажается
  editMessage(playerId, id, text) {
    const message = this.chat.find((m) => m.id === id);
    if (!message) return { error: 'Сообщение не найдено' };
    if (message.playerId !== playerId) return { error: 'Можно редактировать только свои сообщения' };
    const trimmed = (text || '').trim().slice(0, 300);
    if (!trimmed) return { error: 'Пустое сообщение' };
    message.text = trimmed;
    message.edited = true;
    return { ok: true, message };
  }

  // приблизительный статус прочтения — просто "игрок открывал чат в
  // момент ts", а не отметка по каждому конкретному сообщению
  markChatRead(playerId) {
    if (!this.players.has(playerId)) return { error: 'Игрок не найден' };
    this.chatRead[playerId] = Date.now();
    return { ok: true };
  }

  setTeam(id, team) {
    if (this.status !== 'lobby') return { error: 'Игра уже началась' };
    if (this.module?.autoAssignTeams) return { error: 'Команды распределяются случайно при старте' };
    const teamKeys = [...(this.module?.teamKeys || []), this.module?.sharedTeamKey].filter(Boolean);
    if (!teamKeys.includes(team)) return { error: 'Неверная команда' };
    const player = this.players.get(id);
    if (!player) return { error: 'Игрок не найден' };
    // убрать из старой команды
    teamKeys.forEach(t => {
      this.teamOrder[t] = (this.teamOrder[t] || []).filter(pid => pid !== id);
    });
    player.team = team;
    this.teamOrder[team] = this.teamOrder[team] || [];
    this.teamOrder[team].push(id);
    return { ok: true };
  }

  setGameType(playerId, gameType) {
    if (this.visibility === 'public') return { error: 'Игра выбрана при подборе' };
    if (this.status !== 'lobby') return { error: 'Нельзя менять тип игры после старта' };
    if (this.hostId !== playerId) return { error: 'Только хост может менять тип игры' };
    if (!GAME_MODULES[gameType]) return { error: 'Неизвестный тип игры' };
    if (gameType === this.gameType) return { ok: true };
    this.gameType = gameType;
    // состав команд собран под предыдущую игру — при смене типа начинаем
    // рассадку заново, чтобы не тащить несовместимые предположения о ролях
    this.teamOrder = {};
    this.players.forEach(p => { p.team = null; });
    return { ok: true };
  }

  canStart() {
    const Module = this.module;
    // teamOrder — нужен командным играм (Декодер), players — играм без
    // команд, где просто считается число участников (TTR)
    return Module ? Module.canStart(this.teamOrder, this.players) : false;
  }

  updateStartDeadline(now, delayMs) {
    if (this.visibility !== 'public' || this.status !== 'lobby' || !this.canStart()) {
      this.startDeadline = null;
    } else if (this.startDeadline === null) {
      this.startDeadline = now + delayMs;
    }
    return this.startDeadline;
  }

  startGame() {
    if (this.status !== 'lobby') return { error: 'Партия уже началась' };
    const Module = this.module;
    if (!Module) return { error: this.gameType ? 'Неизвестный тип игры' : 'Сначала выберите игру' };
    if (!Module.canStart(this.teamOrder, this.players)) {
      return { error: Module.startRequirementText || 'Недостаточно игроков для этого режима' };
    }
    this.players.forEach(p => { p.role = p.connected ? 'player' : 'spectator'; });
    if (Module.assignTeams) this.teamOrder = Module.assignTeams(this.players);
    this.game = Module.create(this.players, this.teamOrder, this.usedWords);
    this.startDeadline = null;
    this.status = 'playing';
    return { ok: true };
  }

  // Выход доступен всегда; окончательный уход участника завершает партию.
  canPlayerLeaveSafely() {
    return { safe: true, reason: null };
  }

  // тонкие делегаты в текущую партию — если игры нет (ещё не началась/уже
  // сброшена), явно сообщаем об ошибке вместо падения на undefined-методе
  _delegate(method, ...args) {
    if (this.status !== 'playing' || !this.game || typeof this.game[method] !== 'function') {
      return { error: 'Недоступно сейчас' };
    }
    const res = this.game[method](...args);
    // следующий раунд начинается сам через паузу — никто не жмёт кнопку;
    // если после действия партия завершилась, отражаем это на уровне комнаты
    if (res && res.ok && this.game.finished) this.status = 'finished';
    return res;
  }

  submitClues(playerId, clues) { return this._delegate('submitClues', playerId, clues); }
  updateGuessDraft(playerId, kind, guess) { return this._delegate('updateGuessDraft', playerId, kind, guess); }
  lockGuess(playerId, kind) { return this._delegate('lockGuess', playerId, kind); }
  updateTiebreakGuess(playerId, words) { return this._delegate('updateTiebreakGuess', playerId, words); }
  lockTiebreakGuess(playerId) { return this._delegate('lockTiebreakGuess', playerId); }

  codenamesClue(playerId, word, count) { return this._delegate('giveClue', playerId, word, count); }
  codenamesReveal(playerId, index) { return this._delegate('revealCard', playerId, index); }
  codenamesEndTurn(playerId) { return this._delegate('endTurn', playerId); }

  drawCard(playerId, source) { return this._delegate('drawCard', playerId, source); }
  claimRoute(playerId, routeId, payment) { return this._delegate('claimRoute', playerId, routeId, payment); }
  resolveTunnel(playerId, decision) { return this._delegate('resolveTunnel', playerId, decision); }
  drawTickets(playerId) { return this._delegate('drawTickets', playerId); }
  chooseTickets(playerId, keepIndices) { return this._delegate('chooseTickets', playerId, keepIndices); }
  buildStation(playerId, routeId, payment) { return this._delegate('buildStation', playerId, routeId, payment); }

  nextRound() {
    if (!this.game) return { error: 'Рано' };
    return this.game.nextRound();
  }

  // хост может в любой момент прервать текущую партию — работает одинаково
  // для любого типа игры, т.к. опирается только на общий контракт
  // (finished/winner/winReason), ничего не зная про конкретные правила
  canManagePrivate(playerId) {
    const player = this.players.get(playerId);
    return this.visibility === 'private' && !!player?.connected && !player.left
      && (this.hostId === playerId || (!this.players.get(this.hostId)?.connected && player.role !== 'spectator'));
  }

  canForceEnd(playerId) {
    const player = this.players.get(playerId);
    if (this.status !== 'playing' || !player?.connected || player.left) return false;
    if (this.visibility === 'private' && this.hostId === playerId) return true;
    if (player.role === 'spectator') return false;
    const offlineParticipant = [...this.players.values()].some(p => !p.connected && !p.left && p.role !== 'spectator');
    return offlineParticipant && (this.visibility === 'public' || !this.players.get(this.hostId)?.connected);
  }

  forceEndGame(reason = 'Игра завершена хостом досрочно') {
    if (this.status !== 'playing' || !this.game) return { error: 'Сейчас нет активной игры' };
    this.game.finished = true;
    this.game.winner = 'draw'; // никто не выиграл — партию прервали, а не доиграли до конца
    this.game.winReason = reason;
    this.status = 'finished';
    return { ok: true };
  }

  playAgain() {
    if (this.status !== 'finished' || !this.game) return { error: 'Игра ещё не окончена' };
    // архивируем только что законченную партию, прежде чем стереть её —
    // чтобы к ней можно было вернуться позже через «Прошлые игры»
    this.pastGames.push({
      gameNumber: this.pastGames.length + 1,
      finishedAt: Date.now(),
      gameType: this.gameType,
      winner: this.game.winner,
      winReason: this.game.winReason,
      ...this.game.getArchiveSummary(),
    });
    this.game = null;
    this.status = 'lobby';
    if (this.module?.autoAssignTeams) {
      this.teamOrder = {};
      this.players.forEach(p => { p.team = null; });
    }
    return { ok: true };
  }

  // строит персональное представление состояния для конкретного игрока —
  // общие поля комнаты плюс то, что вернёт текущая игра (если она есть)
  viewFor(playerId) {
    const me = this.players.get(playerId);
    const playersList = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, connected: p.connected, isHost: p.id === this.hostId,
      role: p.role || 'player',
    }));

    const base = {
      code: this.code,
      visibility: this.visibility,
      startDeadline: this.startDeadline,
      inviteToken: this.visibility === 'private' ? this.inviteToken : null,
      status: this.status,
      gameType: this.gameType,
      availableGameTypes: GAME_LIST,
      chat: this.chat,
      chatRead: this.chatRead,
      pastGames: this.pastGames,
      players: playersList,
      hostId: this.hostId,
      me: me ? { id: me.id, name: me.name, team: me.team, isHost: me.id === this.hostId, role: me.role || 'player' } : null,
      canStart: this.status === 'lobby' ? this.canStart() : false,
      canForceEnd: this.canForceEnd(playerId),
      canRestart: this.status === 'finished' && this.canManagePrivate(playerId),
      canLeaveSafely: this.canPlayerLeaveSafely(playerId),
    };

    const gameView = this.game ? this.game.viewFor(playerId) : { teamView: null };
    return { ...base, ...gameView };
  }

  // сериализация для сохранения на диск (JSON.stringify сам вызовет этот
  // метод) — players и usedWords переводим в обычные массивы
  toJSON() {
    return {
      code: this.code,
      visibility: this.visibility,
      startDeadline: this.startDeadline,
      inviteToken: this.visibility === 'private' ? this.inviteToken : null,
      createdAt: this.createdAt,
      hostId: this.hostId,
      players: [...this.players.values()],
      status: this.status,
      gameType: this.gameType,
      teamOrder: this.teamOrder,
      usedWords: [...this.usedWords],
      chat: this.chat,
      chatRead: this.chatRead,
      pastGames: this.pastGames,
      game: this.game ? this.game.toJSON() : null,
    };
  }

  // восстановление комнаты из сохранённых данных (после перезапуска сервера)
  static fromData(data) {
    const room = new Room(data.code, data.visibility === 'public' ? 'public' : 'private');
    room.inviteToken = data.inviteToken || room.inviteToken;
    room.createdAt = data.createdAt;
    room.hostId = data.hostId;
    // после перезапуска ни у кого ещё нет живого сокета — все офлайн,
    // пока не переподключатся (клиент делает это автоматически по clientId)
    room.players = new Map((data.players || []).map(p => [p.id, { ...p, connected: false, disconnectedAt: p.connected ? Date.now() : (p.disconnectedAt ?? Date.now()) }]));
    room.status = data.status;
    // отличаем «явно ещё не выбрана» (null, сохранён этой веткой кода) от
    // «поля вообще не было» (комнаты, сохранённые до этой фичи) — иначе
    // null || DEFAULT_GAME_TYPE подставил бы Декодер и обошёл выбор хоста
    room.gameType = data.gameType !== undefined ? data.gameType : DEFAULT_GAME_TYPE;
    room.teamOrder = data.teamOrder || {};
    room.usedWords = new Set(data.usedWords || []);
    room.chat = data.chat || [];
    room.chatRead = data.chatRead || {};
    room.pastGames = data.pastGames || [];
    const Module = GAME_MODULES[room.gameType];
    room.game = (data.game && Module) ? Module.fromData(data.game, room.players, room.teamOrder, room.usedWords) : null;
    return room;
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    for (const data of store.loadAllRoomData()) {
      try {
        const room = Room.fromData(data);
        this.rooms.set(room.code, room);
      } catch (e) {
        console.error('Не удалось восстановить комнату', data && data.code, e);
      }
    }
  }

  createRoom(visibility = 'private', gameType = null) {
    let code;
    do { code = makeRoomCode(); } while (this.rooms.has(code));
    const room = new Room(code, visibility);
    room.gameType = gameType;
    this.rooms.set(code, room);
    return room;
  }

  findPublicRoom(gameType) {
    const module = GAME_MODULES[gameType];
    if (!module) return null;
    const waiting = [...this.rooms.values()]
      .filter(room => room.visibility === 'public' && room.status === 'lobby' && room.gameType === gameType)
      .map(room => ({ room, online: [...room.players.values()].filter(p => p.connected).length }))
      .filter(candidate => candidate.online < module.maxPlayers)
      // Fill an occupied lobby before reusing empty ones; stable ties keep arrivals together.
      .sort((a, b) => b.online - a.online || a.room.createdAt - b.room.createdAt
        || a.room.code.localeCompare(b.room.code));
    return waiting[0]?.room || null;
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  save(room) {
    store.saveRoom(room);
  }

  // краткая сводка по ВСЕМ когда-либо созданным комнатам (не только
  // активным сейчас) — комнаты больше не удаляются, чтобы историю можно
  // было посмотреть на экране входа
  listSummaries() {
    return [...this.rooms.values()]
      .filter(room => room.visibility === 'public' && room.status === 'lobby')
      .map(room => ({
        code: room.code,
        status: room.status,
        round: room.game ? room.game.round : 0,
        playerCount: room.players.size,
        hostName: room.players.get(room.hostId)?.name || null,
        createdAt: room.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = { Room, RoomManager, GAME_LIST };
