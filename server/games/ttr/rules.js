// Правила Ticket to Ride, не зависящие от состояния конкретной партии —
// чистые функции над данными (карта из ./map.js, колода, оплата).
const { ROUTES } = require('./map');

const TRAIN_COLORS = ['pink', 'white', 'blue', 'yellow', 'orange', 'black', 'red', 'green'];
const LOCOMOTIVE = 'locomotive';

// очки за длину построенного маршрута (карта Европы: маршруты длиной 1..8)
const SCORE_TABLE = { 1: 1, 2: 2, 3: 4, 4: 7, 5: 10, 6: 15, 7: 18, 8: 21 };

const TRAINS_PER_PLAYER = 45;
const HAND_SIZE_INITIAL = 4;
const FACE_UP_COUNT = 5;
const END_GAME_TRAIN_THRESHOLD = 2; // <=2 вагончиков у игрока — начинается финальный круг

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// стандартная колода вагонных карт: по 12 карт каждого из 8 цветов + 14 локомотивов = 110
function buildTrainDeck() {
  const deck = [];
  TRAIN_COLORS.forEach((color) => {
    for (let i = 0; i < 12; i++) deck.push(color);
  });
  for (let i = 0; i < 14; i++) deck.push(LOCOMOTIVE);
  return shuffle(deck);
}

function routeById(routeId) {
  return ROUTES.find((r) => r.id === routeId) || null;
}

// payment: { [color]: count } — карты, которые игрок предлагает потратить
// (locomotive — тоже просто один из ключей). Возвращает { ok, colorUsed } или { error }.
function validatePayment(route, payment) {
  const entries = Object.entries(payment || {}).filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total !== route.length) {
    return { error: `Нужно ровно ${route.length} карт(ы), выбрано ${total}` };
  }

  const nonLoco = entries.filter(([color]) => color !== LOCOMOTIVE);
  const locoCount = payment[LOCOMOTIVE] || 0;

  if (nonLoco.length > 1) {
    return { error: 'Можно платить только одним цветом (плюс любое число локомотивов)' };
  }
  const colorUsed = nonLoco.length ? nonLoco[0][0] : LOCOMOTIVE;

  if (route.color !== 'gray' && nonLoco.length && nonLoco[0][0] !== route.color) {
    return { error: `Этот маршрут требует цвет ${route.color}` };
  }
  if (!TRAIN_COLORS.includes(colorUsed) && colorUsed !== LOCOMOTIVE) {
    return { error: 'Неизвестный цвет карты' };
  }
  if (route.ferry && locoCount < route.ferry) {
    return { error: `Этот маршрут — паром: нужно минимум ${route.ferry} карт(ы)-локомотива` };
  }

  return { ok: true, colorUsed };
}

// сколько из карт руки игрока есть каждого цвета — для проверки "хватает ли карт"
// перед тем как вообще показывать маршрут доступным для покупки на клиенте
function canAffordAnyPayment(route, hand) {
  const loco = hand[LOCOMOTIVE] || 0;
  if (route.color !== 'gray') {
    const have = (hand[route.color] || 0) + loco;
    return have >= route.length && loco >= route.ferry;
  }
  // серый маршрут — подходит любой цвет, где хватает карт с учётом локомотивов
  return TRAIN_COLORS.some((color) => {
    const have = (hand[color] || 0) + loco;
    return have >= route.length && loco >= route.ferry;
  });
}

// туннель: три верхних карты колоды; каждая, совпадающая с colorUsed (или
// являющаяся локомотивом), требует доплаты ещё одной такой же картой
function resolveTunnelDraw(deck, colorUsed) {
  const revealed = deck.splice(0, Math.min(3, deck.length));
  const extraNeeded = revealed.filter((c) => c === colorUsed || c === LOCOMOTIVE).length;
  return { revealed, extraNeeded };
}

// есть ли путь между двумя городами, используя только маршруты из ownedRouteIds
function ticketFulfilled(ticket, ownedRouteIds) {
  const owned = ROUTES.filter((r) => ownedRouteIds.has(r.id));
  const adj = new Map();
  owned.forEach((r) => {
    if (!adj.has(r.from)) adj.set(r.from, []);
    if (!adj.has(r.to)) adj.set(r.to, []);
    adj.get(r.from).push(r.to);
    adj.get(r.to).push(r.from);
  });
  const seen = new Set([ticket.from]);
  const stack = [ticket.from];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === ticket.to) return true;
    for (const next of adj.get(cur) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

// самый длинный непрерывный путь вагончиков одного игрока (для бонуса +10) —
// полный перебор простых путей по собственному графу; граф игрока — это
// малая часть всей карты (до ~40 рёбер), полный DFS-перебор тут не проблема
function longestPath(ownedRouteIds) {
  const owned = ROUTES.filter((r) => ownedRouteIds.has(r.id));
  const adj = new Map();
  owned.forEach((r, idx) => {
    if (!adj.has(r.from)) adj.set(r.from, []);
    if (!adj.has(r.to)) adj.set(r.to, []);
    adj.get(r.from).push({ to: r.to, edge: idx, len: r.length });
    adj.get(r.to).push({ to: r.from, edge: idx, len: r.length });
  });

  let best = 0;
  const nodes = [...adj.keys()];

  function dfs(node, usedEdges, length) {
    best = Math.max(best, length);
    for (const { to, edge, len } of adj.get(node) || []) {
      if (usedEdges.has(edge)) continue;
      usedEdges.add(edge);
      dfs(to, usedEdges, length + len);
      usedEdges.delete(edge);
    }
  }

  nodes.forEach((start) => dfs(start, new Set(), 0));
  return best;
}

module.exports = {
  TRAIN_COLORS,
  LOCOMOTIVE,
  SCORE_TABLE,
  TRAINS_PER_PLAYER,
  HAND_SIZE_INITIAL,
  FACE_UP_COUNT,
  END_GAME_TRAIN_THRESHOLD,
  shuffle,
  buildTrainDeck,
  routeById,
  validatePayment,
  canAffordAnyPayment,
  resolveTunnelDraw,
  ticketFulfilled,
  longestPath,
};
