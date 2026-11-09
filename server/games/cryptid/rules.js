const { shuffle } = require('../decoder/words');
const WIDTH = 12, HEIGHT = 9;
const TERRAINS = ['forest', 'desert', 'water', 'mountain', 'swamp'];
const TERRAIN_NAMES = { forest: 'лес', desert: 'пустыня', water: 'вода', mountain: 'горы', swamp: 'болото' };
const COLORS = ['white', 'green', 'blue'];
const COLOR_NAMES = { white: 'белой', green: 'зелёной', blue: 'синей' };
const axial = cell => [cell.col - (cell.row - (cell.row & 1)) / 2, cell.row];
function distance(a, b) { const [aq, ar] = axial(a), [bq, br] = axial(b); return Math.max(Math.abs(aq-bq), Math.abs(ar-br), Math.abs(aq+ar-bq-br)); }
function makeMap() {
  const cells = Array.from({ length: WIDTH * HEIGHT }, (_, id) => ({ id, col: id % WIDTH, row: Math.floor(id / WIDTH), terrain: null, animal: null, structure: null }));
  const seeds = shuffle(cells).slice(0, 25).map((cell, i) => ({ ...cell, terrain: TERRAINS[i % 5] }));
  for (const cell of cells) cell.terrain = seeds.reduce((best, seed) => distance(cell, seed) < distance(cell, best) ? seed : best).terrain;
  for (const animal of ['bear', 'cougar']) {
    for (let group = 0; group < 2; group++) {
      const start = shuffle(cells.filter(c => !c.animal))[0];
      shuffle(cells.filter(c => !c.animal)).sort((a,b) => distance(a,start)-distance(b,start)).slice(0,3).forEach(c => { c.animal = animal; });
    }
  }
  shuffle(cells).slice(0,6).forEach((cell,i) => { cell.structure = { type: i % 2 ? 'shack' : 'stone', color: COLORS[Math.floor(i/2)] }; });
  return cells;
}
function catalog() {
  const clues = [];
  for (let a=0; a<TERRAINS.length; a++) for (let b=a+1; b<TERRAINS.length; b++) {
    const terrains = [TERRAINS[a], TERRAINS[b]];
    clues.push({ id: `terrain-${terrains.join('-')}`, kind: 'terrain', terrains, text: `Существо находится на одном из двух типов местности: ${terrains.map(t=>TERRAIN_NAMES[t]).join(' или ')}.` });
  }
  for (const terrain of TERRAINS) clues.push({ id: `near-${terrain}`, kind: 'near-terrain', terrain, radius: 1, text: `Существо находится не дальше 1 клетки от местности «${TERRAIN_NAMES[terrain]}», включая саму эту местность.` });
  clues.push({ id: 'near-animal', kind: 'near-animal', animal: null, radius: 1, text: 'Существо находится не дальше 1 клетки от любой территории животных — медведя или пумы, включая саму территорию.' });
  for (const animal of ['bear','cougar']) clues.push({ id: `near-${animal}`, kind: 'near-animal', animal, radius: 2, text: `Существо находится не дальше 2 клеток от территории ${animal === 'bear' ? 'медведя' : 'пумы'}, включая саму территорию.` });
  for (const type of ['stone','shack']) clues.push({ id: `near-${type}`, kind: 'near-structure', type, radius: 2, text: `Существо находится не дальше 2 клеток от ${type === 'stone' ? 'стоячего камня' : 'заброшенной хижины'} любого цвета, включая клетку постройки.` });
  for (const color of COLORS) clues.push({ id: `near-${color}`, kind: 'near-color', color, radius: 3, text: `Существо находится не дальше 3 клеток от ${COLOR_NAMES[color]} постройки любого типа, включая клетку постройки.` });
  return clues;
}
function matches(cells, clue, id) {
  const cell = cells[id];
  if (!cell) return false;
  if (clue.kind === 'terrain') return clue.terrains.includes(cell.terrain);
  return cells.some(other => distance(cell,other) <= clue.radius && (
    clue.kind === 'near-terrain' ? other.terrain === clue.terrain :
    clue.kind === 'near-animal' ? !!other.animal && (!clue.animal || other.animal === clue.animal) :
    clue.kind === 'near-structure' ? other.structure?.type === clue.type :
    clue.kind === 'near-color' ? other.structure?.color === clue.color : false));
}
const singleton = mask => mask !== 0n && (mask & (mask-1n)) === 0n;
function generatePuzzle(count) {
  if (![3,4,5].includes(count)) throw new Error('Криптид рассчитан на 3–5 игроков');
  for (let attempt=0; attempt<80; attempt++) {
    const cells = makeMap();
    const possibilities = shuffle(catalog()).map(clue => ({ clue, mask: cells.reduce((m,c)=>matches(cells,clue,c.id) ? m | (1n << BigInt(c.id)) : m,0n) }));
    const all = (1n << BigInt(cells.length))-1n;
    let budget = 120000;
    function find(start, selected, mask) {
      if (--budget < 0 || mask === 0n) return null;
      if (selected.length === count) {
        if (!singleton(mask)) return null;
        // Every player's clue must contribute; no redundant spectators in the puzzle.
        if (selected.some((_,omit) => singleton(selected.reduce((m,p,i)=>i===omit?m:m&p.mask,all)))) return null;
        return selected;
      }
      if (singleton(mask)) return null;
      for (let i=start; i<=possibilities.length-(count-selected.length); i++) {
        const next = possibilities[i];
        if ((mask & next.mask) === mask) continue;
        const found = find(i+1,[...selected,next],mask & next.mask);
        if (found) return found;
      }
      return null;
    }
    const chosen = find(0,[],all);
    if (chosen) {
      const solutionMask = chosen.reduce((mask,p)=>mask & p.mask,all);
      const solution = cells.find(c=>(solutionMask & (1n << BigInt(c.id))) !== 0n).id;
      return { cells, clues: shuffle(chosen.map(p=>p.clue)), solution };
    }
  }
  throw new Error('Не удалось построить загадку. Попробуйте начать игру ещё раз.');
}
module.exports = { WIDTH, HEIGHT, TERRAINS, TERRAIN_NAMES, COLORS, catalog, distance, matches, generatePuzzle };
