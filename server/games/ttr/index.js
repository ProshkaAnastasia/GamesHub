// Модуль игры «Ticket to Ride» — самодостаточный, как ./decoder. В отличие
// от Декодера здесь нет команд: каждый игрок сам за себя, поэтому
// teamKeys: [] и Room-овский teamOrder этим модулем не используется вообще —
// свою очередность хода и состояние по каждому игроку модуль ведёт сам.
//
// Контракт для Room (см. ../../game.js):
//   id, label, teamKeys, canStart(teamOrder, players), startRequirementText,
//   create(players, teamOrder, usedWords), fromData(data, players, teamOrder, usedWords)
// и интерфейс экземпляра: claimRoute/drawCard/resolveTunnel/drawTickets/
// chooseTickets/canPlayerLeaveSafely/viewFor/toJSON/getArchiveSummary/
// finished/winner/winReason.
const { CITIES, ROUTES } = require('./map');
const { TICKETS } = require('./tickets');
const rules = require('./rules');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const PLAYER_COLORS = ['red', 'blue', 'green', 'yellow', 'black'];

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
    this.playerIds = [...players.keys()];
    this.playerColor = {};
    this.playerIds.forEach((id, i) => { this.playerColor[id] = PLAYER_COLORS[i % PLAYER_COLORS.length]; });

    this.hands = {}; // playerId -> {color: count}
    this.trainsLeft = {}; // playerId -> number
    this.score = {}; // playerId -> number
    this.ownedRoutes = {}; // playerId -> Set<routeId>
    this.routeOwner = {}; // routeId -> playerId (обратный индекс для быстрой проверки занятости)
    this.pendingInitialTickets = {}; // playerId -> [ticket,...] пока не подтвердил выбор
    this.keptTickets = {}; // playerId -> [ticket,...]

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
      this.ownedRoutes[id] = new Set();
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
    });
  }

  static canStart(_teamOrder, players) {
    const count = players ? players.size : 0;
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
    return game;
  }

  toJSON() {
    return {
      playerIds: this.playerIds,
      playerColor: this.playerColor,
      hands: this.hands,
      trainsLeft: this.trainsLeft,
      score: this.score,
      ownedRoutes: Object.fromEntries(
        Object.entries(this.ownedRoutes).map(([pid, set]) => [pid, [...set]])
      ),
      routeOwner: this.routeOwner,
      pendingInitialTickets: this.pendingInitialTickets,
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

    // билеты: выполненные — плюс очки, невыполненные — минус
    this.playerIds.forEach((pid) => {
      (this.keptTickets[pid] || []).forEach((t) => {
        const ok = rules.ticketFulfilled(t, this.ownedRoutes[pid]);
        this.score[pid] += ok ? t.points : -t.points;
      });
    });

    // бонус за самый длинный путь
    let bestPid = null;
    let bestLen = -1;
    this.playerIds.forEach((pid) => {
      const len = rules.longestPath(this.ownedRoutes[pid]);
      if (len > bestLen) { bestLen = len; bestPid = pid; }
    });
    if (bestPid) this.score[bestPid] += 10;

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
        return { ok: true, tunnel: { revealed, extraNeeded: 0, autoResolved: true } };
      }
      this.pendingTunnel = { playerId, routeId, payment, colorUsed: check.colorUsed, extraNeeded, revealed };
      return { ok: true, tunnel: { revealed, extraNeeded, autoResolved: false } };
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

  _commitRouteClaim(playerId, route, payment) {
    const hand = this.hands[playerId];
    Object.entries(payment).forEach(([color, n]) => {
      hand[color] -= n;
      this.discard.push(...Array(n).fill(color));
    });

    this.routeOwner[route.id] = playerId;
    this.ownedRoutes[playerId].add(route.id);
    this.trainsLeft[playerId] -= route.length;
    this.score[playerId] += rules.SCORE_TABLE[route.length] || 0;

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

    const isInitialPhase = this.phase === 'initial-tickets';
    const minKeep = isInitialPhase ? 2 : 1;
    const indices = [...new Set(keepIndices || [])].filter((i) => i >= 0 && i < pending.length);
    if (indices.length < minKeep) return { error: `Нужно оставить минимум ${minKeep}` };

    const kept = indices.map((i) => pending[i]);
    const returned = pending.filter((_, i) => !indices.includes(i));
    // длинный билет — разовый шанс: если его отклонили, он не возвращается
    // в колоду добора, а просто выпадает из игры насовсем
    this.ticketDeck.push(...returned.filter((t) => !t.long));

    this.keptTickets[playerId] = [...(this.keptTickets[playerId] || []), ...kept];
    delete this.pendingInitialTickets[playerId];

    if (isInitialPhase) {
      const stillWaiting = this.playerIds.some((id) => this.pendingInitialTickets[id]);
      if (!stillWaiting) {
        this.phase = 'playing';
        this.currentPlayerIndex = 0;
      }
      return { ok: true };
    }

    // обычный ход — взятие билетов было единственным действием за ход
    this.advanceTurn();
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
        handSize: Object.values(this.hands[id]).reduce((a, b) => a + b, 0),
        ticketCount: (this.keptTickets[id] || []).length,
      })),
      faceUp: this.faceUp,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      ticketDeckCount: this.ticketDeck.length,
      routeOwner: this.routeOwner, // routeId -> playerId, клиент красит по этому + playerColor выше
      winner: this.winner,
      winReason: this.winReason,
      // пока не выбрали билеты вообще все — фаза не переходит в 'playing'
      // (см. chooseTickets); список нужен клиенту, чтобы показать явный
      // экран ожидания вместо игрового поля, которое выглядит как начатое
      awaitingInitialTickets: this.phase === 'initial-tickets'
        ? this.playerIds.filter((id) => this.pendingInitialTickets[id])
        : [],
    };

    // маршруты, которые прямо сейчас реально соединяют города одного из
    // МОИХ билетов через МОЮ собственную сеть — клиент красит их отдельным
    // цветом (билет выполнен), а не обычным цветом владения. Билеты чужие
    // не знаем — считаем только для запрашивающего игрока (это приватность,
    // не публичное поле base)
    const myFulfilledTicketRouteIds = new Set();
    (this.keptTickets[playerId] || []).forEach((ticket) => {
      const path = rules.ticketConnectingRoutes(ticket, this.ownedRoutes[playerId] || new Set());
      if (path) path.forEach((routeId) => myFulfilledTicketRouteIds.add(routeId));
    });

    return {
      ...base,
      myHand: this.hands[playerId],
      myTickets: this.keptTickets[playerId] || [],
      myPendingTickets: this.pendingInitialTickets[playerId] || null,
      myPendingTicketsMinKeep: this.phase === 'initial-tickets' ? 2 : 1,
      myFulfilledTicketRouteIds: [...myFulfilledTicketRouteIds],
      pendingTunnel: (this.pendingTunnel && this.pendingTunnel.playerId === playerId) ? this.pendingTunnel : null,
    };
  }
}

module.exports = {
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
