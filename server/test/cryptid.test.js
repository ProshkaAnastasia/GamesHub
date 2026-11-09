const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../game');
const rules = require('../games/cryptid/rules');
const { validPayload } = require('../security');
function room(n=3) {
  const r=new Room('CRYP');for(let i=0;i<n;i++)r.addPlayer(`p${i}`,`Player ${i}`);
  assert.ok(r.setGameType('p0','cryptid').ok);assert.ok(r.startGame().ok);return r;
}
function setup(r) {
  while(r.game.phase==='setup'){
    const g=r.game,id=g.currentPlayerId;
    assert.ok(r.cryptidMark(id,g.legalMarkers(id,'cube')[0]).ok);
  }
}
test('hex distance, every normal clue type, and zero-distance inclusion',()=>{
  assert.equal(rules.distance({col:0,row:0},{col:1,row:1}),2);
  assert.equal(rules.distance({col:1,row:0},{col:0,row:1}),1);
  assert.equal(rules.distance({col:1,row:1},{col:1,row:1}),0);
  const cells=[{id:0,col:0,row:0,terrain:'forest',animal:'bear',structure:{type:'stone',color:'white'}},
    {id:1,col:1,row:0,terrain:'desert',animal:null,structure:null},{id:2,col:5,row:0,terrain:'water',animal:'cougar',structure:{type:'shack',color:'blue'}}];
  for(const id of ['terrain-forest-desert','near-forest','near-animal','near-bear','near-stone','near-white'])assert.equal(rules.matches(cells,rules.catalog().find(c=>c.id===id),0),true);
  assert.equal(rules.matches(cells,rules.catalog().find(c=>c.id==='near-forest'),2),false);
  assert.equal(rules.matches(cells,rules.catalog().find(c=>c.id==='near-stone'),1),true);
});
test('generated puzzles have exactly one solution and every clue contributes for 3–5 players',()=>{
  for(const n of [3,4,5])for(let i=0;i<12;i++){
    const p=rules.generatePuzzle(n);
    assert.equal(p.cells.length,108);assert.equal(p.clues.length,n);
    assert.equal(new Set(p.clues.map(c=>c.id)).size,n);
    assert.equal(new Set(p.cells.map(c=>c.terrain)).size,5);
    assert.deepEqual(p.cells.filter(c=>p.clues.every(k=>rules.matches(p.cells,k,c.id))).map(c=>c.id),[p.solution]);
    for(let omit=0;omit<n;omit++)assert.ok(p.cells.filter(c=>p.clues.every((k,i)=>i===omit||rules.matches(p.cells,k,c.id))).length>1);
    assert.equal(p.cells.filter(c=>c.structure).length,6);
  }
});
test('initial sharing is honest, sequential and two rounds; private clues and solution stay private',()=>{
  const r=room(),g=r.game,id=g.currentPlayerId;
  assert.ok(r.cryptidMark(g.playerIds[1],0).error);
  assert.ok(r.cryptidMark(id,g.solution).error);
  assert.ok(r.cryptidQuestion(id,g.playerIds[1],0).error);
  setup(r);assert.equal(g.setupCount,6);assert.equal(g.phase,'turn');
  for(const pid of g.playerIds){const v=r.viewFor(pid).cryptid;assert.equal(v.solution,undefined);assert.equal(v.clues,undefined);assert.equal(v.myClue.id,g.clues[pid].id);assert.equal(v.clueCatalog.length,23);}
  r.joinInProgress('watch','Watcher');const v=r.viewFor('watch').cryptid;
  assert.equal(v.myClue,null);assert.equal(v.canAct,false);assert.equal(v.solution,undefined);
  assert.ok(r.cryptidSearch('watch',g.solution).error);
});
test('questions may misdirect, automatic answers are honest, and a negative answer requires a different cube',()=>{
  const r=room();setup(r);const g=r.game,id=g.currentPlayerId,target=g.playerIds[1];
  // Keep this question-focused test independent of randomly chosen setup cubes.
  g.markers=Object.fromEntries(g.cells.map(c=>[c.id,[]]));
  const positive=g.cells.find(c=>g.available(c.id)&&!g.hasPiece(target,c.id)&&!g.agrees(id,c.id)&&g.agrees(target,c.id));
  assert.ok(positive);assert.ok(r.cryptidQuestion(id,target,positive.id).ok);
  assert.deepEqual(g.markers[positive.id],[{playerId:target,kind:'disc'}]);
  assert.notEqual(g.currentPlayerId,id);
  const asker=g.currentPlayerId,other=g.playerIds.find(p=>p!==asker);
  const negative=g.cells.find(c=>g.available(c.id)&&!g.hasPiece(other,c.id)&&!g.agrees(other,c.id));
  assert.ok(r.cryptidQuestion(asker,other,negative.id).ok);
  assert.equal(g.phase,'compensation');assert.equal(g.currentPlayerId,asker);
  assert.ok(r.cryptidMark(asker,negative.id).error);
  assert.ok(r.cryptidSearch(asker,g.solution).error);
  assert.ok(r.cryptidMark(asker,g.legalMarkers(asker,'cube')[0]).ok);
  assert.equal(g.phase,'turn');assert.notEqual(g.currentPlayerId,asker);
});
test('search rejects incompatible cells, stops at the first refusal, and preserves pending cube on restore',()=>{
  let r=room(5);setup(r);let g=r.game;const id=g.currentPlayerId;
  const forbidden=g.cells.find(c=>g.available(c.id)&&!g.agrees(id,c.id));
  assert.ok(r.cryptidSearch(id,forbidden.id).error);
  const failed=g.cells.find(c=>g.available(c.id)&&g.agrees(id,c.id)&&c.id!==g.solution);
  assert.ok(r.cryptidSearch(id,failed.id).ok);assert.equal(g.phase,'compensation');
  assert.equal(g.lastAction.answers.filter(a=>!a.yes).length,1);
  assert.equal(g.lastAction.answers.at(-1).yes,false);
  const before=JSON.parse(JSON.stringify(r));r=Room.fromData(before);g=r.game;
  for(const pid of g.playerIds)r.setConnected(pid,true);
  assert.equal(g.phase,'compensation');assert.equal(g.solution,before.game.solution);
  assert.deepEqual(g.cells,before.game.cells);
  assert.ok(r.cryptidMark(id,g.legalMarkers(id,'cube')[0]).ok);
});
test('searching a known own disc requires another legal disc; success reveals clues, archive and replay work',()=>{
  const r=room();setup(r);const g=r.game,id=g.currentPlayerId;
  g.addMarker(id,g.solution,'disc');
  assert.ok(r.cryptidSearch(id,g.solution).ok);assert.equal(g.phase,'search-disc');
  assert.ok(r.cryptidMark(id,g.solution).error);
  assert.ok(r.cryptidMark(id,g.legalMarkers(id,'disc')[0]).ok);
  assert.equal(r.status,'finished');assert.equal(g.winner,id);
  assert.equal(r.viewFor(id).cryptid.solution,g.solution);
  assert.equal(Object.keys(r.viewFor(id).cryptid.clues).length,3);
  assert.ok(r.cryptidSearch(id,g.solution).error);
  assert.ok(r.playAgain().ok);assert.ok(r.pastGames[0].cryptid.clues);
  assert.ok(r.startGame().ok);assert.equal(r.game.phase,'setup');
});
test('marker uniqueness, excluded cells, self questions, and payload validation',()=>{
  const r=room();setup(r);const g=r.game,id=g.currentPlayerId;
  const blocked=g.cells.find(c=>g.hasCube(c.id));
  assert.ok(r.cryptidSearch(id,blocked.id).error);assert.ok(r.cryptidQuestion(id,g.playerIds[1],blocked.id).error);
  assert.ok(r.cryptidQuestion(id,id,g.solution).error);
  for(const event of ['cryptid-mark','cryptid-search','cryptid-question'])for(const cell of [-1,108,'1',1.5,null])assert.equal(validPayload(event,{cell,target:'p1'}),false);
  assert.equal(validPayload('cryptid-question',{cell:107,target:'p1'}),true);
  assert.equal(validPayload('cryptid-question',{cell:107,target:[]}),false);
  assert.equal(validPayload('find-game',{name:'Player',gameType:'cryptid'}),true);
});

test('exhausted mandatory cube spaces cannot deadlock a turn',()=>{
  const r=room();setup(r);const g=r.game,id=g.currentPlayerId,target=g.playerIds[1];
  g.markers=Object.fromEntries(g.cells.map(c=>[c.id,[]]));
  for(const cell of g.cells)if(!g.agrees(id,cell.id))g.addMarker(id,cell.id,'cube');
  const refused=g.cells.find(c=>g.available(c.id)&&!g.agrees(target,c.id));
  assert.ok(refused);
  assert.ok(r.cryptidQuestion(id,target,refused.id).ok);
  assert.equal(g.phase,'turn');assert.notEqual(g.currentPlayerId,id);
  assert.equal(g.log.at(-1).kind,'no-cube-space');
});
