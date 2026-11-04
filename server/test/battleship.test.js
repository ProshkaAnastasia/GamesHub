const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../games/battleship');
const { Room } = require('../game');
const { validPayload } = require('../security');
function room() {
  const r = new Room('SHIP'); r.addPlayer('a', 'Alice'); r.addPlayer('b', 'Bob');
  assert.ok(r.setGameType('a', 'battleship').ok); assert.ok(r.startGame().ok); return r;
}
function battle(r) {for (const id of ['a', 'b']) {assert.ok(r.battleshipAuto(id).ok);assert.ok(r.battleshipReady(id).ok);}return r.game;}
test('fleet validation rejects diagonal, bent, overlapping, touching and extra ships', () => {
  for (const ships of [[[9,10]],[[0,11]],[[0,1,11]],[[0,1],[1]],[[0],[11]],[[0],[1]],[[0,1,2,3,4]],[[0,1,2,3],[20,21,22,23]],[[100]],[[0,0]]]) assert.equal(mod.validFleet(ships),false);
  assert.equal(mod.validFleet([[0,1,2,3],[20,21,22]]),true);
  assert.equal(mod.validFleet([],true),false);
  for(let n=0;n<100;n++) assert.equal(mod.validFleet(mod.randomFleet(),true),true);
});
test('setup enforces roles and readiness; only own fleet is visible, including observers', () => {
  const r=room();r.joinInProgress('watch','Watcher');
  assert.ok(r.battleshipAuto('watch').error);assert.ok(r.battleshipReady('a').error);
  assert.ok(r.battleshipArrange('a',[[0,1,2,3]]).ok);
  assert.equal(r.viewFor('a').battleship.boards.a.filter(c=>c==='ship').length,4);
  assert.ok(r.viewFor('b').battleship.boards.a.every(c=>c==='water'));
  assert.deepEqual(r.viewFor('watch').battleship.ownFleet,[]);
  assert.ok(Object.values(r.viewFor('watch').battleship.boards).flat().every(c=>c==='water'));
  r.battleshipAuto('a');r.battleshipReady('a');assert.equal(r.game.phase,'setup');
  assert.ok(r.battleshipAuto('a').error);assert.ok(r.battleshipArrange('a',[]).error);
  r.battleshipAuto('b');r.battleshipReady('b');assert.equal(r.game.phase,'battle');
  assert.ok(r.battleshipAuto('b').error);
});
test('miss passes the turn; hit retains it; duplicate, invalid and observer shots fail', () => {
  const r=room(),g=battle(r),id=g.currentPlayerId,target=g.opponent(id);
  const miss=Array.from({length:100},(_,i)=>i).find(i=>!g.fleets[target].flat().includes(i));
  assert.ok(r.battleshipFire(target,miss).error);assert.ok(r.battleshipFire('watch',miss).error);
  assert.ok(r.battleshipFire(id,NaN).error);assert.ok(r.battleshipFire(id,100).error);
  assert.ok(r.battleshipFire(id,miss).ok);assert.equal(g.currentPlayerId,target);
  const hit=g.fleets[id].flat()[0];assert.ok(r.battleshipFire(target,hit).ok);assert.equal(g.currentPlayerId,target);
  assert.ok(r.battleshipFire(target,hit).error);
  assert.ok(r.viewFor(target).battleship.boards[id].filter(c=>c==='ship').length===0);
});
test('sunk ships reveal only their cells and block surrounding water; all ships wins', () => {
  const r=room(),g=battle(r),id=g.currentPlayerId,target=g.opponent(id);
  const ship=g.fleets[target].find(s=>s.length===1),index=ship[0];
  assert.ok(r.battleshipFire(id,index).ok);
  assert.equal(r.viewFor(id).battleship.boards[target][index],'sunk');
  assert.equal(r.viewFor(id).battleship.shipsLeft[target],9);
  const around=Array.from({length:100},(_,i)=>i).find(i=>i!==index&&Math.abs(i%10-index%10)<=1&&Math.abs(Math.floor(i/10)-Math.floor(index/10))<=1);
  assert.ok(r.battleshipFire(id,around).error);
  for(const cell of g.fleets[target].flat().filter(n=>n!==index))assert.ok(r.battleshipFire(id,cell).ok);
  assert.equal(r.status,'finished');assert.equal(g.winner,id);assert.ok(r.battleshipFire(id,0).error);
  assert.equal(r.viewFor(target).battleship.boards[id].filter(c=>c==='ship').length,20);
});
test('save/restore preserves partial setup and active turn; replay archives fleets and resets', () => {
  let r=room();r.battleshipArrange('a',[[0,1,2,3]]);
  r=Room.fromData(JSON.parse(JSON.stringify(r)));r.setConnected('a',true);r.setConnected('b',true);
  assert.deepEqual(r.viewFor('a').battleship.ownFleet,[[0,1,2,3]]);
  battle(r);const data=JSON.parse(JSON.stringify(r));r=Room.fromData(data);
  assert.deepEqual(r.game.toJSON(),data.game);r.setConnected('a',true);r.setConnected('b',true);
  r.forceEndGame();assert.ok(r.playAgain().ok);assert.equal(r.pastGames.length,1);
  assert.equal(r.pastGames[0].battleship.boards.a.filter(c=>c==='ship').length,20);
  assert.ok(r.startGame().ok);assert.deepEqual(r.game.fleets,{a:[],b:[]});
});
test('battleship payloads and player limits are validated',()=>{
  assert.equal(validPayload('find-game',{name:'A',gameType:'battleship'}),true);
  assert.equal(validPayload('battleship-layout',{ships:[[0,1]]}),true);
  assert.equal(validPayload('battleship-layout',{ships:[Array(100).fill(0)]}),false);
  assert.equal(validPayload('battleship-layout',{ships:[[100]]}),false);
  assert.equal(validPayload('battleship-fire',{index:99}),true);
  assert.equal(validPayload('battleship-fire',{index:-1}),false);
  assert.equal(validPayload('battleship-fire',{index:'1'}),false);
  const r=room();r.forceEndGame();r.playAgain();r.addPlayer('c','C');assert.equal(r.canStart(),false);
});
