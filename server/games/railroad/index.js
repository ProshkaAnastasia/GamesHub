const {randomInt}=require('crypto');
const tiles=require('../../../public/railroad-tiles');
const {score}=require('./rules');
class RailroadGame {
  constructor(players){
    this.players=players;this.playerIds=[...players.values()].filter(p=>p.connected).map(p=>p.id);
    this.names=Object.fromEntries(this.playerIds.map(id=>[id,players.get(id).name]));
    this.boards=Object.fromEntries(this.playerIds.map(id=>[id,Array(49).fill(null)]));
    this.specialsUsed=Object.fromEntries(this.playerIds.map(id=>[id,[]]));
    this.round=1;this.phase='building';this.rolls=[];this.finished=false;this.winner=null;this.winReason=null;this.finalScores=null;this.roll();
  }
  static create(players){return new RailroadGame(players);}
  static fromData(data,players){const game=Object.create(RailroadGame.prototype);Object.assign(game,data,{players});return game;}
  toJSON(){const {players,...data}=this;return data;}
  roll(){
    this.dice=[...Array.from({length:3},()=>tiles.basic[randomInt(6)]),tiles.transition[randomInt(6)]];
    this.rolls.push([...this.dice]);this.usedDice=Object.fromEntries(this.playerIds.map(id=>[id,[]]));
    this.moves=Object.fromEntries(this.playerIds.map(id=>[id,[]]));this.ready=[];
  }
  participant(id){return this.playerIds.includes(id)&&this.players.get(id)?.connected&&!this.players.get(id)?.left&&this.players.get(id)?.role!=='spectator';}
  canBuild(id){return !this.finished&&this.phase==='building'&&this.participant(id)&&!this.ready.includes(id);}
  specialThisRound(id){return this.moves[id].some(m=>m.special);}
  sourcePiece(id,source){
    if(Number.isInteger(source))return source>=0&&source<4&&!this.usedDice[id].includes(source)?this.dice[source]:null;
    if(tiles.specials.includes(source)&&!this.specialsUsed[id].includes(source)&&this.specialsUsed[id].length<3&&!this.specialThisRound(id))return source;
    return null;
  }
  place(id,source,x,y,rotation,flipped){
    if(!this.canBuild(id))return {error:'Сейчас нельзя изменять поле'};
    const piece=this.sourcePiece(id,source);
    if(!piece)return {error:'Этот кубик или спецмаршрут уже использован либо недоступен'};
    if(!tiles.legal(this.boards[id],piece,x,y,rotation,flipped))return {error:'Маршрут должен соединяться с выходом или сетью; дорога и рельсы напрямую не соединяются'};
    const special=typeof source==='string';
    this.boards[id][y*7+x]={piece,rotation,flipped,round:this.round,source};
    this.moves[id].push({index:y*7+x,source,special});
    if(special)this.specialsUsed[id].push(source);else this.usedDice[id].push(source);
    return {ok:true};
  }
  undo(id){
    if(!this.canBuild(id)||!this.moves[id].length)return {error:'Можно отменять только свои размещения текущего раунда до подтверждения'};
    const move=this.moves[id].pop();this.boards[id][move.index]=null;
    if(move.special)this.specialsUsed[id]=this.specialsUsed[id].filter(s=>s!==move.source);
    else this.usedDice[id]=this.usedDice[id].filter(d=>d!==move.source);
    return {ok:true};
  }
  remainingPlaceable(id){return this.dice.flatMap((piece,index)=>!this.usedDice[id].includes(index)&&tiles.placements(this.boards[id],piece).length?[index]:[]);}
  finishRound(id){
    if(!this.canBuild(id))return {error:'Раунд уже подтверждён или вы наблюдаете'};
    if(this.remainingPlaceable(id).length)return {error:'Сначала разместите оставшиеся кубики, для которых есть допустимое место'};
    this.ready.push(id);
    if(this.playerIds.every(pid=>this.ready.includes(pid))){
      if(this.round===7){
        this.finished=true;this.phase='finished';this.finalScores=Object.fromEntries(this.playerIds.map(pid=>[pid,score(this.boards[pid])]));
        const best=Math.max(...Object.values(this.finalScores).map(s=>s.total));
        const contenders=this.playerIds.filter(pid=>this.finalScores[pid].total===best);
        const fewest=Math.min(...contenders.map(pid=>this.finalScores[pid].errors));
        const winners=contenders.filter(pid=>this.finalScores[pid].errors===fewest);
        this.winner=winners.length===1?winners[0]:'draw';
        this.winReason=this.playerIds.length===1?`Ваша сеть: ${best} очков за 7 раундов.`:`${winners.map(pid=>this.names[pid]).join(', ')} — ${best} очков${winners.length>1?'. Разделённая победа!':'.'} При равных очках сравниваем обрывы.`;
      }else{this.round++;this.roll();}
    }
    return {ok:true};
  }
  publicState(){return {playerIds:this.playerIds,names:this.names,boards:this.boards,dice:this.dice,usedDice:this.usedDice,specialsUsed:this.specialsUsed,ready:this.ready,rolls:this.rolls,
    scores:this.finalScores||Object.fromEntries(this.playerIds.map(id=>[id,score(this.boards[id],this.finished)]))};}
  viewFor(id){
    const canBuild=this.canBuild(id),remaining=canBuild?this.remainingPlaceable(id):[];
    return {round:this.round,phase:this.phase,winner:this.winner,winReason:this.winReason,
      railroad:{...this.publicState(),canBuild,canUndo:canBuild&&this.moves[id].length>0,canFinish:canBuild&&!remaining.length,remainingPlaceable:remaining,
        specialThisRound:this.playerIds.includes(id)?this.specialThisRound(id):false}};
  }
  getArchiveSummary(){return {railroad:{...this.publicState(),scores:this.finalScores||Object.fromEntries(this.playerIds.map(id=>[id,score(this.boards[id])]))}};}
}
module.exports={id:'railroad',label:'Railroad Ink',teamKeys:[],minPlayers:1,maxPlayers:6,
  startRequirementText:'От 1 до 6 игроков. Семь раундов: общие кубики маршрутов, личное поле дорог и железных дорог.',
  canStart:(_order,players)=>{const n=[...players.values()].filter(p=>p.connected).length;return n>=1&&n<=6;},
  create:RailroadGame.create,fromData:RailroadGame.fromData};
