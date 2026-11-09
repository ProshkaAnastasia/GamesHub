const { shuffle } = require('../decoder/words');
const { WORDS } = require('./words');
const SIDES = ['A', 'B'];
const other = side => side === 'A' ? 'B' : 'A';
const normalize = word => word.toLocaleLowerCase('ru').replaceAll('ё', 'е');

class DuetGame {
  constructor(players, teamOrder) {
    this.players = players;
    this.teamOrder = teamOrder;
    this.mode = 'duet';
    this.captains = {};
    this.activeTeam = shuffle(SIDES)[0]; // side giving the clue
    this.startingTeam = this.activeTeam;
    this.round = 1;
    this.phase = 'clue';
    this.clue = null;
    this.guessesMade = 0;
    this.guessesLeft = 25;
    this.tokensLeft = 9;
    this.turns = [];
    this.board = [];
    this.keys = { A: [], B: [] };
    this.finished = false;
    this.winner = null;
    this.winReason = null;
  }
  static create(players, order, usedWords) {
    const game = new DuetGame(players, order);
    const words = [...new Set(WORDS)];
    if (words.filter(word => !usedWords.has(word)).length < 25) usedWords.clear();
    game.board = shuffle(words.filter(word => !usedWords.has(word))).slice(0, 25)
      .map(word => ({ word, found: false, revealed: false, bystanders: { A: false, B: false }, hit: null }));
    game.board.forEach(card => usedWords.add(card.word));
    // Official pair distribution: 3 shared agents; each side's assassins
    // overlap once with an agent, an assassin, and a bystander on the other key.
    const pairs = shuffle([
      ...Array.from({ length: 3 }, () => ['agent', 'agent']),
      ['agent', 'assassin'], ...Array.from({ length: 5 }, () => ['agent', 'neutral']),
      ['assassin', 'agent'], ['assassin', 'assassin'], ['assassin', 'neutral'],
      ...Array.from({ length: 5 }, () => ['neutral', 'agent']),
      ['neutral', 'assassin'], ...Array.from({ length: 7 }, () => ['neutral', 'neutral']),
    ]);
    game.keys = { A: pairs.map(pair => pair[0]), B: pairs.map(pair => pair[1]) };
    return game;
  }
  static fromData(data, players, order) {
    const game = new DuetGame(players, order);
    for (const field of ['activeTeam', 'startingTeam', 'round', 'phase', 'clue', 'guessesMade', 'guessesLeft', 'tokensLeft', 'turns', 'board', 'keys', 'finished', 'winner', 'winReason']) game[field] = data[field];
    return game;
  }
  toJSON() { const { players, teamOrder, ...data } = this; return data; }
  sideOf(id) {
    const player = this.players.get(id);
    return player?.connected && player.role !== 'spectator' && !player.left
      ? SIDES.find(side => this.teamOrder[side].includes(id)) : null;
  }
  remaining(side) { return this.keys[side].filter((kind, i) => kind === 'agent' && !this.board[i].found).length; }
  totalRemaining() { return 15 - this.board.filter(card => card.found).length; }
  canGuess(id) {
    const side = this.sideOf(id);
    return !!side && !this.finished && (this.phase === 'sudden-death'
      ? this.remaining(other(side)) > 0
      : this.phase === 'guessing' && side === other(this.activeTeam));
  }
  giveClue(id, word, count) {
    if (this.finished || this.phase !== 'clue' || this.sideOf(id) !== this.activeTeam) return { error: 'Сейчас подсказывает другая сторона' };
    if (typeof word !== 'string' || word.trim().length > 40 || !/^[\p{L}]+(?:-[\p{L}]+)*$/u.test(word.trim())) return { error: 'Введите одно слово без пробелов и цифр' };
    if (!(count === 'unlimited' || (Number.isInteger(count) && count >= 0 && count <= 9))) return { error: 'Введите число от 0 до 9' };
    if (this.board.some(card => !card.revealed && normalize(card.word).split('-').includes(normalize(word.trim())))) return { error: 'Нельзя использовать неоткрытое слово с поля' };
    this.clue = { word: word.trim(), count };
    this.guessesMade = 0;
    this.guessesLeft = 25;
    this.phase = 'guessing';
    this.turns.push({ round: this.round, team: this.activeTeam, clue: this.clue, picks: [] });
    return { ok: true };
  }
  revealCard(id, index) {
    if (!this.canGuess(id)) return { error: 'Сейчас вы не угадываете' };
    const side = this.sideOf(id);
    const card = this.board[index];
    if (!Number.isInteger(index) || !card || card.revealed || card.bystanders[side]) return { error: 'Эта карточка уже открыта или отмечена для вашей стороны' };
    // Guesses are checked against the PARTNER'S key, never the guesser's.
    const kind = this.keys[other(side)][index];
    this.guessesMade++;
    this.turns[this.turns.length - 1].picks.push({ index, word: card.word, kind, playerId: id, side });
    if (kind === 'agent') {
      card.found = true;
      card.revealed = true;
      if (this.totalRemaining() === 0) this.finish('coop-win', 'Все 15 агентов найдены. Миссия выполнена!');
      else if (this.phase !== 'sudden-death' && this.remaining(this.activeTeam) === 0) this.advanceTurn();
    } else if (kind === 'assassin') {
      card.hit = 'assassin';
      card.revealed = true;
      this.finish('coop-lose', 'Открыт убийца. Миссия провалена для всех.');
    } else {
      card.bystanders[side] = true;
      card.revealed = card.bystanders.A && card.bystanders.B;
      if (this.phase === 'sudden-death') this.finish('coop-lose', 'Ошибка в последнем шансе. Миссия провалена.');
      else this.advanceTurn();
    }
    return { ok: true };
  }
  endTurn(id) {
    if (this.phase !== 'guessing' || !this.canGuess(id)) return { error: 'Сейчас нельзя завершить ход' };
    if (!this.guessesMade) return { error: 'Нужно сделать хотя бы одну попытку' };
    this.advanceTurn();
    return { ok: true };
  }
  advanceTurn() {
    this.tokensLeft--;
    this.round++;
    this.guessesMade = 0;
    this.clue = null;
    if (this.tokensLeft === 0) {
      this.phase = 'sudden-death';
      this.turns.push({ round: this.round, team: null, clue: null, picks: [] });
    } else {
      const next = other(this.activeTeam);
      this.activeTeam = this.remaining(next) > 0 ? next : this.activeTeam;
      this.phase = 'clue';
    }
  }
  finish(winner, reason) {
    this.finished = true;
    this.phase = 'finished';
    this.winner = winner;
    this.winReason = reason;
  }
  publicBoard(side, showKeys = false) {
    return this.board.map((card, index) => ({
      word: card.word, revealed: card.revealed,
      kind: card.found ? 'agent' : card.hit || (card.revealed ? 'neutral' : side ? this.keys[side][index] : null),
      bystanders: { ...card.bystanders }, blocked: side ? card.bystanders[side] : false,
      ...(showKeys ? { keys: { A: this.keys.A[index], B: this.keys.B[index] } } : {}),
    }));
  }
  getArchiveSummary() {
    return { codenames: { mode: 'duet', board: this.publicBoard(null, true), keys: this.keys,
      captains: {}, turns: this.turns, startingTeam: this.startingTeam, tokensLeft: this.tokensLeft } };
  }
  viewFor(id) {
    // Viewing one's own key must work while offline too (e.g. cached views).
    const p = this.players.get(id);
    const side = p?.role !== 'spectator' ? SIDES.find(s => this.teamOrder[s].includes(id)) : null;
    return { round: this.round, phase: this.phase, winner: this.winner, winReason: this.winReason,
      codenames: {
        mode: 'duet', board: this.publicBoard(side, this.finished), captains: {}, isCaptain: false,
        isDuetPlayer: !!side, ownSide: side, activeTeam: this.activeTeam, startingTeam: this.startingTeam,
        tokensLeft: this.tokensLeft, totalRemaining: this.totalRemaining(),
        completedSides: { A: this.remaining('A') === 0, B: this.remaining('B') === 0 },
        remaining: { A: side === 'A' ? this.remaining('A') : null, B: side === 'B' ? this.remaining('B') : null },
        clue: this.clue, guessesLeft: null, turns: this.turns,
        canGiveClue: !this.finished && this.phase === 'clue' && this.sideOf(id) === this.activeTeam,
        canGuess: this.canGuess(id), canEndTurn: this.phase === 'guessing' && this.guessesMade > 0 && this.canGuess(id),
        ...(this.finished ? { keys: this.keys } : {}),
      } };
  }
}
module.exports = DuetGame;
