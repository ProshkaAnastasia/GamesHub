// Модуль игры «Ticket to Ride» — самодостаточный, как ./decoder. В отличие
// от Декодера здесь нет команд: каждый игрок сам за себя, поэтому
// teamKeys: [] и Room-овский teamOrder этим модулем не используется вообще —
// свою очередность хода и состояние по каждому игроку модуль ведёт сам.
//
// Контракт для Room (см. ../../game.js):
//   id, label, teamKeys, canStart(teamOrder, players), startRequirementText,
//   create(players, teamOrder, usedWords), fromData(data, players, teamOrder, usedWords)
// и интерфейс экземпляра: claimRoute/drawCard/resolveTunnel/drawTickets/
// chooseTickets/buildStation/canPlayerLeaveSafely/viewFor/toJSON/
// getArchiveSummary/finished/winner/winReason.
const { CITIES, ROUTES } = require('./map');
const { TICKETS } = require('./tickets');
const rules = require('./rules');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const PLAYER_COLORS = ['red', 'blue', 'green', 'yellow', 'black'];
// ⚠️ станции — по памяти о правилах Ticket to Ride Europe, не сверено с
// оригиналом (как и штрафные очки ниже) — стоит перепроверить перед тем,
// как полагаться на точные цифры
const STATIONS_PER_PLAYER = 3;
const STATION_UNUSED_PENALTY = 4; // очков вычитается в конце игры за каждую неиспользованную станцию

function emptyHand() {
  const hand = { [rules.LOCOMOTIVE]: 0 };
  rules.TRAIN_COLORS.forEach((c) => { hand[c] = 0; });
  return hand;
}

function addToHand(hand, color, n = 1) {
  hand[color] = (hand[color] || 0) + n;
}

class TicketToRideGame {
  constructor(players) {
    // players — общая ссылка на Map из Room, не копия (как и у Декодера)
    this.players = players;
    this.playerIds = [...players.values()].filter(p => p.connected).map(p => p.id);
    this.playerColor = {};
    this.playerIds.forEach((id, i) => { this.playerColor[id] = PLAYER_COLORS[i % PLAYER_COLORS.length]; });

    this.hands = {}; // playerId -> {color: count}
    this.trainsLeft = {}; // playerId -> number
    this.score = {}; // playerId -> number
    // playerId -> [{type, points, ts, ...}] — журнал начисления/списания
    // очков для итогового разбора "когда и за что" на экране конца игры.
    // type: 'route' (routeId), 'ticket' (from,to,fulfilled), 'longest-path',
    // 'station-penalty' (count)
    this.scoreLog = {};
    this.ownedRoutes = {}; // playerId -> Set<routeId>
    this.routeOwner = {}; // routeId -> playerId (обратный индекс для быстрой проверки занятости)
    this.pendingInitialTickets = {}; // playerId -> [ticket,...] пока не подтвердил выбор
    // playerId'ы, чья текущая запись в pendingInitialTickets — именно
    // СТАРТОВАЯ раздача (минимум 2 билета, подтверждение не тратит ход), а
    // не обычный добор в свой ход (минимум 1, подтверждение = конец хода).
    // В момент старта партии это все playerIds разом (см. ниже), а дальше —
    // только те, кто присоединился к уже идущей игре (см. addPlayer): для
    // них this.phase уже 'playing', глобальный признак фазы не подходит
    this.initialDealPending = new Set();
    this.keptTickets = {}; // playerId -> [ticket,...]
    this.stationsLeft = {}; // playerId -> number, стартуют с STATIONS_PER_PLAYER
    // playerId -> Set<routeId> — ЧУЖИЕ маршруты, разблокированные станциями
    // этого игрока: считаются связанными для проверки ЕГО билетов, но не
    // приносят очков за длину и не участвуют в бонусе "самый длинный путь"
    this.stationLinks = {};

    this.deck = rules.buildTrainDeck();
    this.discard = [];
    this.faceUp = [];
    // длинные маршруты — отдельная колода, гарантированно попадает по одной
    // штуке в стартовую тройку каждого игрока (см. ниже), но внешне никак
    // не помечается — игрок не должен видеть, что это "особый" билет.
    // Колода для добора билетов по ходу игры (this.ticketDeck) — всегда
    // только обычные; длинные туда никогда не подмешиваются и не
    // возвращаются, даже если игрок отказался от своего длинного при выборе
    // стартовой тройки — это разовый шанс без права переигровки
    this.ticketDeck = rules.shuffle(TICKETS.filter((t) => !t.long));
    this.longTicketDeck = rules.shuffle(TICKETS.filter((t) => t.long));

    this.playerIds.forEach((id) => {
      this.hands[id] = emptyHand();
      this.trainsLeft[id] = rules.TRAINS_PER_PLAYER;
      this.score[id] = 0;
      this.scoreLog[id] = [];
      this.ownedRoutes[id] = new Set();
      this.stationsLeft[id] = STATIONS_PER_PLAYER;
      this.stationLinks[id] = new Set();
      // стартовая рука по правилам — HAND_SIZE_INITIAL вагонных карт из колоды
      for (let i = 0; i < rules.HAND_SIZE_INITIAL; i++) addToHand(this.hands[id], this.deck.pop());
    });

    this.currentPlayerIndex = 0;
    this.phase = 'initial-tickets'; // initial-tickets | playing | final-round | finished
    this.pendingTunnel = null; // {playerId, routeId, payment, colorUsed, extraNeeded, revealed}
    this.finalRoundTriggeredBy = null;
    this.finalRoundRemaining = null; // очередь тех, кому ещё положен последний ход

    this.finished = false;
    this.winner = null;
    this.winReason = null;

    this.refillFaceUp();
    this.playerIds.forEach((id) => {
      // гарантируем ровно 1 длинный билет в стартовой тройке (длинных ровно
      // 6 в наборе — на 2-5 игроков всегда хватает по одному); порядок карт
      // перемешиваем, чтобы позиция в тройке не выдавала, какая из них длинная
      const initial = this.longTicketDeck.length ? [this.longTicketDeck.shift()] : [];
      initial.push(...this.ticketDeck.splice(0, 3 - initial.length));
      this.pendingInitialTickets[id] = rules.shuffle(initial);
      this.initialDealPending.add(id);
    });
  }

  static canStart(_teamOrder, players) {
    const count = [...(players?.values() || [])].filter(p => p.connected).length;
    return count >= MIN_PLAYERS && count <= MAX_PLAYERS;
  }

  static create(players) {
    return new TicketToRideGame(players);
  }

  static fromData(data, players) {
    const game = new TicketToRideGame(players);
    Object.assign(game, data);
    // Set нельзя сохранить в JSON как есть — на диске это были массивы
    game.ownedRoutes = {};
    Object.entries(data.ownedRoutes || {}).forEach(([pid, arr]) => {
      game.ownedRoutes[pid] = new Set(arr);
    });
    game.stationLinks = {};
    Object.entries(data.stationLinks || {}).forEach(([pid, arr]) => {
      game.stationLinks[pid] = new Set(arr);
    });
    game.initialDealPending = new Set(data.initialDealPending || []);
    return game;
  }

  toJSON() {
    return {
      playerIds: this.playerIds,
      playerColor: this.playerColor,
      hands: this.hands,
      trainsLeft: this.trainsLeft,
      score: this.score,
      scoreLog: this.scoreLog,
      ownedRoutes: Object.fromEntries(
        Object.entries(this.ownedRoutes).map(([pid, set]) => [pid, [...set]])
      ),
      stationsLeft: this.stationsLeft,
      stationLinks: Object.fromEntries(
        Object.entries(this.stationLinks).map(([pid, set]) => [pid, [...set]])
      ),
      routeOwner: this.routeOwner,
      pendingInitialTickets: this.pendingInitialTickets,
      initialDealPending: [...this.initialDealPending],
      keptTickets: this.keptTickets,
      deck: this.deck,
      discard: this.discard,
      faceUp: this.faceUp,
      ticketDeck: this.ticketDeck,
      longTicketDeck: this.longTicketDeck,
      currentPlayerIndex: this.currentPlayerIndex,
      phase: this.phase,
      pendingTunnel: this.pendingTunnel,
      finalRoundTriggeredBy: this.finalRoundTriggeredBy,
      finalRoundRemaining: this.finalRoundRemaining,
      finished: this.finished,
      winner: this.winner,
      winReason: this.winReason,
    };
  }

  // --- вспомогательное ---

  currentPlayerId() {
    return this.playerIds[this.currentPlayerIndex];
  }

  refillFaceUp() {
    while (this.faceUp.length < rules.FACE_UP_COUNT) {
      if (!this.deck.length) this.reshuffleDiscardIntoDeck();
      if (!this.deck.length) break; // карт нигде больше нет — редкий случай, оставляем как есть
      this.faceUp.push(this.deck.pop());
    }
    // если среди открытых 3+ локомотива — весь ряд сбрасываем и тянем заново
    const locoCount = this.faceUp.filter((c) => c === rules.LOCOMOTIVE).length;
    if (locoCount >= 3 && this.deck.length + this.discard.length >= rules.FACE_UP_COUNT) {
      this.discard.push(...this.faceUp);
      this.faceUp = [];
      this.refillFaceUp();
    }
  }

  reshuffleDiscardIntoDeck() {
    this.deck = rules.shuffle(this.discard);
    this.discard = [];
  }

  advanceTurn() {
    this.pendingTunnel = null;
    if (this.phase === 'final-round') {
      this.finalRoundRemaining.shift();
      if (!this.finalRoundRemaining.length) {
        this.finishGame();
        return;
      }
    }
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.playerIds.length;
    if (this.phase === 'playing' && this.trainsLeft[this.currentPlayerId()] <= rules.END_GAME_TRAIN_THRESHOLD
        && !this.finalRoundTriggeredBy) {
      // у игрока в начале его хода осталось мало вагончиков — включаем
      // финальный круг: каждый (включая его самого) получает ровно один
      // последний ход, дальше игра завершается
      this.finalRoundTriggeredBy = this.currentPlayerId();
      this.phase = 'final-round';
      const startIdx = this.currentPlayerIndex;
      this.finalRoundRemaining = this.playerIds.map((_, i) => this.playerIds[(startIdx + i) % this.playerIds.length]);
    }
  }

  finishGame() {
    this.phase = 'finished';
    this.finished = true;

    // билеты: выполненные — плюс очки, невыполненные — минус. Станции
    // считаются связностью наравне со своими маршрутами (см. stationLinks),
    // но НЕ участвуют в бонусе за длинный путь ниже — это отдельно от
    // билетов, только настоящие построенные маршруты
    this.playerIds.forEach((pid) => {
      const connected = new Set([...(this.ownedRoutes[pid] || []), ...(this.stationLinks[pid] || [])]);
      (this.keptTickets[pid] || []).forEach((t) => {
        const ok = rules.ticketFulfilled(t, connected);
        const pts = ok ? t.points : -t.points;
        this.score[pid] += pts;
        this.scoreLog[pid].push({ type: 'ticket', from: t.from, to: t.to, fulfilled: ok, points: pts, ts: Date.now() });
      });
      // штраф за неиспользованные станции
      const unusedStations = this.stationsLeft[pid] || 0;
      if (unusedStations > 0) {
        const penalty = STATION_UNUSED_PENALTY * unusedStations;
        this.score[pid] -= penalty;
        this.scoreLog[pid].push({ type: 'station-penalty', count: unusedStations, points: -penalty, ts: Date.now() });
      }
    });

    // бонус за самый длинный путь — только реально построенные маршруты
    let bestPid = null;
    let bestLen = -1;
    this.playerIds.forEach((pid) => {
      const len = rules.longestPath(this.ownedRoutes[pid]);
      if (len > bestLen) { bestLen = len; bestPid = pid; }
    });
    if (bestPid) {
      this.score[bestPid] += 10;
      this.scoreLog[bestPid].push({ type: 'longest-path', length: bestLen, points: 10, ts: Date.now() });
    }

    let winnerId = null;
    this.playerIds.forEach((pid) => {
      if (winnerId === null || this.score[pid] > this.score[winnerId]) winnerId = pid;
    });
    this.winner = winnerId;
    const name = this.players.get(winnerId)?.name || '?';
    this.winReason = `Победа: ${name} (${this.score[winnerId]} очков), бонус за длинный путь получил(а) ${this.players.get(bestPid)?.name || '?'} (${bestLen})`;
  }

  // --- действия игрока ---

  // тянуть карты — целиком одно действие на весь ход (в отличие от
  // классических правил с двумя отдельными добора): вслепую из колоды даёт
  // сразу 2 карты (не видно, что тянешь — компенсация количеством),
  // открытую карту берёшь ровно одну (видишь цвет заранее — компенсация
  // тем, что второй карты в этот ход уже не будет). Оба варианта сразу
  // заканчивают ход.
  drawCard(playerId, source) {
    if (this.phase !== 'playing' && this.phase !== 'final-round') return { error: 'Сейчас нельзя тянуть карты' };
    if (this.currentPlayerId() !== playerId) return { error: 'Сейчас не ваш ход' };

    const hand = this.hands[playerId];
    if (source === 'deck') {
      const drawn = [];
      for (let i = 0; i < 2; i++) {
        if (!this.deck.length) this.reshuffleDiscardIntoDeck();
        if (!this.deck.length) break; // карт нигде больше нет — редкий случай, берём сколько есть
        drawn.push(this.deck.pop());
      }
      if (!drawn.length) return { error: 'В колоде не осталось карт' };
      drawn.forEach((card) => addToHand(hand, card));
      this.advanceTurn();
      return { ok: true, drawn };
    }

    const idx = Number(source);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.faceUp.length) return { error: 'Неверная карта' };
    const card = this.faceUp[idx];
    this.faceUp.splice(idx, 1);
    this.refillFaceUp();
    addToHand(hand, card);
    this.advanceTurn();
    return { ok: true, drewLocomotive: card === rules.LOCOMOTIVE };
  }

  claimRoute(playerId, routeId, payment) {
    if (this.phase !== 'playing' && this.phase !== 'final-round') return { error: 'Сейчас нельзя строить маршруты' };
    if (this.currentPlayerId() !== playerId) return { error: 'Сейчас не ваш ход' };
    if (this.pendingTunnel) return { error: 'Сначала разрешите ситуацию с туннелем' };
    if (this.routeOwner[routeId]) return { error: 'Маршрут уже занят' };

    const route = rules.routeById(routeId);
    if (!route) return { error: 'Неизвестный маршрут' };
    if (this.trainsLeft[playerId] < route.length) return { error: 'Недостаточно вагончиков' };

    const check = rules.validatePayment(route, payment);
    if (check.error) return check;

    const hand = this.hands[playerId];
    for (const [color, n] of Object.entries(payment)) {
      if ((hand[color] || 0) < n) return { error: `Не хватает карт цвета ${color}` };
    }

    if (route.tunnel) {
      const { revealed, extraNeeded } = rules.resolveTunnelDraw(this.deck, check.colorUsed);
      this.discard.push(...revealed);
      if (extraNeeded === 0) {
        this._commitRouteClaim(playerId, route, payment);
        return { ok: true, tunnel: { revealed, extraNeeded: 0, colorUsed: check.colorUsed, autoResolved: true } };
      }
      this.pendingTunnel = { playerId, routeId, payment, colorUsed: check.colorUsed, extraNeeded, revealed };
      return { ok: true, tunnel: { revealed, extraNeeded, colorUsed: check.colorUsed, autoResolved: false } };
    }

    this._commitRouteClaim(playerId, route, payment);
    return { ok: true };
  }

  // decision: {extraPayment: {color:count}} чтобы доплатить, или null/{} чтобы отказаться
  resolveTunnel(playerId, decision) {
    const pending = this.pendingTunnel;
    if (!pending) return { error: 'Сейчас нет незавершённого туннеля' };
    if (pending.playerId !== playerId) return { error: 'Это не ваш туннель' };

    const route = rules.routeById(pending.routeId);
    const extraPayment = decision && decision.extraPayment;

    if (!extraPayment) {
      // отказ — изначально отложенные карты остаются в руке, ход просто заканчивается
      this.pendingTunnel = null;
      this.advanceTurn();
      return { ok: true, built: false };
    }

    const totalExtra = Object.values(extraPayment).reduce((a, b) => a + b, 0);
    if (totalExtra !== pending.extraNeeded) {
      return { error: `Нужно доплатить ровно ${pending.extraNeeded} карт(ы)` };
    }
    const badColor = Object.keys(extraPayment).some(
      (c) => c !== pending.colorUsed && c !== rules.LOCOMOTIVE
    );
    if (badColor) return { error: `Доплата должна быть цвета ${pending.colorUsed} или локомотивами` };

    const hand = this.hands[playerId];
    const combined = { ...pending.payment };
    Object.entries(extraPayment).forEach(([c, n]) => { combined[c] = (combined[c] || 0) + n; });
    for (const [color, n] of Object.entries(combined)) {
      if ((hand[color] || 0) < n) return { error: `Не хватает карт цвета ${color}` };
    }

    this._commitRouteClaim(playerId, route, combined);
    this.pendingTunnel = null;
    return { ok: true, built: true };
  }

  // станция ставится прямо на уже занятый ЧУЖОЙ маршрут (не на город) —
  // после этого он считается связанным с сетью игрока для его билетов
  // (см. использование stationLinks в finishGame/viewFor), но не приносит
  // очков за длину и не идёт в зачёт бонуса за самый длинный путь. Стоимость
  // растёт с каждой следующей станцией: 1-я — 1 карта одного цвета, 2-я — 2,
  // 3-я — 3 (см. STATIONS_PER_PLAYER)
  buildStation(playerId, routeId, payment) {
    if (this.phase !== 'playing' && this.phase !== 'final-round') return { error: 'Сейчас нельзя строить станцию' };
    if (this.currentPlayerId() !== playerId) return { error: 'Сейчас не ваш ход' };
    if (this.pendingTunnel) return { error: 'Сначала разрешите ситуацию с туннелем' };
    if ((this.stationsLeft[playerId] || 0) <= 0) return { error: 'Станции закончились' };

    const ownerId = this.routeOwner[routeId];
    if (!ownerId) return { error: 'Станцию можно ставить только на уже занятый чужой маршрут' };
    if (ownerId === playerId) return { error: 'Это ваш собственный маршрут' };
    if (this.stationLinks[playerId].has(routeId)) return { error: 'Здесь уже стоит ваша станция' };

    const cost = STATIONS_PER_PLAYER + 1 - this.stationsLeft[playerId]; // 1-я станция стоит 1, 2-я — 2, 3-я — 3
    const entries = Object.entries(payment || {}).filter(([, n]) => n > 0);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    if (total !== cost) return { error: `Нужно ровно ${cost} карт(ы) одного цвета` };
    const nonLoco = entries.filter(([color]) => color !== rules.LOCOMOTIVE);
    if (nonLoco.length > 1) return { error: 'Можно платить только одним цветом (плюс любое число локомотивов)' };

    const hand = this.hands[playerId];
    for (const [color, n] of entries) {
      if ((hand[color] || 0) < n) return { error: `Не хватает карт цвета ${color}` };
    }

    entries.forEach(([color, n]) => {
      hand[color] -= n;
      this.discard.push(...Array(n).fill(color));
    });
    this.stationsLeft[playerId] -= 1;
    this.stationLinks[playerId].add(routeId);
    this.advanceTurn();
    return { ok: true };
  }

  _commitRouteClaim(playerId, route, payment) {
    const hand = this.hands[playerId];
    Object.entries(payment).forEach(([color, n]) => {
      hand[color] -= n;
      this.discard.push(...Array(n).fill(color));
    });

    this.routeOwner[route.id] = playerId;
    this.ownedRoutes[playerId].add(route.id);
    this.trainsLeft[playerId] -= route.length;
    const routePoints = rules.SCORE_TABLE[route.length] || 0;
    this.score[playerId] += routePoints;
    this.scoreLog[playerId].push({ type: 'route', routeId: route.id, points: routePoints, ts: Date.now() });

    this.advanceTurn();
  }

  drawTickets(playerId) {
    if (this.phase !== 'playing' && this.phase !== 'final-round') return { error: 'Сейчас нельзя брать билеты' };
    if (this.currentPlayerId() !== playerId) return { error: 'Сейчас не ваш ход' };
    if (this.pendingInitialTickets[playerId]) return { error: 'Сначала определитесь с начальными билетами' };
    if (this.ticketDeck.length === 0) return { error: 'Билеты закончились' };

    const drawn = this.ticketDeck.splice(0, Math.min(3, this.ticketDeck.length));
    this.pendingInitialTickets[playerId] = drawn; // переиспользуем то же поле-«черновик» и для обычного хода
    this._midGameTicketDraw = true;
    return { ok: true, tickets: drawn };
  }

  // keepIndices — индексы (0..2) внутри отложенного черновика, которые игрок оставляет себе
  chooseTickets(playerId, keepIndices) {
    const pending = this.pendingInitialTickets[playerId];
    if (!pending) return { error: 'Сейчас нечего выбирать' };

    // стартовая раздача (минимум 2, ход не тратится) — либо это общая фаза
    // 'initial-tickets' в начале партии, либо личная стартовая раздача
    // игрока, подключившегося к уже идущей игре (см. addPlayer) —
    // ГЛОБАЛЬНАЯ this.phase у него уже 'playing', одной проверки фазы мало
    const isInitialDeal = this.phase === 'initial-tickets' || this.initialDealPending.has(playerId);
    const minKeep = isInitialDeal ? 2 : 1;
    const indices = [...new Set(keepIndices || [])].filter((i) => i >= 0 && i < pending.length);
    if (indices.length < minKeep) return { error: `Нужно оставить минимум ${minKeep}` };

    const kept = indices.map((i) => pending[i]);
    const returned = pending.filter((_, i) => !indices.includes(i));
    // длинный билет — разовый шанс: если его отклонили, он не возвращается
    // в колоду добора, а просто выпадает из игры насовсем
    this.ticketDeck.push(...returned.filter((t) => !t.long));

    this.keptTickets[playerId] = [...(this.keptTickets[playerId] || []), ...kept];
    delete this.pendingInitialTickets[playerId];
    this.initialDealPending.delete(playerId);

    if (isInitialDeal) {
      // общий переход lobby-старта из 'initial-tickets' в 'playing' —
      // только когда это ДЕЙСТВИТЕЛЬНО общая стартовая фаза, а не личная
      // раздача опоздавшего игрока посреди уже идущей партии
      if (this.phase === 'initial-tickets') {
        const stillWaiting = this.playerIds.some((id) => this.pendingInitialTickets[id]);
        if (!stillWaiting) {
          this.phase = 'playing';
          this.currentPlayerIndex = 0;
        }
      }
      // опоздавший игрок хода ни у кого не отнимает — просто дождётся своей
      // естественной очереди (advanceTurn его не касается)
      return { ok: true };
    }

    // обычный ход — взятие билетов было единственным действием за ход
    this.advanceTurn();
    return { ok: true };
  }

  // подключение живого игрока посреди уже идущей партии (см.
  // Room.joinInProgress в server/game.js) — только пока фаза 'playing'
  // (не 'initial-tickets' — до старта игроков добирают лобби-путём через
  // Room.addPlayer; не 'final-round'/'finished' — усложнило бы очередь
  // последних ходов больше, чем того стоит) и пока есть свободное место.
  // Раздача — тот же код, что в конструкторе для каждого id при старте
  // партии (строки выше), просто для одного нового id вместо forEach
  addPlayer(playerId) {
    if (this.phase !== 'playing') return { error: 'Сейчас нельзя присоединиться игроком' };
    if (this.playerIds.length >= MAX_PLAYERS) return { error: 'Мест не осталось' };
    if (this.playerIds.includes(playerId)) return { error: 'Уже в игре' };

    const usedColors = new Set(Object.values(this.playerColor));
    const color = PLAYER_COLORS.find((c) => !usedColors.has(c));
    if (!color) return { error: 'Не осталось свободных цветов' };
    this.playerColor[playerId] = color;

    this.hands[playerId] = emptyHand();
    this.trainsLeft[playerId] = rules.TRAINS_PER_PLAYER;
    this.score[playerId] = 0;
    this.scoreLog[playerId] = [];
    this.ownedRoutes[playerId] = new Set();
    this.stationsLeft[playerId] = STATIONS_PER_PLAYER;
    this.stationLinks[playerId] = new Set();

    for (let i = 0; i < rules.HAND_SIZE_INITIAL; i++) {
      if (!this.deck.length) this.reshuffleDiscardIntoDeck();
      if (!this.deck.length) break; // карт нигде больше нет — редкий случай, начинает с чем есть
      addToHand(this.hands[playerId], this.deck.pop());
    }

    // та же гарантия "1 длинный в стартовой тройке", что и при старте партии
    const initial = this.longTicketDeck.length ? [this.longTicketDeck.shift()] : [];
    initial.push(...this.ticketDeck.splice(0, 3 - initial.length));
    this.pendingInitialTickets[playerId] = rules.shuffle(initial);
    this.initialDealPending.add(playerId);

    // в конец очереди хода — не сдвигает currentPlayerIndex остальных,
    // получит ход в свою естественную очередь
    this.playerIds.push(playerId);
    return { ok: true };
  }

  canPlayerLeaveSafely(_playerId) {
    // ходовая игра, ждущая конкретного игрока — выход всегда возможен,
    // ход просто пропускать нельзя автоматически (см. общий TODO ниже)
    return { safe: true, reason: null };
  }

  getArchiveSummary() {
    return {
      score: this.score,
      scoreLog: this.scoreLog,
      ownedRoutes: Object.fromEntries(
        Object.entries(this.ownedRoutes).map(([pid, set]) => [pid, [...set]])
      ),
      keptTickets: this.keptTickets,
    };
  }

  viewFor(playerId) {
    const base = {
      phase: this.phase,
      currentPlayerId: this.currentPlayerId(),
      // НЕ "players" — это поле совпадает с ключом верхнего уровня в
      // Room.viewFor() (connected/isHost и т.д.), и {...base, ...gameView}
      // там просто перетёр бы его этими данными
      ttrPlayers: this.playerIds.map((id) => ({
        id,
        name: this.players.get(id)?.name || '?',
        color: this.playerColor[id],
        trainsLeft: this.trainsLeft[id],
        score: this.score[id],
        // разбор "когда и за что" — публичная информация (маршруты и так
        // видны на карте всем, билеты/бонусы раскрываются только в конце
        // игры и не влияют на текущий ход), нужен клиенту для экрана
        // итогов; во время самой игры просто не используется
        scoreLog: this.scoreLog[id],
        handSize: Object.values(this.hands[id]).reduce((a, b) => a + b, 0),
        ticketCount: (this.keptTickets[id] || []).length,
        stationsLeft: this.stationsLeft[id],
      })),
      faceUp: this.faceUp,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      ticketDeckCount: this.ticketDeck.length,
      routeOwner: this.routeOwner, // routeId -> playerId, клиент красит по этому + playerColor выше
      // станции — не секрет, физические жетоны на общей карте; плоский
      // список {routeId, playerId} для отрисовки чёрточек на маршрутах
      stationMarkers: this.playerIds.flatMap((id) => [...this.stationLinks[id]].map((routeId) => ({ routeId, playerId: id }))),
      winner: this.winner,
      winReason: this.winReason,
      // пока не выбрали билеты вообще все — фаза не переходит в 'playing'
      // (см. chooseTickets); список нужен клиенту, чтобы показать явный
      // экран ожидания вместо игрового поля, которое выглядит как начатое
      awaitingInitialTickets: this.phase === 'initial-tickets'
        ? this.playerIds.filter((id) => this.pendingInitialTickets[id])
        : [],
    };

    // выполнен ли билет прямо сейчас (города уже связаны МОЕЙ собственной
    // сетью — включая чужие маршруты, разблокированные моими станциями) —
    // приватно для самого игрока (билеты чужих игроков нам неизвестны),
    // клиент подсвечивает сам билет в списке, а не маршрут на карте —
    // маршрут всегда остаётся окрашен в цвет владельца
    const myConnectedRoutes = new Set([
      ...(this.ownedRoutes[playerId] || []),
      ...(this.stationLinks[playerId] || []),
    ]);
    const myTickets = (this.keptTickets[playerId] || []).map((ticket) => ({
      ...ticket,
      fulfilled: rules.ticketFulfilled(ticket, myConnectedRoutes),
    }));

    return {
      ...base,
      myHand: this.hands[playerId],
      myTickets,
      myPendingTickets: this.pendingInitialTickets[playerId] || null,
      myPendingTicketsMinKeep: (this.phase === 'initial-tickets' || this.initialDealPending.has(playerId)) ? 2 : 1,
      pendingTunnel: (this.pendingTunnel && this.pendingTunnel.playerId === playerId) ? this.pendingTunnel : null,
    };
  }
}

module.exports = {
  minPlayers: MIN_PLAYERS,
  maxPlayers: MAX_PLAYERS,
  id: 'ttr',
  label: 'Ticket to Ride',
  teamKeys: [], // индивидуальная игра, команд нет — Room.setTeam этим модулем не используется
  startRequirementText: `От ${MIN_PLAYERS} до ${MAX_PLAYERS} игроков`,
  CITIES,
  ROUTES,
  canStart: TicketToRideGame.canStart,
  create: TicketToRideGame.create,
  fromData: TicketToRideGame.fromData,
};
