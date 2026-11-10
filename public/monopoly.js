(() => {
 const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
 // Soft player colors stay consistent between pieces, ownership and the roster.
 const colors=['#c4b2ed','#f4b8c6','#a9dfd4','#b7c9ee','#e9c5a5','#d3d9ad'],tokens=['●','◆','▲','■','⬟','★'];
 const propertyArt=new Set([1, 3, 6, 8, 9, 11, 13, 14, 16]);
 let view,emit,selected=0,busy=false,error='',draft={},roomKey=null,seenEventKey=null,shownEvent=null;
 const money=n=>Number(n).toLocaleString('ru-RU');
 const billValues=[500,100,50,20,10,5,1],billImages=new Set([1,5,10,20,50,100,500]);
 function wallet(amount,id,open){
  let remaining=amount;const notes=billValues.flatMap(value=>{const count=Math.floor(remaining/value);remaining%=value;if(!count)return [];
   const face=billImages.has(value)?`<img src="monopoly/money/money-${value}.png" alt="Купюра ${value}" width="1774" height="887" loading="lazy">`:`<span class="mp-banknote-placeholder" aria-label="Купюра ${value}">${value}</span>`;
   return [`<div class="mp-banknote" data-value="${value}" data-count="${count}">${face}<span>${value} × ${count}</span></div>`];
  }).join('');
  return `<details class="mp-wallet" data-wallet="${esc(id)}" ${open?'open':''}><summary>Купюры</summary><div class="mp-wallet-notes">${notes||'<span class="hint-text">Наличных нет</span>'}</div></details>`;
 }
 const button=(action,label,disabled=false)=>`<button class="btn btn-secondary" data-mp-action="${action}" ${disabled?'disabled':''}>${label}</button>`;
 function buildings(level){
  const hotel=level===5,count=hotel?1:level,label=hotel?'Отель':`Домов: ${level}`;
  return `<span class="mp-buildings ${hotel?'mp-buildings-hotel':''}" role="img" aria-label="${label}">${Array.from({length:count},()=>`<img src="monopoly/buildings/${hotel?'hotel':'house'}.png" alt="" width="1254" height="1254">`).join('')}</span>`;
 }
 function fieldRent(g,b,p){
  if(!p)return b.type==='tax'?'−'+b.amount:b.type==='go'?'+200':'';
  if(!p.owner)return money(b.price);
  if(p.mortgaged)return '0';
  if(b.type==='street'){
   const full=g.board.filter(c=>c.type==='street'&&c.group===b.group).every(c=>g.properties[c.id].owner===p.owner);
   return money(b.rents[p.level]*(p.level===0&&full?2:1));
  }
  const count=g.board.filter(c=>c.type===b.type&&g.properties[c.id].owner===p.owner).length;
  return b.type==='rail'?money(25*2**(count-1)):`Бросок ×${count===2?10:4}`;
 }
 function position(i){if(i<=10)return [11,11-i];if(i<=20)return [21-i,1];if(i<=30)return [1,i-19];return [i-29,11];}
 // Keep whole words visible even on the narrowest board cells.
 function fitStreetNames(){
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d');if(!context)return;
  document.querySelectorAll('#mp-board .mp-cell-name').forEach(label=>{
   label.style.removeProperty('font-size');
   const full=label.dataset.fullName||label.textContent,compact=$('#mp-board').clientWidth<600;
   label.textContent=compact?full.replace(/^Улица /,'').replace(/ улица$/,'').replace(/ железная дорога$/,'').replace('Общественная казна','Казна').replace('Отправляйтесь в тюрьму','В тюрьму').replace('Тюрьма / посещение','Тюрьма').replace('Бесплатная стоянка','Стоянка').replace('Подоходный налог','Налог').replace('Добавочный налог','Налог'):full;
   const width=label.parentElement.clientWidth-6;if(width<=0)return;
   const style=getComputedStyle(label);context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
   const longest=Math.max(...label.textContent.trim().split(/\s+/).map(word=>context.measureText(word).width));
   if(longest>width)label.style.fontSize=`${Math.floor(parseFloat(style.fontSize)*width/longest*10)/10}px`;
  });
 }
 window.addEventListener('resize',()=>{fitStreetNames();placeEventCard();});
 document.fonts?.ready.then(fitStreetNames);
 function boardMarkup(g){
  const cells=g.board.map(b=>{const p=g.properties[b.id],[row,col]=position(b.id),occupants=g.playerIds.filter(id=>!g.accounts[id].bankrupt&&g.accounts[id].position===b.id);
   return `<button class="mp-cell ${selected===b.id?'mp-selected':''} ${p?.mortgaged?'mp-mortgaged':''} ${p?.owner?'mp-owned':''} ${occupants.length?'mp-occupied':''} ${occupants.includes(g.currentPlayerId)?'mp-current-position':''}" data-mp-cell="${b.id}" ${occupants.includes(g.currentPlayerId)?'aria-current="location"':''} style="grid-row:${row};grid-column:${col};--mp-color:${b.color||'#60767b'};--owner-color:${p?.owner?colors[g.playerIds.indexOf(p.owner)]:'transparent'};--occupant-color:${colors[g.playerIds.indexOf(occupants.includes(g.currentPlayerId)?g.currentPlayerId:occupants[0])]||'transparent'}" aria-label="${esc(b.name)}${p?.owner?', владелец '+esc(g.names[p.owner]):''}${p?.level?(p.level===5?', отель':', домов: '+p.level):''}"><span class="mp-stripe"></span><span class="mp-cell-name" data-full-name="${esc(b.name)}">${esc(b.name)}</span><small class="mp-cell-cost" title="${p?(p.owner?'Аренда для соперника':'Цена покупки'):''}"><span class="mp-cell-amount">${fieldRent(g,b,p)}</span>${p?.level?buildings(p.level):''}</small><span class="mp-tokens">${occupants.map(id=>`<b style="color:${colors[g.playerIds.indexOf(id)]}" title="${esc(g.names[id])}">${tokens[g.playerIds.indexOf(id)]}</b>`).join('')}</span>${p?.owner?`<span class="mp-owner" title="Владелец: ${esc(g.names[p.owner])}" aria-hidden="true"></span>`:''}</button>`;
  }).join('');
  const decks=`<div class="mp-decks">${['chance','chest'].map(deck=>`<figure><img src="monopoly/events/${deck}-back.png" alt="Рубашка колоды ${deck==='chance'?'Шанс':'Общественная казна'}" width="72" height="108"><figcaption>${deck==='chance'?'Шанс':'Казна'}</figcaption></figure>`).join('')}</div>`;
  const event=shownEvent?`<article class="mp-event-card mp-event-${shownEvent.deck}" aria-live="polite"><button class="mp-event-dismiss" data-mp-dismiss-event aria-label="Закрыть карту события" title="Закрыть карту">×</button><div class="mp-event-copy"><h3>${shownEvent.deck==='chance'?'Шанс':'Общественная казна'}</h3><p>${esc(shownEvent.text)}</p></div></article>`:'';
  return `${cells}<div class="mp-center"><span class="field-label">ГОРОД БОЛЬШИХ СДЕЛОК</span><h2>МОСКВА</h2><p>Монополия</p><div class="mp-dice">${g.dice?g.dice.map(n=>`<span>${['','⚀','⚁','⚂','⚃','⚄','⚅'][n]}</span>`).join(''):'⚄ ⚂'}</div><p>${esc(g.names[g.currentPlayerId])}</p><small class="mp-bank-stock">В банке: <img src="monopoly/buildings/house.png" alt=""> ${g.bank.houses} домов · <img src="monopoly/buildings/hotel.png" alt=""> ${g.bank.hotels} отелей</small><div class="mp-card-display">${decks}${event}</div></div>`;
 }
 function property(g,id){
  const b=g.board[selected],p=g.properties[selected];
  if(!p)return `<span class="field-label">КЛЕТКА ${selected+1}</span><h3>${esc(b.name)}</h3><p class="hint-text">${({go:'За проход через старт — 200.',chance:'Возьмите карту «Шанс».',chest:'Возьмите карту казны.',jail:'Посещение бесплатно. Заключённые выходят по правилам тюрьмы.',gotojail:'Переход в тюрьму без выплаты за круг.',tax:'Платёж '+b.amount+'.',parking:'Отдых без выплат.'}[b.type]||'')}</p>`;
  const illustration=propertyArt.has(b.id)?`<img class="mp-deed-art" src="monopoly/properties/street-${String(b.id).padStart(2,'0')}.png" alt="${esc(b.name)}" width="1536" height="1024">`:'';
  let html=`<article class="mp-deed ${illustration?'mp-deed-illustrated':''}"><header style="--deed-color:${b.color||'#60767b'}"><small>КАРТОЧКА СОБСТВЕННОСТИ</small><h3>${esc(b.name)}</h3></header>${illustration}<div class="mp-deed-body"><p class="mp-deed-price">Стоимость: <b>${money(b.price)}</b></p><p>${p.owner?`Владелец: <b>${esc(g.names[p.owner])}</b>`:'Свободный участок'}</p><p>${p.mortgaged?'В залоге · без аренды':p.level===5?'Построен отель':p.level?`Домов: ${p.level}`:'Без зданий'}</p>${p.level?`<div class="mp-deed-buildings">${buildings(p.level)}</div>`:''}`;
  if(b.rents)html+=`<table class="mp-rents"><tbody>${b.rents.map((rent,i)=>`<tr class="${p.level===i?'mp-current-rent':''}"><td>${['Участок','1 дом','2 дома','3 дома','4 дома','Отель'][i]}</td><td>${money(rent)}</td></tr>`).join('')}</tbody></table><p class="mp-deed-note">Дом / отель: ${b.house}. Полная группа без зданий: аренда ×2.</p>`;
  else html+=`<p class="mp-deed-special">${b.type==='rail'?'Аренда за число дорог:<br>1 — 25 · 2 — 50<br>3 — 100 · 4 — 200':'Аренда: бросок ×4.<br>Два предприятия: ×10.'}</p>`;
  html+=`<footer>Залог: <b>${b.price/2}</b><br>Выкуп с процентами: <b>${Math.ceil(b.price/2*1.1)}</b></footer></div></article>`;
  if(g.canAct&&p.owner===id){const disabled=busy||g.auction&&g.auction.turn!==id||g.purchase&&g.purchase.playerId!==id||g.debt&&g.debt.from!==id;html+=`<div class="mp-buttons">${b.type==='street'?button('build','Построить',disabled||!!g.debt||!!g.auction)+button('sell','Продать здание',disabled)+button('sell-group','Продать здания группы',disabled):''}${button(p.mortgaged?'redeem':'mortgage',p.mortgaged?'Выкупить':'Заложить',disabled||p.mortgaged&&!!(g.debt||g.auction))}</div>`;}
  return html;
 }

 function controls(g,id){
  if(!g.canAct)return '<h3>Вы наблюдаете за игрой</h3><p class="hint-text">Можно выбирать участки и смотреть карточки собственности.</p>';
  if(g.debt){const d=g.debt;return `<h3>Нужно заплатить ${money(d.amount)}</h3><p>${esc(g.names[d.from])} → ${esc(d.to?g.names[d.to]:'банк')}</p><p class="hint-text">${d.from===id?'Выберите свой участок: продайте здания или оформите залог. Платёж пройдёт автоматически, когда денег хватит.':'Ждём, пока должник соберёт деньги.'}</p>${d.from===id?button('bankrupt','Объявить банкротство',busy):''}`;}
  if(g.auction){const a=g.auction;return `<span class="field-label">АУКЦИОН</span><h3>${esc(g.board[a.index].name)}</h3><p>Ставка: <b>${money(a.bid)}</b>${a.leader?' · '+esc(g.names[a.leader]):''}</p><p>Предлагает цену: ${esc(g.names[a.turn])}</p><p class="hint-text">${a.passed.map(pid=>esc(g.names[pid])).join(', ')}${a.passed.length?' — пас':''}</p>${a.turn===id?`<label class="field">Ваша ставка<input id="mp-bid" type="number" min="${a.bid+1}" max="${g.accounts[id].cash}" value="${Math.min(g.accounts[id].cash,a.bid+10)}"></label><div class="mp-buttons">${button('bid','Повысить',busy)}${button('pass','Пас',busy)}</div>`:''}`;}
  if(g.purchase)return `<h3>${esc(g.board[g.purchase.index].name)}</h3><p>Цена: ${money(g.board[g.purchase.index].price)}</p>${g.purchase.playerId===id?`<div class="mp-buttons">${button('buy','Купить',busy||g.accounts[id].cash<g.board[g.purchase.index].price)}${button('auction','На аукцион',busy)}</div>`:'<p>Ждём решения покупателя.</p>'}`;
  if(g.currentPlayerId!==id)return '<h3>Ход соперника</h3><p class="hint-text">Можно управлять своим имуществом, выбирая участки на поле.</p>';
  return `<h3>${g.stage==='roll'?'Ваш бросок':'Завершение хода'}</h3>${g.doubles?'<p class="hint-text">Дубль! Дополнительный бросок. Дублей подряд: '+g.doubles+'</p>':''}${g.accounts[id].inJail?`<p>Вы в тюрьме · неудачных попыток: ${g.accounts[id].jail}/3</p><div class="mp-buttons">${button('jail-pay','Выйти за 50',busy||g.stage!=='roll'||g.accounts[id].cash<50)}${button('jail-card','Использовать карту',busy||g.stage!=='roll'||!g.accounts[id].free.length)}</div>`:''}<div class="mp-buttons">${button('roll',g.accounts[id].inJail?'Попробовать дубль':'Бросить кубики',busy||g.stage!=='roll')}${button('end','Завершить ход',busy||g.stage!=='end')}</div>`;
 }
 function tradeMarkup(g,id){
  if(g.trade){const t=g.trade;return `<h3>Предложение обмена</h3><p><b>${esc(g.names[t.from])}</b> отдаёт ${money(t.cashGive)} и ${t.give.map(i=>esc(g.board[i].name)).join(', ')||'без участков'}.</p><p><b>${esc(g.names[t.to])}</b> отдаёт ${money(t.cashTake)} и ${t.take.map(i=>esc(g.board[i].name)).join(', ')||'без участков'}.</p><p>Карты выхода из тюрьмы: ${t.freeGive||0} → ${esc(g.names[t.to])}; ${t.freeTake||0} → ${esc(g.names[t.from])}.</p><p class="hint-text">Получатель заложенных участков сразу платит 10% залога банку.</p><div class="mp-buttons">${t.to===id?button('trade-accept','Принять',busy):''}${[t.from,t.to].includes(id)?button('trade-reject','Отклонить / отменить',busy):''}</div>`;}
  if(!g.canAct||(g.debt?g.debt.from!==id:g.currentPlayerId!==id)||g.auction||g.purchase)return '';
  const targets=g.playerIds.filter(pid=>pid!==id&&!g.accounts[pid].bankrupt),target=targets.includes(draft.target)?draft.target:targets[0];
  const options=pid=>g.board.filter(b=>g.properties[b.id]?.owner===pid&&(b.type!=='street'||!g.board.some(c=>c.type==='street'&&c.group===b.group&&g.properties[c.id].level))).map(b=>`<label class="mp-check"><input type="checkbox" data-mp-trade="${pid===id?'give':'take'}" value="${b.id}" ${(draft[pid===id?'give':'take']||[]).includes(b.id)?'checked':''}>${esc(b.name)}${g.properties[b.id].mortgaged?' (залог)':''}</label>`).join('');
  return `<details id="mp-trade-form" ${draft.open?'open':''}><summary>Предложить обмен</summary><label class="field">Кому<select id="mp-trade-target">${targets.map(pid=>`<option value="${esc(pid)}" ${pid===target?'selected':''}>${esc(g.names[pid])}</option>`).join('')}</select></label><p>Вы отдаёте</p><input id="mp-cash-give" aria-label="Денег от вас" type="number" min="0" max="${g.accounts[id].cash}" value="${draft.cashGive||0}">${options(id)}<label class="field">Карт выхода из тюрьмы от вас<input id="mp-free-give" type="number" min="0" max="${g.accounts[id].free.length}" value="${draft.freeGive||0}"></label><p>Вы получаете</p><input id="mp-cash-take" aria-label="Денег от партнёра" type="number" min="0" max="${g.accounts[target].cash}" value="${draft.cashTake||0}">${options(target)}<label class="field">Карт выхода из тюрьмы от партнёра<input id="mp-free-take" type="number" min="0" max="${g.accounts[target].free.length}" value="${draft.freeTake||0}"></label>${button('trade-offer','Предложить',busy)}</details>`;
 }
 function capture(){if(!$('#mp-trade-form'))return;draft={open:$('#mp-trade-form').open,target:$('#mp-trade-target').value,freeGive:Number($('#mp-free-give').value),freeTake:Number($('#mp-free-take').value),cashGive:Number($('#mp-cash-give').value),cashTake:Number($('#mp-cash-take').value),give:[...document.querySelectorAll('[data-mp-trade="give"]:checked')].map(e=>Number(e.value)),take:[...document.querySelectorAll('[data-mp-trade="take"]:checked')].map(e=>Number(e.value))};}
 function placeEventCard(){
  const card=$('#screen-game-monopoly .mp-event-card'),mobile=$('#mp-mobile-event');
  if(card){const compact=window.matchMedia('(max-width:600px)').matches;(compact?mobile:$('#mp-board .mp-card-display')).appendChild(card);mobile.hidden=!compact;}else mobile.hidden=true;
 }
 function dismissEvent(){shownEvent=null;$('#screen-game-monopoly .mp-event-card')?.remove();$('#mp-mobile-event').hidden=true;}
 function updateEvent(v,isNewRoom){
  const card=v.monopoly.lastCard,key=card?(card.id??`${v.round}:${card.deck}:${card.text}`):null;
  if(isNewRoom){dismissEvent();seenEventKey=key;return;}
  if(key===seenEventKey)return;
  dismissEvent();seenEventKey=key;
  if(card)shownEvent=card;
 }
 function render(v,send){const key=v.code+':'+v.pastGames.length,isNewRoom=roomKey!==key;if(isNewRoom){draft={};selected=0;error='';roomKey=key;}else capture();view=v;emit=send;const g=v.monopoly,id=v.me?.id;updateEvent(v,isNewRoom);
  const openWallets=isNewRoom?new Set():new Set([...document.querySelectorAll('#mp-roster .mp-wallet[open]')].map(e=>e.dataset.wallet));
  $('#mp-roster').innerHTML=g.playerIds.map((pid,i)=>{const a=g.accounts[pid];return `<div class="mp-player ${pid===g.currentPlayerId?'mp-turn':''} ${a.bankrupt?'mp-out':''}" style="--player-color:${colors[i]}"><b title="${esc(g.names[pid])}"><span class="mp-player-token" style="color:${colors[i]}">${tokens[i]}</span> ${esc(g.names[pid])}${pid===id?' · вы':''}</b><strong>${money(a.cash)}</strong><small title="${esc(a.bankrupt?'Банкрот':a.inJail?'В тюрьме':g.board[a.position].name)}">${a.bankrupt?'Банкрот':a.inJail?'В тюрьме':esc(g.board[a.position].name)}${a.free.length?' · 🔑 '+a.free.length:''}</small>${wallet(a.cash,pid,openWallets.has(pid))}</div>`;}).join('');
  $('#mp-status').textContent=g.auction?'Торги за участок':g.debt?'Погашение долга':`Ход: ${g.names[g.currentPlayerId]}`;
  $('#mp-mobile-event').replaceChildren();$('#mp-mobile-event').hidden=true;$('#mp-board').innerHTML=boardMarkup(g);fitStreetNames();placeEventCard();$('#mp-actions').innerHTML=controls(g,id);$('#mp-property').innerHTML=property(g,id);$('#mp-trade').innerHTML=tradeMarkup(g,id);$('#mp-trade').hidden=!$('#mp-trade').innerHTML;$('#mp-log').innerHTML=g.log.slice(-25).reverse().map(t=>`<p>${esc(t)}</p>`).join('');$('#mp-error').hidden=!error;$('#mp-error').textContent=error;$('#btn-force-end-game-monopoly').hidden=!v.canForceEnd;
 }
 $('#mp-board').addEventListener('click',e=>{const cell=e.target.closest('[data-mp-cell]');if(cell){selected=Number(cell.dataset.mpCell);render(view,emit);}});
 $('#mp-trade').addEventListener('change',e=>{capture();if(e.target.id==='mp-trade-target'){draft.take=[];render(view,emit);}});
 $('#screen-game-monopoly').addEventListener('click',async e=>{
  if(e.target.closest('[data-mp-dismiss-event]')){dismissEvent();return;}
  const b=e.target.closest('[data-mp-action]');if(!b||b.disabled||busy)return;capture();const action=b.dataset.mpAction,p={action,index:selected};
  if(action==='bid')p.amount=Number($('#mp-bid').value);
  if(action==='trade-offer')Object.assign(p,{target:draft.target,give:draft.give,take:draft.take,cashGive:draft.cashGive,cashTake:draft.cashTake,freeGive:draft.freeGive,freeTake:draft.freeTake});
  busy=true;error='';render(view,emit);try{const result=await emit('monopoly-action',p);error=result.error||'';}catch{error='Не удалось отправить действие. Проверьте соединение.';}finally{busy=false;render(view,emit);}
 });
 function report(g,selector){const container=$(selector);if(!g){container.innerHTML='';return;}container.innerHTML=`<div class="mp-roster">${g.playerIds.map((id,i)=>`<div class="mp-player" style="--player-color:${colors[i]}"><b>${esc(g.names[id])}</b><strong>${money(g.accounts[id].cash)}</strong><small>${g.accounts[id].bankrupt?'Банкрот':'В игре'}</small></div>`).join('')}</div><details><summary>Журнал</summary>${g.log.map(t=>`<p>${esc(t)}</p>`).join('')}</details>`;}
 window.MonopolyUI={render,report};
})();
