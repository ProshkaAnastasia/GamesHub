const { shuffle } = require('../decoder/words');
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const adjacent = (a, b) => Math.abs(a % 10 - b % 10) <= 1 && Math.abs(Math.floor(a / 10) - Math.floor(b / 10)) <= 1;
function validFleet(ships, complete = false) {
  if (!Array.isArray(ships) || ships.length > 10) return false;
  const remaining = [...FLEET], occupied = [];
  for (const ship of ships) {
    if (!Array.isArray(ship) || !ship.length || ship.some(n => !Number.isInteger(n) || n < 0 || n > 99)) return false;
    const cells = [...ship].sort((a, b) => a - b), length = remaining.indexOf(cells.length);
    if (length < 0 || new Set(cells).size !== cells.length) return false;
    const horizontal = cells.every(n => Math.floor(n / 10) === Math.floor(cells[0] / 10)) && cells.every((n, i) => n === cells[0] + i);
    const vertical = cells.every((n, i) => n === cells[0] + 10 * i);
    if (!horizontal && !vertical || cells.some(n => occupied.some(other => adjacent(n, other)))) return false;
    remaining.splice(length, 1);
    occupied.push(...cells);
  }
  return !complete || !remaining.length;
}
function randomFleet() {
  const ships = [];
  function place(i) {
    if (i === FLEET.length) return true;
    for (const start of shuffle(Array.from({ length: 100 }, (_, n) => n))) {
      for (const step of shuffle([1, 10])) {
        const ship = Array.from({ length: FLEET[i] }, (_, n) => start + n * step);
        if (validFleet([...ships, ship])) {
          ships.push(ship);
          if (place(i + 1)) return true;
          ships.pop();
        }
      }
    }
    return false;
  }
  place(0);
  return ships;
}
class BattleshipGame {
  constructor(players) {
    this.players = players;
    this.playerIds = shuffle([...players.values()].filter(p => p.connected).map(p => p.id));
    this.names = Object.fromEntries(this.playerIds.map(id => [id, players.get(id).name]));
    this.fleets = Object.fromEntries(this.playerIds.map(id => [id, []]));
    this.shots = Object.fromEntries(this.playerIds.map(id => [id, []]));
    this.ready = Object.fromEntries(this.playerIds.map(id => [id, false]));
    this.currentPlayerId = this.playerIds[0];
    this.phase = 'setup';
    this.round = 1;
    this.lastShot = null;
    this.finished = false;
    this.winner = null;
    this.winReason = null;
  }
  static create(players) { return new BattleshipGame(players); }
  static fromData(data, players) {
    const game = Object.create(BattleshipGame.prototype);
    Object.assign(game, data, { players });
    return game;
  }
  toJSON() { const { players, ...data } = this; return data; }
  participant(id) { return this.playerIds.includes(id) && this.players.get(id)?.connected && !this.players.get(id)?.left; }
  opponent(id) { return this.playerIds.find(other => other !== id); }
  canArrange(id) { return !this.finished && this.phase === 'setup' && this.participant(id) && !this.ready[id]; }
  arrange(id, ships) {
    if (!this.canArrange(id)) return { error: 'Расстановка уже завершена или вы наблюдаете за игрой' };
    if (!validFleet(ships)) return { error: 'Корабли должны быть прямыми и не касаться друг друга, даже углами' };
    this.fleets[id] = ships.map(ship => [...ship].sort((a, b) => a - b));
    return { ok: true };
  }
  autoArrange(id) {
    if (!this.canArrange(id)) return { error: 'Сейчас нельзя менять расстановку' };
    return this.arrange(id, randomFleet());
  }
  readyFleet(id) {
    if (!this.canArrange(id)) return { error: 'Сейчас нельзя подтвердить расстановку' };
    if (!validFleet(this.fleets[id], true)) return { error: 'Расставьте все 10 кораблей' };
    this.ready[id] = true;
    if (this.playerIds.every(pid => this.ready[pid])) this.phase = 'battle';
    return { ok: true };
  }
  boardFor(owner, reveal) {
    const attacks = this.shots[this.opponent(owner)], fleet = this.fleets[owner];
    const sunk = fleet.filter(ship => ship.every(n => attacks.includes(n)));
    return Array.from({ length: 100 }, (_, index) => {
      const ship = fleet.find(s => s.includes(index));
      if (attacks.includes(index)) return ship ? sunk.includes(ship) ? 'sunk' : 'hit' : 'miss';
      if (sunk.some(s => s.some(n => adjacent(n, index)))) return 'miss';
      return reveal && ship ? 'ship' : 'water';
    });
  }
  fire(id, index) {
    if (this.finished || this.phase !== 'battle' || !this.participant(id) || id !== this.currentPlayerId) return { error: 'Сейчас не ваш ход' };
    if (!Number.isInteger(index) || index < 0 || index > 99) return { error: 'Выберите клетку поля' };
    const target = this.opponent(id), board = this.boardFor(target, false);
    if (board[index] !== 'water') return { error: 'Эта клетка уже проверена' };
    this.shots[id].push(index);
    const hit = this.fleets[target].some(ship => ship.includes(index));
    this.lastShot = { playerId: id, index, result: this.boardFor(target, false)[index] };
    if (this.fleets[target].every(ship => ship.every(cell => this.shots[id].includes(cell)))) {
      this.finished = true;
      this.phase = 'finished';
      this.winner = id;
      this.winReason = `${this.names[id]} потопил весь флот соперника!`;
    } else if (!hit) this.currentPlayerId = target;
    this.round++;
    return { ok: true };
  }
  publicState(viewer, reveal = this.finished) {
    return {
      lastShot: this.lastShot, playerIds: this.playerIds, names: this.names, ready: this.ready, currentPlayerId: this.currentPlayerId,
      boards: Object.fromEntries(this.playerIds.map(id => [id, this.boardFor(id, reveal || id === viewer)])),
      shipsLeft: Object.fromEntries(this.playerIds.map(id => [id, this.fleets[id].length
        - this.fleets[id].filter(ship => ship.every(n => this.shots[this.opponent(id)].includes(n))).length])),
      // Only the owner's layout is sent during preparation; observers receive none.
      ownFleet: this.playerIds.includes(viewer) ? this.fleets[viewer].map(s => [...s]) : [],
    };
  }
  viewFor(id) {
    return { round: this.round, phase: this.phase, winner: this.winner, winReason: this.winReason,
      battleship: { ...this.publicState(id), canArrange: this.canArrange(id),
        canFire: !this.finished && this.phase === 'battle' && this.participant(id) && this.currentPlayerId === id } };
  }
  getArchiveSummary() { return { battleship: this.publicState(null, true) }; }
}
module.exports = {
  id: 'battleship', label: 'Морской бой', teamKeys: [], minPlayers: 2, maxPlayers: 2,
  startRequirementText: 'Ровно 2 игрока. Поле 10 × 10, классический флот из 10 кораблей.',
  canStart: (_order, players) => [...players.values()].filter(p => p.connected).length === 2,
  create: BattleshipGame.create, fromData: BattleshipGame.fromData, validFleet, randomFleet,
};
