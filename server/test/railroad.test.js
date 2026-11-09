const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Room}=require('../game');
const moduleGame=require('../games/railroad');
const tiles=require('../../public/railroad-tiles');
const {score,longestRoute}=require('../games/railroad/rules');
const {validPayload}=require('../security');
const board=()=>Array(49).fill(null);
const tile=(piece,rotation=0,flipped=false)=>({piece,rotation,flipped,round:1,source:0});
function room(count=1){const r=new Room('ROAD');for(let i=0;i<count;i++)r.addPlayer('p'+i,'Player '+i);assert.ok(r.setGameType('p0','railroad').ok);assert.ok(r.startGame().ok);return r;}
function playRound(r){
  const g=r.game;
  for(const id of g.playerIds){
    let placed=true;
    while(placed){placed=false;for(let die=0;die<4;die++){if(g.usedDice[id].includes(die))continue;const p=tiles.placements(g.boards[id],g.dice[die])[0];if(p){assert.ok(r.railroadPlace(id,die,p.x,p.y,p.rotation,p.flipped).ok);placed=true;break;}}}
    assert.ok(r.railroadFinishRound(id).ok);
  }
}
test('base dice, six specials, twelve exits, rotation and reflection preserve connection groups',()=>{
  assert.equal(tiles.basic.length,6);assert.equal(tiles.specials.length,6);assert.equal(tiles.exits.length,12);
  assert.equal(tiles.transition.filter(id=>id==='overpass').length,2);
  assert.deepEqual(tiles.orient('overpass',1).ports,['H','R','H','R']);
  assert.deepEqual(tiles.orient('overpass',1).groups,[[1,3],[2,0]]);
  assert.deepEqual(tiles.orient('station-curve',0,true).ports,['H',null,null,'R']);
});
test('placements must connect to an exit or existing network and never join road to railway',()=>{
  const b=board();
  assert.equal(tiles.legal(b,'highway-straight',1,0),true);
  assert.equal(tiles.legal(b,'railway-straight',1,0),false);
  assert.equal(tiles.legal(b,'highway-straight',3,3),false);
  assert.equal(tiles.legal(b,'highway-straight',1,0,4),false);
  b[1]=tile('highway-straight');
  assert.equal(tiles.legal(b,'highway-curve',1,1),true);
  assert.equal(tiles.legal(b,'railway-straight',1,1),false);
  assert.equal(tiles.legal(b,'highway-straight',1,0),false);
});
test('networks, longest road and rail, central spaces, and outer boundaries score correctly',()=>{
  const h=board(),r=board();
  for(let y=0;y<7;y++){h[y*7+1]=tile('highway-straight');r[y*7+3]=tile('railway-straight');}
  assert.deepEqual(score(h),{network:4,networks:[2],highway:7,railway:0,center:0,errors:0,total:11});
  assert.deepEqual(score(r),{network:4,networks:[2],highway:0,railway:7,center:3,errors:0,total:14});
  const end=board();end[1]=tile('highway-straight');assert.equal(score(end).errors,1);
});
test('overpass crosses two networks without connecting; station connects them',()=>{
  const b=board();
  for(let p=0;p<7;p++){b[p*7+1]=tile('highway-straight');b[7+p]=tile('railway-straight',1);}
  b[8]=tile('overpass',1);
  assert.equal(score(b).network,8);assert.deepEqual([...score(b).networks].sort(),[2,2]);
  assert.equal(score(b).highway,7);assert.equal(score(b).railway,7);assert.equal(score(b).errors,0);
  b[8]=tile('special-station-opposite');
  assert.equal(score(b).network,12);assert.deepEqual(score(b).networks,[4]);
});
test('longest route excludes branches and cannot count a square twice around a cycle',()=>{
  const b=board();b[24]=tile('highway-junction');b[17]=tile('highway-straight');b[23]=tile('highway-straight',1);b[25]=tile('highway-straight',1);
  assert.equal(longestRoute(b,'H'),3);
  const loop=board();loop[16]=tile('highway-curve',1);loop[17]=tile('highway-curve',2);loop[23]=tile('highway-curve');loop[24]=tile('highway-curve',3);
  assert.equal(longestRoute(loop,'H'),4);
});
test('twelve connected exits receive 45 points and dense routes remain exact',()=>{
  const b=Array.from({length:49},()=>tile('special-highway'));
  // Road-to-rail exits are intentionally not counted, even on a synthetic board.
  assert.equal(score(b).network,20);assert.equal(longestRoute(b,'H'),49);
  // Test all 12 exits with highway junctions and stations converting the rail exits.
  const network=Array.from({length:49},()=>tile('special-highway'));
  for(const e of tiles.exits.filter(e=>e.type==='R')){
    const index=e.y*7+e.x;
    const rotation=(e.side+1)%4;network[index]=tile('special-three-highways',rotation);
  }
  assert.equal(score(network,false).network,45);
});
test('each die is used once; special limits, undo and confirmed rounds are enforced',()=>{
  const r=room(),g=r.game;g.dice=['highway-straight','highway-straight','highway-straight','overpass'];
  assert.ok(r.railroadFinishRound('p0').error);
  assert.ok(r.railroadPlace('p0',0,1,0,0,false).ok);
  assert.ok(r.railroadPlace('p0',0,1,1,0,false).error);
  assert.ok(r.railroadPlace('p0','special-highway',1,1,0,false).ok);
  assert.ok(r.railroadPlace('p0','special-three-highways',1,2,0,false).error);
  assert.ok(r.railroadUndo('p0').ok);assert.deepEqual(g.specialsUsed.p0,[]);
  assert.ok(r.railroadUndo('p0').ok);assert.equal(g.boards.p0[1],null);assert.deepEqual(g.usedDice.p0,[]);
  g.specialsUsed.p0=['special-highway','special-railway','special-three-highways'];
  assert.ok(r.railroadPlace('p0','special-station-adjacent',1,0,0,false).error);
});
test('solo completes seven rounds, preserves a mid-round save, and archives exact scores',()=>{
  let r=room();const g=r.game;const p=tiles.placements(g.boards.p0,g.dice[0])[0];
  r.railroadPlace('p0',0,p.x,p.y,p.rotation,p.flipped);
  const data=JSON.parse(JSON.stringify(r));r=Room.fromData(data);r.setConnected('p0',true);
  assert.deepEqual(r.game.boards,data.game.boards);assert.deepEqual(r.game.dice,data.game.dice);assert.equal(r.viewFor('p0').railroad.canUndo,true);
  for(let round=1;round<=7;round++)playRound(r);
  assert.equal(r.status,'finished');assert.equal(r.game.round,7);assert.equal(r.game.rolls.length,7);
  assert.equal(r.game.winner,'p0');assert.ok(Number.isInteger(r.viewFor('p0').railroad.scores.p0.total));
  assert.ok(r.railroadUndo('p0').error);assert.ok(r.playAgain().ok);assert.ok(r.pastGames[0].railroad.scores.p0);
  assert.ok(r.startGame().ok);assert.equal(r.game.round,1);
});
test('shared dice, independent boards, spectators, offline users, and multiplayer round synchronization',()=>{
  const r=room(2),g=r.game;
  r.joinInProgress('watch','Watcher');assert.equal(r.viewFor('watch').railroad.canBuild,false);assert.ok(r.railroadFinishRound('watch').error);
  const p=tiles.placements(g.boards.p0,g.dice[0])[0];r.railroadPlace('p0',0,p.x,p.y,p.rotation,p.flipped);
  assert.equal(g.boards.p1.filter(Boolean).length,0);assert.equal(g.usedDice.p1.length,0);
  r.setConnected('p0',false);assert.ok(r.railroadUndo('p0').error);r.setConnected('p0',true);
  for(let round=1;round<=7;round++)playRound(r);
  assert.equal(r.status,'finished');assert.equal(Object.keys(g.finalScores).length,2);
});
test('payload validation and one-player public/private start requirements',()=>{
  assert.equal(moduleGame.canStart({},new Map()),false);
  assert.equal(moduleGame.canStart({},new Map([['p',{connected:true}]])),true);
  assert.equal(validPayload('find-game',{name:'Solo',gameType:'railroad'}),true);
  const payload={source:0,x:1,y:0,rotation:0,flipped:false};assert.equal(validPayload('railroad-place',payload),true);
  for(const patch of [{source:4},{source:'oops'},{x:7},{y:-1},{rotation:4},{flipped:'false'}])assert.equal(validPayload('railroad-place',{...payload,...patch}),false);
  assert.equal(validPayload('railroad-undo',{}),true);assert.equal(validPayload('railroad-finish-round',{}),true);
});

test('ties use fewer errors, then share victory; forced ending still reports numeric scores',()=>{
  const r=room(2),g=r.game;g.round=7;
  g.usedDice={p0:[0,1,2,3],p1:[0,1,2,3]};
  // An isolated centre route earns 1 length + 1 centre - 2 errors = 0.
  g.boards.p1[24]=tile('highway-straight');
  assert.ok(r.railroadFinishRound('p0').ok);assert.equal(g.round,7);assert.equal(g.finished,false);
  assert.ok(r.railroadUndo('p0').error);
  assert.ok(r.railroadFinishRound('p1').ok);assert.equal(g.winner,'p0');
  assert.equal(g.finalScores.p0.total,g.finalScores.p1.total);
  const tied=room(2);tied.game.round=7;tied.game.usedDice={p0:[0,1,2,3],p1:[0,1,2,3]};
  tied.railroadFinishRound('p0');tied.railroadFinishRound('p1');assert.equal(tied.game.winner,'draw');
  const ended=room();ended.forceEndGame();assert.equal(ended.viewFor('p0').railroad.scores.p0.total,0);
});
