const {randomInt}=require('node:crypto');
const {board,chance,chest}=require('./board');
const {shuffle}=require('../decoder/words');
const ok={ok:true},error=message=>({error:message});
class Monopoly {
 constructor(players){
  this.players=players;this.playerIds=shuffle([...players.values()].filter(p=>p.connected&&!p.left).map(p=>p.id));
  this.names=Object.fromEntries(this.playerIds.map(id=>[id,players.get(id).name]));
  this.accounts=Object.fromEntries(this.playerIds.map(id=>[id,{cash:1500,position:0,jail:0,inJail:false,bankrupt:false,free:[]}]));
  this.properties=Object.fromEntries(board.filter(b=>b.price).map(b=>[b.id,{owner:null,level:0,mortgaged:false}]));
  this.decks={chance:shuffle(chance.map((_,i)=>i)),chest:shuffle(chest.map((_,i)=>i))};
  this.currentPlayerId=this.playerIds[0];this.stage='roll';this.phase='playing';this.round=1;this.doubles=0;this.dice=null;
  this.payments=[];this.debt=null;this.purchase=null;this.auction=null;this.bankAuctions=[];this.trade=null;this.log=[];this.lastCard=null;
  this.finished=false;this.winner=null;this.winReason=null;this.revision=0;
 }
 static create(players){return new Monopoly(players);}
 static fromData(data,players){return Object.assign(Object.create(Monopoly.prototype),data,{players});}
 toJSON(){const {players,...data}=this;return data;}
 active(id){return this.playerIds.includes(id)&&!this.accounts[id].bankrupt;}
 alive(){return this.playerIds.filter(id=>this.active(id));}
 note(text){this.log.push(text);if(this.log.length>160)this.log.shift();}
 blocked(){return !!(this.debt||this.auction||this.purchase);}
 group(cell){return board.filter(b=>b.type==='street'&&b.group===cell.group);}
 ownsGroup(id,cell){return this.group(cell).every(b=>this.properties[b.id].owner===id);}
 bank(){let houses=32,hotels=12;for(const p of Object.values(this.properties)){if(p.level===5)hotels--;else houses-=p.level;}return {houses,hotels};}
 rent(index,dice=7,special=null){
  const b=board[index],p=this.properties[index];if(!p?.owner||p.mortgaged)return 0;
  if(b.type==='street')return b.rents[p.level]*(p.level===0&&this.ownsGroup(p.owner,b)?2:1);
  const count=board.filter(c=>c.type===b.type&&this.properties[c.id].owner===p.owner).length;
  return b.type==='rail'?25*2**(count-1)*(special==='rail'?2:1):dice*(special==='utility'||count===2?10:4);
 }
 queue(from,to,amount){if(amount>0)this.payments.push({from,to,amount});}
 settle(){
  this.debt=null;
  while(this.payments.length){const p=this.payments[0];if(!this.active(p.from)||p.to&&!this.active(p.to)){this.payments.shift();continue;}
   if(this.accounts[p.from].cash<p.amount){this.debt={...p};return;}
   this.accounts[p.from].cash-=p.amount;if(p.to)this.accounts[p.to].cash+=p.amount;this.note(`${this.names[p.from]} платит ${p.amount}: ${p.to?this.names[p.to]:'банк'}.`);this.payments.shift();
  }
 }
 jail(id){const a=this.accounts[id];a.position=10;a.inJail=true;a.jail=0;this.stage='end';this.doubles=0;this.note(`${this.names[id]} отправляется в тюрьму.`);}
 move(id,target,salary=true){const a=this.accounts[id];if(salary&&target<a.position){a.cash+=200;this.note(`${this.names[id]} получает 200 за круг.`);}a.position=target;}
 land(id,special=null,depth=0){
  if(depth>5)return;const a=this.accounts[id],b=board[a.position],p=this.properties[b.id];this.note(`${this.names[id]}: ${b.name}.`);
  if(p){if(!p.owner)this.purchase={playerId:id,index:b.id};else if(p.owner!==id){const dice=special==='utility'?this.die()+this.die():this.dice?.reduce((s,n)=>s+n,0)||7;this.queue(id,p.owner,this.rent(b.id,dice,special));}return;}
  if(b.type==='tax')this.queue(id,null,b.amount);
  if(b.type==='gotojail')this.jail(id);
  if(b.type==='chance'||b.type==='chest'){
   const deck=b.type,num=this.decks[deck].shift(),card=(deck==='chance'?chance:chest)[num];this.lastCard={deck,text:card.text};this.note(card.text);
   if(card.free)a.free.push({deck,num});else this.decks[deck].push(num);
   if(card.money>0)a.cash+=card.money;if(card.money<0)this.queue(id,null,-card.money);
   if(card.jail)this.jail(id);
   if(card.each)for(const other of this.alive().filter(x=>x!==id))this.queue(card.each>0?other:id,card.each>0?id:other,Math.abs(card.each));
   if(card.repairs){let cost=0;for(const [index,owned] of Object.entries(this.properties))if(owned.owner===id)cost+=owned.level===5?card.repairs[1]:owned.level*card.repairs[0];this.queue(id,null,cost);}
   if(card.move!==undefined){this.move(id,card.move);this.land(id,null,depth+1);}
   if(card.back){this.move(id,(a.position-card.back+40)%40,false);this.land(id,null,depth+1);}
   if(card.nearest){let target=(a.position+1)%40;while(board[target].type!==card.nearest)target=(target+1)%40;this.move(id,target);this.land(id,card.nearest,depth+1);}
  }
 }
 die(){return randomInt(1,7);}
 next(){const alive=this.alive();this.currentPlayerId=alive.find(id=>this.playerIds.indexOf(id)>this.playerIds.indexOf(this.currentPlayerId))||alive[0];this.stage='roll';this.doubles=0;this.round++;this.trade=null;}
 checkWin(){const a=this.alive();if(a.length===1){this.finished=true;this.phase='finished';this.winner=a[0];this.winReason=`${this.names[a[0]]} — последний игрок, сохранивший капитал.`;this.trade=null;this.debt=null;this.auction=null;this.purchase=null;}}
 startAuction(index){this.auction={index,bid:0,leader:null,passed:[],turn:this.alive()[0]};this.trade=null;this.note(`Аукцион: ${board[index].name}.`);}
 auctionStep(){
  const a=this.auction,eligible=this.alive().filter(id=>!a.passed.includes(id));
  if(!eligible.length||eligible.length===1&&eligible[0]===a.leader){
   if(a.leader){this.accounts[a.leader].cash-=a.bid;this.properties[a.index].owner=a.leader;this.note(`${this.names[a.leader]} покупает ${board[a.index].name} за ${a.bid}.`);}else this.note('Аукцион завершён без покупки.');
   this.auction=null;if(this.bankAuctions.length)this.startAuction(this.bankAuctions.shift());return;
  }
  const start=this.playerIds.indexOf(a.turn);for(let step=1;step<=this.playerIds.length;step++){const id=this.playerIds[(start+step)%this.playerIds.length];if(eligible.includes(id)&&id!==a.leader){a.turn=id;return;}}
 }
 assetAllowed(id){return this.active(id)&&(!this.auction||this.auction.turn===id)&&(!this.purchase||this.purchase.playerId===id)&&(!this.debt||this.debt.from===id);}
 manage(id,action,index){
  const b=board[index],p=this.properties[index],a=this.accounts[id];if(!this.assetAllowed(id)||!p||p.owner!==id)return error('Сейчас нельзя изменить этот участок');
  const group=b.type==='street'?this.group(b):[b];
  if(action==='mortgage'){
   if(p.mortgaged||group.some(c=>this.properties[c.id].level))return error('Сначала продайте все здания цветовой группы');
   p.mortgaged=true;a.cash+=b.price/2;
  }else if(action==='redeem'){
   const cost=Math.ceil(b.price/2*1.1);if(this.debt||this.auction||!p.mortgaged||a.cash<cost)return error('Недостаточно денег для выкупа с 10%');p.mortgaged=false;a.cash-=cost;
  }else if(action==='build'){
   if(this.debt||this.auction||b.type!=='street'||!this.ownsGroup(id,b)||group.some(c=>this.properties[c.id].mortgaged)||p.level===5||a.cash<b.house)return error('Нужна полная незаложенная группа и деньги на строительство');
   if(p.level>Math.min(...group.map(c=>this.properties[c.id].level)))return error('Стройте равномерно');
   const bank=this.bank();if(p.level===4?bank.hotels<1:bank.houses<1)return error('В банке закончились здания этого типа');p.level++;a.cash-=b.house;
  }else if(action==='sell-group'){
   if(b.type!=='street'||!this.ownsGroup(id,b)||!group.some(c=>this.properties[c.id].level))return error('В этой группе нет ваших зданий');
   for(const c of group){a.cash+=this.properties[c.id].level*c.house/2;this.properties[c.id].level=0;}
  }else if(action==='sell'){
   if(!p.level||p.level<Math.max(...group.map(c=>this.properties[c.id].level)))return error('Продавайте здания равномерно');
   if(p.level===5&&this.bank().houses<4)return error('В банке нет четырёх домов для размена отеля');p.level--;a.cash+=b.house/2;
  }else return error('Неизвестное действие');
  this.trade=null;this.note(`${this.names[id]}: ${action==='build'?'строительство':action==='sell'?'продажа здания':action==='mortgage'?'залог':'выкуп'} — ${b.name}.`);this.settle();return ok;
 }
 liquidValue(id){return this.accounts[id].cash+Object.entries(this.properties).reduce((sum,[i,p])=>sum+(p.owner===id?(!p.mortgaged?board[i].price/2:0)+p.level*(board[i].house||0)/2:0),0);}
 bankrupt(id){
  if(this.debt?.from!==id)return error('Банкротство возможно при непогашенном долге');
  if(this.liquidValue(id)>=this.debt.amount)return error('У вас ещё достаточно имущества: продайте здания или заложите участки');
  const creditor=this.debt.to,a=this.accounts[id];if(creditor)this.accounts[creditor].cash+=a.cash;a.cash=0;a.bankrupt=true;
  const fees=[];for(const [index,p] of Object.entries(this.properties))if(p.owner===id){
   if(creditor){this.accounts[creditor].cash+=p.level*(board[index].house||0)/2;p.level=0;p.owner=creditor;if(p.mortgaged)fees.push({from:creditor,to:null,amount:Math.ceil(board[index].price/20)});}
   else{p.owner=null;p.level=0;p.mortgaged=false;this.bankAuctions.push(Number(index));}
  }
  if(creditor)this.accounts[creditor].free.push(...a.free);else for(const c of a.free)this.decks[c.deck].push(c.num);a.free=[];
  this.payments.shift();this.payments.unshift(...fees);this.debt=null;this.trade=null;this.note(`${this.names[id]} объявлен банкротом.`);if(id===this.currentPlayerId)this.next();this.settle();this.checkWin();
  if(!this.finished&&!this.debt&&this.bankAuctions.length)this.startAuction(this.bankAuctions.shift());return ok;
 }
 validTrade(t){
  if(!t||!this.active(t.from)||!this.active(t.to)||t.from===t.to)return false;
  for(const [id,ids,cash,free] of [[t.from,t.give,t.cashGive,t.freeGive||0],[t.to,t.take,t.cashTake,t.freeTake||0]]){
   if(!Number.isInteger(free)||free<0||free>this.accounts[id].free.length)return false;
   if(!Number.isInteger(cash)||cash<0||cash>this.accounts[id].cash||!Array.isArray(ids)||new Set(ids).size!==ids.length)return false;
   if(ids.some(i=>!Number.isInteger(i)||!this.properties[i]||this.properties[i].owner!==id||board[i].type==='street'&&this.group(board[i]).some(c=>this.properties[c.id].level)))return false;
  }
  const fee=ids=>ids.reduce((s,i)=>s+(this.properties[i].mortgaged?Math.ceil(board[i].price/20):0),0);
  return this.accounts[t.from].cash-t.cashGive+t.cashTake>=fee(t.take)&&this.accounts[t.to].cash-t.cashTake+t.cashGive>=fee(t.give);
 }
 action(id,p){
  if(this.finished||!this.active(id)||!this.players.get(id)?.connected||this.players.get(id)?.left)return error('Вы наблюдаете за игрой');
  const type=p.action,a=this.accounts[id],turn=id===this.currentPlayerId;
  if(['mortgage','redeem','build','sell','sell-group'].includes(type)){const result=this.manage(id,type,p.index);if(result.ok)this.revision++;return result;}
  if(type==='bankrupt')return this.bankrupt(id);
  if(type==='bid'||type==='pass'){
   const auction=this.auction;if(!auction||auction.turn!==id)return error('Дождитесь своей очереди на аукционе');
   if(type==='bid'){if(!Number.isInteger(p.amount)||p.amount<=auction.bid||p.amount>a.cash)return error('Ставка должна превышать текущую и быть вам по средствам');auction.bid=p.amount;auction.leader=id;}else auction.passed.push(id);
   this.auctionStep();this.revision++;return ok;
  }
  if(type==='trade-offer'){
   if(this.auction||this.purchase||this.trade||this.debt&&this.debt.from!==id||!this.debt&&!turn)return error('Обмен предлагает текущий игрок или должник вне аукциона');
   const t={from:id,to:p.target,give:p.give,take:p.take,cashGive:p.cashGive,cashTake:p.cashTake,freeGive:p.freeGive||0,freeTake:p.freeTake||0};if(!this.validTrade(t))return error('Проверьте деньги, владельцев и отсутствие зданий в группах');this.trade=t;return ok;
  }
  if(type==='trade-reject'){if(!this.trade||![this.trade.from,this.trade.to].includes(id))return error('Это не ваше предложение');this.trade=null;return ok;}
  if(type==='trade-accept'){
   const t=this.trade;if(this.auction||this.purchase||this.debt&&this.debt.from!==t?.from||!t||t.to!==id||!this.validTrade(t))return error('Предложение больше недействительно');
   this.accounts[t.from].cash+=t.cashTake-t.cashGive;this.accounts[t.to].cash+=t.cashGive-t.cashTake;
   for(const [ids,to] of [[t.give,t.to],[t.take,t.from]])for(const i of ids){this.properties[i].owner=to;if(this.properties[i].mortgaged)this.accounts[to].cash-=Math.ceil(board[i].price/20);}
   const giveCards=this.accounts[t.from].free.splice(0,t.freeGive||0),takeCards=this.accounts[t.to].free.splice(0,t.freeTake||0);
   this.accounts[t.from].free.push(...takeCards);this.accounts[t.to].free.push(...giveCards);
   this.trade=null;this.settle();this.note(`${this.names[t.from]} и ${this.names[t.to]} заключили сделку.`);this.revision++;return ok;
  }
  if(!turn||this.debt||this.auction)return error('Сейчас действие недоступно');
  if(type==='buy'||type==='auction'){
   if(this.purchase?.playerId!==id)return error('Сейчас нет участка для покупки');const i=this.purchase.index;
   if(type==='buy'){if(a.cash<board[i].price)return error('Недостаточно денег — выставьте участок на аукцион');a.cash-=board[i].price;this.properties[i].owner=id;this.note(`${this.names[id]} покупает ${board[i].name}.`);this.purchase=null;}
   else{this.purchase=null;this.startAuction(i);}this.revision++;return ok;
  }
  if(this.purchase)return error('Сначала решите вопрос с покупкой');
  if(type==='end'){
   if(this.stage!=='end')return error('Сначала бросьте кубики');this.next();return ok;
  }
  if(type==='jail-pay'||type==='jail-card'){
   if(this.stage!=='roll'||!a.inJail)return error('Сейчас вы не в тюрьме');
   if(type==='jail-pay'){if(a.cash<50)return error('Нужно 50: заложите участок или продайте здания');a.cash-=50;}
   else{const c=a.free.shift();if(!c)return error('Нет карты выхода из тюрьмы');this.decks[c.deck].push(c.num);}
   a.inJail=false;a.jail=0;return ok;
  }
  if(type==='roll'){
   if(this.stage!=='roll')return error('Кубики уже брошены');this.trade=null;this.dice=[this.die(),this.die()];const sum=this.dice[0]+this.dice[1],double=this.dice[0]===this.dice[1];this.note(`${this.names[id]} выбрасывает ${this.dice.join(' + ')}.`);
   if(a.inJail){
    if(double){a.inJail=false;a.jail=0;this.stage='end';}
    else if(++a.jail<3){this.stage='end';return ok;}
    else{a.inJail=false;a.jail=0;this.stage='end';this.queue(id,null,50);this.afterDebtMove={id,sum};this.settle();if(this.debt)return ok;this.afterDebtMove=null;}
   }else{this.doubles=double?this.doubles+1:0;if(this.doubles===3){this.jail(id);return ok;}this.stage=double?'roll':'end';}
   this.move(id,(a.position+sum)%40);this.land(id);this.settle();this.revision++;return ok;
  }
  return error('Неизвестное действие');
 }
 dispatch(id,p){
  const result=this.action(id,p);if(result.ok){
   if(!this.debt&&this.afterDebtMove){const {id:pid,sum}=this.afterDebtMove;this.afterDebtMove=null;if(this.active(pid)){this.move(pid,(this.accounts[pid].position+sum)%40);this.land(pid);this.settle();}}
   if(!this.finished&&!this.debt&&!this.auction&&this.bankAuctions.length)this.startAuction(this.bankAuctions.shift());
  }return result;
 }
 publicState(){return {board,playerIds:this.playerIds,names:this.names,accounts:this.accounts,properties:this.properties,currentPlayerId:this.currentPlayerId,stage:this.stage,doubles:this.doubles,dice:this.dice,debt:this.debt,purchase:this.purchase,auction:this.auction,trade:this.trade,bank:this.bank(),lastCard:this.lastCard,log:this.log};}
 viewFor(id){return {round:this.round,phase:this.phase,winner:this.winner,winReason:this.winReason,monopoly:{...this.publicState(),canAct:this.active(id)&&!!this.players.get(id)?.connected}};}
 getArchiveSummary(){return {monopoly:this.publicState()};}
}
module.exports={id:'monopoly',label:'Монополия',teamKeys:[],minPlayers:2,maxPlayers:6,startRequirementText:'2–6 игроков. Классические правила, улицы Москвы, аукционы и сделки.',canStart:(_,players)=>{const n=[...players.values()].filter(p=>p.connected&&!p.left).length;return n>=2&&n<=6;},create:Monopoly.create,fromData:Monopoly.fromData,Monopoly};
