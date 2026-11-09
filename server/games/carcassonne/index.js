const { tiles } = require('../../../public/carcassonne-tiles');
const { shuffle } = require('../decoder/words');
const directions = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const key = (x, y) => `${x},${y}`;
const TILE_SETS = 2;
const MAX_BOARD_COORDINATE = 144;

class CarcassonneGame {
  constructor(players) {
    this.players = players;
    this.playerIds = shuffle([...players.values()].filter(p => p.connected).map(p => p.id));
    this.scores = {};
    this.meeples = {};
    this.names = {};
    this.playerIds.forEach(id => {
      this.scores[id] = 0;
      this.meeples[id] = 7;
      this.names[id] = players.get(id).name;
    });
    this.turn = 0;
    this.round = 1;
    this.phase = 'tile';
    this.board = [{ x: 0, y: 0, id: 'D', rotation: 0, meeple: null }];
    // Два полных набора; одна стартовая D уже лежит на поле.
    this.deck = shuffle(Object.values(tiles).flatMap(t => Array(t.count * TILE_SETS - (t.id === 'D' ? 1 : 0)).fill(t.id)));
    this.currentTile = null;
    this.lastPlaced = null;
    this.log = [];
    this.discarded = 0;
    this.finished = false;
    this.winner = null;
    this.winReason = null;
  }

  static create(players) {
    const game = new CarcassonneGame(players);
    game.draw();
    return game;
  }

  static fromData(data, players) {
    const game = Object.create(CarcassonneGame.prototype);
    Object.assign(game, data, { players });
    return game;
  }

  toJSON() {
    const { players, ...data } = this;
    return data;
  }

  get currentPlayerId() { return this.playerIds[this.turn % this.playerIds.length]; }

  active(id) {
    return !this.finished && id === this.currentPlayerId
      && this.players.get(id)?.connected && !this.players.get(id)?.left;
  }

  at(x, y) { return this.board.find(t => t.x === x && t.y === y); }
  edge(tile, direction) { return tiles[tile.id].edges[(direction - tile.rotation + 4) % 4]; }

  legal(x, y, rotation, id = this.currentTile) {
    if (!tiles[id] || !Number.isInteger(rotation) || rotation < 0 || rotation > 3
      || !Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > MAX_BOARD_COORDINATE || Math.abs(y) > MAX_BOARD_COORDINATE
      || this.at(x, y)) return false;
    const tile = { id, rotation };
    let neighbor = false;
    for (let d = 0; d < 4; d++) {
      const [dx, dy] = directions[d];
      const next = this.at(x + dx, y + dy);
      if (next) {
        neighbor = true;
        if (this.edge(tile, d) !== this.edge(next, (d + 2) % 4)) return false;
      }
    }
    return neighbor;
  }

  placements(id = this.currentTile) {
    const result = [], seen = new Set();
    for (const tile of this.board) {
      for (const [dx, dy] of directions) {
        const x = tile.x + dx, y = tile.y + dy, position = key(x, y);
        if (seen.has(position) || this.at(x, y)) continue;
        seen.add(position);
        const rotations = [0, 1, 2, 3].filter(r => this.legal(x, y, r, id));
        if (rotations.length) result.push({ x, y, rotations });
      }
    }
    return result;
  }

  draw() {
    while (this.deck.length) {
      this.currentTile = this.deck.pop();
      if (this.placements().length) return;
      this.discarded++;
    }
    this.currentTile = null;
    this.finalScore();
  }

  // Full-edge ports connect roads/cities; mirrored half-edge ports connect fields.
  component(tile, feature) {
    const queue = [{ tile, feature }], seen = new Set(), nodes = [], tileKeys = new Set();
    let open = 0;
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], t = node.tile, f = node.feature;
      const nodeKey = key(t.x, t.y) + ':' + f.id;
      if (seen.has(nodeKey)) continue;
      seen.add(nodeKey);
      nodes.push(node);
      tileKeys.add(key(t.x, t.y));
      const field = f.type === 'field';
      const ports = field ? f.ports.map(p => (p + 2 * t.rotation) % 8)
        : f.edges.map(e => (e + t.rotation) % 4);
      for (const port of ports) {
        const direction = field ? Math.floor(port / 2) : port;
        const [dx, dy] = directions[direction], next = this.at(t.x + dx, t.y + dy);
        if (!next) { open++; continue; }
        const target = field ? ((Math.floor(port / 2) + 2) % 4) * 2 + (1 - port % 2)
          : (port + 2) % 4;
        const nextFeature = tiles[next.id].features.find(other => other.type === f.type
          && (field ? other.ports.map(v => (v + 2 * next.rotation) % 8)
            : other.edges.map(v => (v + next.rotation) % 4)).includes(target));
        if (nextFeature) queue.push({ tile: next, feature: nextFeature });
      }
    }
    return { nodes, ids: seen, tileKeys, open, type: feature.type };
  }

  choices() {
    const tile = this.lastPlaced && this.at(this.lastPlaced.x, this.lastPlaced.y);
    if (!tile || this.meeples[this.currentPlayerId] <= 0) return [];
    return tiles[tile.id].features.filter(f => f.type === 'monastery'
      || !this.component(tile, f).nodes.some(n => n.tile.meeple?.feature === n.feature.id)).map(f => f.id);
  }

  placeTile(id, x, y, rotation) {
    if (!this.active(id) || this.phase !== 'tile') return { error: 'Сейчас не ваш ход размещать плитку' };
    if (!this.legal(x, y, rotation)) return { error: 'Края плитки должны совпадать со всеми соседями' };
    this.board.push({ x, y, id: this.currentTile, rotation, meeple: null });
    this.lastPlaced = { x, y };
    this.phase = 'meeple';
    return { ok: true };
  }

  placeMeeple(id, feature) {
    if (!this.active(id) || this.phase !== 'meeple') return { error: 'Сейчас нельзя поставить мипла' };
    if (feature !== null && !this.choices().includes(feature)) return { error: 'Объект уже занят или миплы закончились' };
    if (feature !== null) {
      this.at(this.lastPlaced.x, this.lastPlaced.y).meeple = { playerId: id, feature };
      this.meeples[id]--;
    }
    this.scoreCompleted();
    this.turn++;
    this.round++;
    this.phase = 'tile';
    this.draw();
    return { ok: true };
  }

  award(component, points, label) {
    const counts = {};
    for (const { tile, feature } of component.nodes) {
      if (tile.meeple?.feature === feature.id) {
        const id = tile.meeple.playerId;
        counts[id] = (counts[id] || 0) + 1;
      }
    }
    const max = Math.max(0, ...Object.values(counts));
    if (!max) return;
    const winners = Object.keys(counts).filter(id => counts[id] === max);
    winners.forEach(id => this.scores[id] += points);
    this.log.push({ round: this.round, label, points, players: winners });
    for (const { tile, feature } of component.nodes) {
      if (tile.meeple?.feature === feature.id) {
        this.meeples[tile.meeple.playerId]++;
        tile.meeple = null;
      }
    }
  }

  monasteryPoints(tile) {
    let count = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (this.at(tile.x + dx, tile.y + dy)) count++;
      }
    }
    return count;
  }

  scoreCompleted(final = false) {
    const seen = new Set();
    for (const tile of this.board) {
      for (const feature of tiles[tile.id].features) {
        if (feature.type === 'field') continue;
        if (feature.type === 'monastery') {
          const points = this.monasteryPoints(tile);
          if (final || points === 9) this.award({ nodes: [{ tile, feature }] }, points, 'Монастырь');
          continue;
        }
        if (seen.has(key(tile.x, tile.y) + ':' + feature.id)) continue;
        const component = this.component(tile, feature);
        component.ids.forEach(id => seen.add(id));
        if (final || component.open === 0) {
          const shields = component.nodes.reduce((n, v) => n + (v.feature.shield || 0), 0);
          const city = feature.type === 'city';
          const points = city ? (component.tileKeys.size + shields) * (component.open === 0 ? 2 : 1)
            : component.tileKeys.size;
          this.award(component, points, city ? 'Город' : 'Дорога');
        }
      }
    }
  }

  finalScore() {
    this.scoreCompleted(true);
    const seen = new Set();
    for (const tile of this.board) {
      for (const field of tiles[tile.id].features.filter(f => f.type === 'field')) {
        if (seen.has(key(tile.x, tile.y) + ':' + field.id)) continue;
        const component = this.component(tile, field);
        component.ids.forEach(id => seen.add(id));
        const cities = new Set();
        for (const node of component.nodes) {
          for (const id of node.feature.adjacent) {
            const feature = tiles[node.tile.id].features.find(f => f.id === id);
            const city = this.component(node.tile, feature);
            if (city.open === 0) cities.add([...city.ids].sort().join('|'));
          }
        }
        this.award(component, cities.size * 3, 'Поле');
      }
    }
    const best = Math.max(...Object.values(this.scores));
    const winners = this.playerIds.filter(id => this.scores[id] === best);
    this.winner = winners.length === 1 ? winners[0] : 'draw';
    this.finished = true;
    this.phase = 'finished';
    this.winReason = `${winners.map(id => this.names[id]).join(', ')} — ${best} очков. Все плитки разыграны.`;
  }

  getArchiveSummary() {
    return { carcassonne: {
      board: this.board, scores: this.scores, names: this.names, playerIds: this.playerIds,
      meeples: this.meeples, log: this.log, discarded: this.discarded,
    } };
  }

  viewFor(id) {
    return {
      round: this.round, phase: this.phase, winner: this.winner, winReason: this.winReason,
      carcassonne: {
        ...this.getArchiveSummary().carcassonne, currentPlayerId: this.currentPlayerId,
        currentTile: this.currentTile, tilesLeft: this.deck.length, lastPlaced: this.lastPlaced,
        canAct: this.active(id), placements: this.phase === 'tile' ? this.placements() : [],
        choices: this.phase === 'meeple' && this.active(id) ? this.choices() : [],
      },
    };
  }
}

module.exports = {
  id: 'carcassonne', label: 'Каркассон', teamKeys: [], minPlayers: 2, maxPlayers: 5,
  startRequirementText: 'От 2 до 5 игроков. Города, дороги, монастыри и поля.',
  canStart: (_order, players) => {
    const count = [...players.values()].filter(p => p.connected).length;
    return count >= 2 && count <= 5;
  },
  create: CarcassonneGame.create, fromData: CarcassonneGame.fromData,
};
