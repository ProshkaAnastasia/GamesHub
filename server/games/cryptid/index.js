const { shuffle } = require('../decoder/words');
const rules = require('./rules');
class CryptidGame {
  constructor(players) {
    this.players = players;
    this.playerIds = shuffle([...players.values()].filter(p=>p.connected).map(p=>p.id));
    this.names = Object.fromEntries(this.playerIds.map(id=>[id,players.get(id).name]));
    const puzzle = rules.generatePuzzle(this.playerIds.length);
    this.cells = puzzle.cells;
    this.clues = Object.fromEntries(this.playerIds.map((id,i)=>[id,puzzle.clues[i]]));
    this.solution = puzzle.solution;
    this.markers = Object.fromEntries(this.cells.map(c=>[c.id,[]]));
    this.turn = 0;
    this.round = 1;
    this.setupCount = 0;
    this.phase = 'setup';
    this.searchCell = null;
    this.lastAction = null;
    this.log = [];
    this.finished = false;
    this.winner = null;
    this.winReason = null;
  }
  static create(players) { return new CryptidGame(players); }
  static fromData(data,players) { const game=Object.create(CryptidGame.prototype); Object.assign(game,data,{players});return game; }
  toJSON() { const {players,...data}=this;return data; }
  get currentPlayerId() { return this.playerIds[this.turn % this.playerIds.length]; }
  participant(id) { return this.playerIds.includes(id) && this.players.get(id)?.connected && !this.players.get(id)?.left && this.players.get(id)?.role !== 'spectator'; }
  active(id) { return !this.finished && this.currentPlayerId === id && this.participant(id); }
  agrees(id,cell) { return rules.matches(this.cells,this.clues[id],cell); }
  hasCube(cell) { return this.markers[cell]?.some(m=>m.kind==='cube'); }
  hasPiece(id,cell) { return this.markers[cell]?.some(m=>m.playerId===id); }
  available(cell) { return Number.isInteger(cell) && cell>=0 && cell<this.cells.length && !this.hasCube(cell); }
  addMarker(id,cell,kind) { this.markers[cell].push({playerId:id,kind}); }
  legalMarkers(id,kind) { return this.cells.filter(c=>this.available(c.id)&&!this.hasPiece(id,c.id)&&this.agrees(id,c.id)===(kind==='disc')).map(c=>c.id); }
  nextTurn() { this.turn++;this.round++;this.phase='turn';this.searchCell=null; }
  compensate() {
    if(this.legalMarkers(this.currentPlayerId,'cube').length)this.phase='compensation';
    else {this.log.push({kind:'no-cube-space',playerId:this.currentPlayerId});this.nextTurn();}
  }
  placeMarker(id,cell) {
    if(!this.active(id)||!['setup','compensation','search-disc'].includes(this.phase))return {error:'Сейчас не время ставить маркер'};
    const kind=this.phase==='search-disc'?'disc':'cube';
    if(!this.available(cell)||this.hasPiece(id,cell))return {error:'Здесь уже есть кубик или ваш маркер. Выберите другую клетку'};
    if(this.agrees(id,cell)!==(kind==='disc'))return {error:kind==='cube'?'По вашей подсказке существо здесь возможно. Для кубика выберите клетку, где его быть не может':'По вашей подсказке существо здесь невозможно. Для диска выберите подходящую клетку'};
    this.addMarker(id,cell,kind);this.log.push({kind,playerId:id,cell});
    if(this.phase==='setup') {
      this.setupCount++;this.turn++;
      if(this.setupCount===this.playerIds.length*2){this.turn=0;this.phase='turn';}
    } else if(this.phase==='search-disc')this.resolveSearch();
    else this.nextTurn();
    return {ok:true};
  }
  question(id,target,cell) {
    if(!this.active(id)||this.phase!=='turn')return {error:'Сейчас не ваш ход'};
    if(!this.playerIds.includes(target)||target===id)return {error:'Выберите другого участника'};
    if(!this.available(cell)||this.hasPiece(target,cell))return {error:'На клетке есть кубик или ответ этого игрока уже известен'};
    const yes=this.agrees(target,cell);
    this.addMarker(target,cell,yes?'disc':'cube');
    this.lastAction={kind:'question',playerId:id,target,cell,yes};this.log.push({...this.lastAction});
    if(yes)this.nextTurn();else this.compensate();
    return {ok:true};
  }
  search(id,cell) {
    if(!this.active(id)||this.phase!=='turn')return {error:'Сейчас не ваш ход'};
    if(!this.available(cell))return {error:'Клетка с кубиком исключена из поиска'};
    if(!this.agrees(id,cell))return {error:'Искать можно только там, где существо возможно по вашей подсказке'};
    this.searchCell=cell;
    if(!this.hasPiece(id,cell)) {this.addMarker(id,cell,'disc');this.resolveSearch();}
    else if(this.legalMarkers(id,'disc').length)this.phase='search-disc';
    else this.resolveSearch();
    return {ok:true};
  }
  resolveSearch() {
    const id=this.currentPlayerId,cell=this.searchCell;
    const answers=[];
    for(let offset=1;offset<this.playerIds.length;offset++){
      const target=this.playerIds[(this.turn+offset)%this.playerIds.length];
      if(this.hasPiece(target,cell))continue;
      const yes=this.agrees(target,cell);
      this.addMarker(target,cell,yes?'disc':'cube');answers.push({playerId:target,yes});
      if(!yes){this.lastAction={kind:'search',playerId:id,cell,yes:false,answers};this.log.push({...this.lastAction});this.compensate();return;}
    }
    this.finished=true;this.phase='finished';this.winner=id;
    this.winReason=`${this.names[id]} нашёл существо в клетке ${String.fromCharCode(65+this.cells[cell].col)}${this.cells[cell].row+1}! Все подсказки совпали.`;
    this.lastAction={kind:'search',playerId:id,cell,yes:true,answers};this.log.push({...this.lastAction});
  }
  publicState(reveal=false) {
    return {cells:this.cells,playerIds:this.playerIds,names:this.names,markers:this.markers,currentPlayerId:this.currentPlayerId,
      setupCount:this.setupCount,searchCell:this.searchCell,lastAction:this.lastAction,log:this.log,
      ...(reveal?{solution:this.solution,clues:this.clues}: {})};
  }
  viewFor(id) {
    const canAct=this.active(id);
    return {round:this.round,phase:this.phase,winner:this.winner,winReason:this.winReason,
      cryptid:{...this.publicState(this.finished),myClue:this.clues[id]||null,
        canAct,canMark:canAct&&['setup','compensation','search-disc'].includes(this.phase),canInvestigate:canAct&&this.phase==='turn',
        clueCatalog:rules.catalog().map(c=>({id:c.id,text:c.text}))}};
  }
  getArchiveSummary(){return {cryptid:this.publicState(true)};}
}
module.exports={id:'cryptid',label:'Криптид',teamKeys:[],minPlayers:3,maxPlayers:5,
  startRequirementText:'От 3 до 5 игроков. Найдите единственную клетку по личным подсказкам. Базовый режим на генерируемой карте.',
  canStart:(_order,players)=>{const n=[...players.values()].filter(p=>p.connected).length;return n>=3&&n<=5;},
  create:CryptidGame.create,fromData:CryptidGame.fromData};
