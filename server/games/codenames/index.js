// Standalone Codenames rules. Only viewFor exposes data to clients.
const { WORDS, shuffle } = require('../decoder/words');
const DuetGame = require('./duet');
const TEAMS = ['A', 'B'];
const other = team => team === 'A' ? 'B' : 'A';
const normalize = word => word.toLocaleLowerCase('ru').replaceAll('ё', 'е');

class CodenamesGame {
  constructor(players, teamOrder) {
    this.players = players;
    this.teamOrder = teamOrder;
    this.captains = { A: teamOrder.A[0], B: teamOrder.B[0] };
    this.activeTeam = shuffle(TEAMS)[0];
    this.startingTeam = this.activeTeam;
    this.round = 1;
    this.phase = 'clue';
    this.clue = null;
    this.guessesLeft = 0;
    this.guessesMade = 0;
    this.turns = [];
    this.finished = false;
    this.winner = null;
    this.winReason = null;
    this.board = [];
  }
  static canStart(_order, players) {
    const n = [...(players?.values() || [])].filter(p => p.connected).length;
    return n >= 2 && n <= 8;
  }
  static assignTeams(players) {
    const ids = shuffle([...players.values()].filter(p => p.connected).map(p => p.id));
    const order = { A: ids.slice(0, Math.ceil(ids.length / 2)), B: ids.slice(Math.ceil(ids.length / 2)) };
    for (const p of players.values()) p.team = TEAMS.find(t => order[t].includes(p.id)) || null;
    return order;
  }
  static create(players, order, usedWords) {
    if (order.A.length + order.B.length <= 3) return DuetGame.create(players, order, usedWords);
    const game = new CodenamesGame(players, order);
    const pool = [...new Set(WORDS)];
    if (pool.filter(word => !usedWords.has(word)).length < 25) usedWords.clear();
    const words = shuffle(pool.filter(word => !usedWords.has(word))).slice(0, 25);
    const kinds = shuffle([...Array(9).fill(game.startingTeam), ...Array(8).fill(other(game.startingTeam)), ...Array(7).fill('neutral'), 'assassin']);
    game.board = words.map((word, index) => ({ word, kind: kinds[index], revealed: false }));
    words.forEach(word => usedWords.add(word));
    return game;
  }
  static fromData(data, players, order) {
    if (data.mode === 'duet') return DuetGame.fromData(data, players, order);
    const game = new CodenamesGame(players, order);
    for (const key of ['captains', 'activeTeam', 'startingTeam', 'round', 'phase', 'clue', 'guessesLeft', 'guessesMade', 'turns', 'finished', 'winner', 'winReason', 'board']) game[key] = data[key];
    return game;
  }
  toJSON() {
    const { players, teamOrder, ...data } = this;
    return data;
  }
  remaining(team) { return this.board.filter(card => card.kind === team && !card.revealed).length; }
  isOperative(playerId) {
    const p = this.players.get(playerId);
    return p?.connected && p.role !== 'spectator' && p.team === this.activeTeam
      && this.teamOrder[this.activeTeam].includes(playerId) && this.captains[this.activeTeam] !== playerId;
  }
  giveClue(playerId, word, count) {
    if (this.finished || this.phase !== 'clue') return { error: 'Сейчас не время подсказки' };
    if (this.captains[this.activeTeam] !== playerId || !this.players.get(playerId)?.connected) return { error: 'Подсказку даёт капитан команды, чей ход' };
    if (typeof word !== 'string' || !/^[\p{L}]+(?:-[\p{L}]+)*$/u.test(word.trim()) || word.trim().length > 40) return { error: 'Введите одно слово без цифр и пробелов' };
    if (!(count === 'unlimited' || (Number.isInteger(count) && count >= 0 && count <= 9))) return { error: 'Укажите число от 0 до 9 или ∞' };
    if (this.board.some(card => !card.revealed && normalize(card.word).split('-').some(part => normalize(word.trim()) === part))) return { error: 'Нельзя использовать неоткрытое слово с поля' };
    this.clue = { word: word.trim(), count };
    this.guessesLeft = count === 0 || count === 'unlimited' ? 25 : count + 1;
    this.guessesMade = 0;
    this.phase = 'guessing';
    this.turns.push({ round: this.round, team: this.activeTeam, clue: this.clue, picks: [] });
    return { ok: true };
  }
  revealCard(playerId, index) {
    if (this.finished || this.phase !== 'guessing' || !this.isOperative(playerId)) return { error: 'Карточки открывают агенты активной команды' };
    if (!Number.isInteger(index) || index < 0 || index >= this.board.length || this.board[index].revealed) return { error: 'Выберите неоткрытую карточку' };
    const card = this.board[index];
    card.revealed = true;
    this.guessesMade++;
    this.guessesLeft--;
    this.turns[this.turns.length - 1].picks.push({ index, word: card.word, kind: card.kind, playerId });
    if (card.kind === 'assassin') this.finish(other(this.activeTeam), 'Открыт убийца');
    else {
      const winner = TEAMS.find(team => this.remaining(team) === 0);
      if (winner) this.finish(winner, 'Найдены все агенты команды');
      else if (card.kind !== this.activeTeam || this.guessesLeft === 0) this.advanceTurn();
    }
    return { ok: true };
  }
  endTurn(playerId) {
    if (this.finished || this.phase !== 'guessing' || !this.isOperative(playerId)) return { error: 'Ход завершает агент активной команды' };
    if (this.guessesMade < 1) return { error: 'Нужно открыть хотя бы одну карточку' };
    this.advanceTurn();
    return { ok: true };
  }
  advanceTurn() {
    this.activeTeam = other(this.activeTeam);
    this.round++;
    this.phase = 'clue';
    this.clue = null;
    this.guessesLeft = 0;
    this.guessesMade = 0;
  }
  finish(winner, reason) {
    this.finished = true;
    this.phase = 'finished';
    this.winner = winner;
    this.winReason = `${reason}. Победила команда ${winner === 'A' ? 'А' : 'Б'}`;
  }
  getArchiveSummary() {
    return { codenames: { board: this.board, captains: this.captains, turns: this.turns, startingTeam: this.startingTeam } };
  }
  viewFor(playerId) {
    const p = this.players.get(playerId);
    const captain = TEAMS.some(team => this.captains[team] === playerId) && p?.role !== 'spectator';
    return {
      round: this.round, phase: this.phase, winner: this.winner, winReason: this.winReason,
      codenames: {
        board: this.board.map(card => ({ word: card.word, revealed: card.revealed, kind: card.revealed || captain || this.finished ? card.kind : null })),
        captains: this.captains, activeTeam: this.activeTeam, startingTeam: this.startingTeam,
        isCaptain: captain, remaining: { A: this.remaining('A'), B: this.remaining('B') },
        clue: this.clue, guessesLeft: this.guessesLeft, turns: this.turns,
        canGiveClue: !this.finished && this.phase === 'clue' && this.captains[this.activeTeam] === playerId,
        canGuess: !this.finished && this.phase === 'guessing' && !!this.isOperative(playerId),
        canEndTurn: !this.finished && this.phase === 'guessing' && this.guessesMade > 0 && !!this.isOperative(playerId),
      },
    };
  }
}
module.exports = { id: 'codenames', label: 'Codenames', teamKeys: TEAMS, autoAssignTeams: true,
  minPlayers: 2, maxPlayers: 8, startRequirementText: 'От 2 до 8 игроков: 2–3 — кооперативный «Дуэт», 4–8 — обычный Codenames.',
  canStart: CodenamesGame.canStart, assignTeams: CodenamesGame.assignTeams,
  create: CodenamesGame.create, fromData: CodenamesGame.fromData };
