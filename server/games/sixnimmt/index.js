const { shuffle } = require('../decoder/words');
const heads = card => card === 55 ? 7 : card % 11 === 0 ? 5 : card % 10 === 0 ? 3 : card % 5 === 0 ? 2 : 1;
const rowHeads = row => row.reduce((sum, card) => sum + heads(card), 0);

class SixNimmtGame {
  constructor(players) {
    this.players = players;
    this.playerIds = [...players.values()].filter(p => p.connected).map(p => p.id);
    this.names = Object.fromEntries(this.playerIds.map(id => [id, players.get(id).name]));
    this.scores = Object.fromEntries(this.playerIds.map(id => [id, 0]));
    this.handNumber = 0;
    this.round = 1;
    this.history = [];
    this.finished = false;
    this.winner = null;
    this.winReason = null;
    this.deal();
  }
  static create(players) { return new SixNimmtGame(players); }
  static fromData(data, players) {
    const game = Object.create(SixNimmtGame.prototype);
    Object.assign(game, data, { players });
    return game;
  }
  toJSON() { const { players, ...data } = this; return data; }
  participant(id) { return this.playerIds.includes(id) && this.players.get(id)?.connected && !this.players.get(id)?.left && this.players.get(id)?.role !== 'spectator'; }
  deal() {
    const deck = shuffle(Array.from({ length: 104 }, (_, i) => i + 1));
    this.handNumber++;
    this.turn = 1;
    this.hands = Object.fromEntries(this.playerIds.map(id => [id, deck.splice(0, 10).sort((a, b) => a - b)]));
    this.rows = deck.splice(0, 4).sort((a, b) => a - b).map(card => [card]);
    this.startChoosing();
  }
  startChoosing() {
    this.phase = 'choosing';
    this.selected = {};
    this.queue = [];
    this.revealed = [];
    this.moves = [];
    this.pendingPlayerId = null;
    this.ready = [];
  }
  selectCard(id, card) {
    if (this.finished || this.phase !== 'choosing' || !this.participant(id)) return { error: 'Сейчас нельзя выбирать карту' };
    if (Object.hasOwn(this.selected, id)) return { error: 'Карта уже подтверждена' };
    if (!Number.isInteger(card) || !this.hands[id].includes(card)) return { error: 'Этой карты нет у вас в руке' };
    this.selected[id] = card;
    if (this.playerIds.every(pid => Object.hasOwn(this.selected, pid))) {
      this.revealed = this.playerIds.map(playerId => ({ playerId, card: this.selected[playerId] })).sort((a, b) => a.card - b.card);
      this.queue = this.revealed.map(item => ({ ...item }));
      for (const { playerId, card: played } of this.revealed) this.hands[playerId] = this.hands[playerId].filter(n => n !== played);
      this.resolve();
    }
    return { ok: true };
  }
  takeRow(move, index) {
    const taken = [...this.rows[index]];
    const penalty = rowHeads(taken);
    this.scores[move.playerId] += penalty;
    this.rows[index] = [move.card];
    this.moves.push({ ...move, row: index, taken, penalty });
  }
  resolve() {
    while (this.queue.length) {
      const move = this.queue[0];
      const candidates = this.rows.map((row, index) => ({ index, last: row.at(-1) })).filter(row => row.last < move.card).sort((a, b) => b.last - a.last);
      if (!candidates.length) {
        this.phase = 'choosing-row';
        this.pendingPlayerId = move.playerId;
        return;
      }
      const index = candidates[0].index;
      if (this.rows[index].length === 5) this.takeRow(move, index);
      else { this.rows[index].push(move.card); this.moves.push({ ...move, row: index, taken: [], penalty: 0 }); }
      this.queue.shift();
    }
    this.pendingPlayerId = null;
    this.history.push({ handNumber: this.handNumber, turn: this.turn, revealed: this.revealed.map(m => ({ ...m })), moves: this.moves.map(m => ({ ...m })) });
    if (!this.hands[this.playerIds[0]].length && this.playerIds.some(id => this.scores[id] >= 66)) {
      const best = Math.min(...Object.values(this.scores));
      const winners = this.playerIds.filter(id => this.scores[id] === best);
      this.finished = true;
      this.phase = 'finished';
      this.winner = winners.length === 1 ? winners[0] : 'draw';
      this.winReason = `${winners.map(id => this.names[id]).join(', ')} — ${best} штрафных голов. ${winners.length > 1 ? 'Разделённая победа!' : 'Меньше всех штрафов!'}`;
    } else this.phase = 'review';
  }
  chooseRow(id, index) {
    if (this.finished || this.phase !== 'choosing-row' || id !== this.pendingPlayerId || !this.participant(id)) return { error: 'Сейчас ряд выбирает другой игрок' };
    if (!Number.isInteger(index) || index < 0 || index > 3) return { error: 'Выберите один из четырёх рядов' };
    this.takeRow(this.queue.shift(), index);
    this.pendingPlayerId = null;
    this.resolve();
    return { ok: true };
  }
  nextTurn(id) {
    if (this.finished || this.phase !== 'review' || !this.participant(id)) return { error: 'Сейчас нельзя перейти к следующему ходу' };
    if (!this.ready.includes(id)) this.ready.push(id);
    if (this.playerIds.every(pid => this.ready.includes(pid))) {
      this.round++;
      if (!this.hands[this.playerIds[0]].length) this.deal();
      else { this.turn++; this.startChoosing(); }
    }
    return { ok: true };
  }
  publicState() { return { playerIds: this.playerIds, names: this.names, scores: this.scores, rows: this.rows,
    handNumber: this.handNumber, turn: this.turn, history: this.history, revealed: this.revealed, moves: this.moves,
    pendingPlayerId: this.pendingPlayerId, ready: this.ready,
    submitted: Object.keys(this.selected), handCounts: Object.fromEntries(this.playerIds.map(id => [id, this.hands[id].length])) }; }
  viewFor(id) {
    const participant = this.participant(id);
    return { round: this.round, phase: this.phase, winner: this.winner, winReason: this.winReason,
      sixnimmt: { ...this.publicState(), hand: participant ? this.hands[id] : [], selectedCard: participant ? this.selected[id] ?? null : null,
        canSelect: !this.finished && participant && this.phase === 'choosing' && !Object.hasOwn(this.selected, id),
        canChooseRow: !this.finished && participant && this.phase === 'choosing-row' && this.pendingPlayerId === id,
        canContinue: !this.finished && participant && this.phase === 'review' && !this.ready.includes(id) } };
  }
  getArchiveSummary() { return { sixnimmt: this.publicState() }; }
}
module.exports = { id: 'sixnimmt', label: 'Корова 006', teamKeys: [], minPlayers: 2, maxPlayers: 10,
  startRequirementText: 'От 2 до 10 игроков. Выбирайте карты одновременно и избегайте штрафных голов. Игра до 66 штрафов.',
  canStart: (_order, players) => { const n = [...players.values()].filter(p => p.connected).length; return n >= 2 && n <= 10; },
  create: SixNimmtGame.create, fromData: SixNimmtGame.fromData, heads, rowHeads };
