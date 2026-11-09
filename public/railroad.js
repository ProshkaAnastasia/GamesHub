(() => {
  const $=s=>document.querySelector(s),{pieces,specials,orient,legal,exits,directions}=window.RailroadTiles;
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  let current,send,source=null,rotation=0,flipped=false,shown=null,key=null,busy=false;
  const endpoints=[[32,0],[64,32],[32,64],[0,32]];
  function tileArt(piece,rot=0,flip=false) {
    const spec=orient(piece,rot,flip);if(!spec)return '';
    let body='';
    for(const type of ['R','H']){
      const sides=spec.ports.flatMap((t,s)=>t===type?[s]:[]);if(!sides.length)continue;
      const path=sides.map(side=>`M${endpoints[side].join(' ')}L32 32`).join('');
      if(spec.overpass&&type==='H')body+=`<path d="${path}" fill="none" stroke="#12282d" stroke-width="14"/>`;
      if(type==='H')body+=`<path d="${path}" fill="none" stroke="#f0dab3" stroke-width="9" stroke-linecap="butt"/><path d="${path}" fill="none" stroke="#536066" stroke-width="1.6" stroke-dasharray="5 4"/>`;
      else {
        body+=`<path d="${path}" fill="none" stroke="#78c6df" stroke-width="5"/>`;
        for(const side of sides)for(const step of [7,16,25]){
          const [dx,dy]=directions[side],x=32+dx*step,y=32+dy*step;
          body+=`<line x1="${x-dy*5}" y1="${y+dx*5}" x2="${x+dy*5}" y2="${y-dx*5}" stroke="#b5e7f0" stroke-width="2"/>`;
        }
      }
    }
    if(spec.station)body+='<rect x="25" y="25" width="14" height="14" rx="2" fill="#ddb65e" stroke="#18292d" stroke-width="2"/>';
    return `<svg viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
  }
  function sourcePiece(game,id,choice) {
    if(!game.playerIds.includes(id))return null;
    if(Number.isInteger(choice))return !game.usedDice[id].includes(choice)?game.dice[choice]:null;
    if(specials.includes(choice)&&game.specialsUsed[id].length<3&&!game.specialsUsed[id].includes(choice)&&!game.specialThisRound)return choice;
    return null;
  }
  function boardMarkup(board,interactive=false,piece=null) {
    const cells=board.map((tile,index)=>{
      const x=index%7,y=Math.floor(index/7),allowed=interactive&&!tile&&piece&&legal(board,piece,x,y,rotation,flipped),center=x>=2&&x<=4&&y>=2&&y<=4;
      return `<button class="rr-cell ${center?'is-center':''} ${allowed?'is-legal':''}" data-x="${x}" data-y="${y}" ${allowed?'':'disabled'} aria-label="${String.fromCharCode(65+x)}${y+1}${tile?': '+esc(pieces[tile.piece].label):allowed?': разместить маршрут':': недоступно'}">${tile?`${tileArt(tile.piece,tile.rotation,tile.flipped)}<small class="rr-round-mark">${tile.round}</small>`:`<span class="rr-coordinate">${String.fromCharCode(65+x)}${y+1}</span>${allowed?'<span class="rr-plus">+</span>':''}`}</button>`;
    }).join('');
    const gates=exits.map(e=>`<span class="rr-exit rr-exit-${e.side} rr-exit-${e.type}" style="--exit-x:${(e.x+.5)*100/7}%;--exit-y:${(e.y+.5)*100/7}%" title="${e.type==='H'?'Автодорожный':'Железнодорожный'} выход">${e.type==='H'?'═':'╫'}</span>`).join('');
    return `<div class="rr-board-frame"><div class="rr-grid">${cells}</div>${gates}</div>`;
  }
  async function action(event,payload={}) {
    if(busy)return;busy=true;$('#rr-error').hidden=true;render(current,send);
    try {const result=await send(event,payload);$('#rr-error').hidden=!result.error;$('#rr-error').textContent=result.error||'';}
    finally {busy=false;render(current,send);}
  }
  $('#rr-dice').addEventListener('click',e=>{const button=e.target.closest('[data-die]');if(button&&!button.disabled){source=Number(button.dataset.die);rotation=0;flipped=false;render(current,send);}});
  $('#rr-specials').addEventListener('click',e=>{const button=e.target.closest('[data-special]');if(button&&!button.disabled){source=button.dataset.special;rotation=0;flipped=false;render(current,send);}});
  $('#rr-rotate').addEventListener('click',()=>{rotation=(rotation+1)%4;render(current,send);});
  $('#rr-flip').addEventListener('click',()=>{flipped=!flipped;render(current,send);});
  $('#rr-board-tabs').addEventListener('click',e=>{const button=e.target.closest('[data-player]');if(button){shown=button.dataset.player;render(current,send);}});
  $('#rr-board').addEventListener('click',e=>{
    const button=e.target.closest('[data-x]');if(button&&!button.disabled&&current.railroad.canBuild&&shown===current.me.id)action('railroad-place',{source,x:Number(button.dataset.x),y:Number(button.dataset.y),rotation,flipped});
  });
  $('#rr-undo').addEventListener('click',()=>action('railroad-undo'));
  $('#rr-finish').addEventListener('click',()=>action('railroad-finish-round'));
  function render(view,emit) {
    current=view;send=emit;const game=view.railroad,id=view.me.id;
    const nextKey=`${view.code}:${view.pastGames.length}:${view.round}`;
    if(key!==nextKey){key=nextKey;source=null;rotation=0;flipped=false;$('#rr-error').hidden=true;}
    if(!game.playerIds.includes(shown))shown=game.playerIds.includes(id)?id:game.playerIds[0];
    const own=shown===id,editable=own&&game.canBuild&&!busy;
    if(!sourcePiece(game,id,source)&&game.playerIds.includes(id)){
      source=game.dice.findIndex((_,index)=>!game.usedDice[id].includes(index));if(source<0)source=null;rotation=0;flipped=false;
    }
    const piece=game.playerIds.includes(id)?sourcePiece(game,id,source):null;
    $('#btn-force-end-game-railroad').hidden=!view.canForceEnd;
    $('#rr-round').textContent=`Раунд ${view.round} из 7${game.playerIds.length===1?' · одиночная игра':''}`;
    $('#rr-status').textContent=!game.playerIds.includes(id)?'Наблюдаем за строительством':game.canBuild?'Стройте свою сеть':'Ваш раунд подтверждён';
    $('#rr-hint').textContent=game.canBuild?(game.canFinish?'Кубики размещены или больше не помещаются. Можно добавить спецмаршрут или завершить раунд.':'Выберите кубик, поверните маршрут и нажмите на подсвеченную клетку.'):!game.playerIds.includes(id)?'Переключайте поля игроков. Все строят по одному общему броску.':`Готовы ${game.ready.length} из ${game.playerIds.length}. Можно посмотреть поля остальных.`;
    $('#rr-roster').innerHTML=game.playerIds.map(pid=>`<span class="rr-player ${pid===id?'is-me':''}">${esc(game.names[pid])}${pid===id?' · вы':''}<small>${game.ready.includes(pid)?'✓ Готов':view.players.find(p=>p.id===pid)?.connected?'Строит':'Офлайн'}</small></span>`).join('');
    $('#rr-board-tabs').innerHTML=game.playerIds.map(pid=>`<button class="rr-board-tab ${shown===pid?'is-active':''}" data-player="${esc(pid)}" aria-pressed="${shown===pid}">${pid===id?'Моё поле':esc(game.names[pid])}</button>`).join('');
    $('#rr-board').innerHTML=boardMarkup(game.boards[shown],editable,piece);
    const progress=game.scores[shown];$('#rr-progress').innerHTML=`<span>Сети выходов <b>${progress.network}</b></span><span>Центр <b>${progress.center}/9</b></span><span>Обрывы <b>−${progress.errors}</b></span>`;
    $('#rr-dice').innerHTML=game.dice.map((face,index)=>{
      const used=game.usedDice[shown].includes(index);
      return `<button class="rr-die ${used?'is-used':''} ${source===index&&own?'is-selected':''}" data-die="${index}" ${editable&&!used?'':'disabled'} aria-pressed="${source===index&&own}" aria-label="Кубик ${index+1}: ${pieces[face].label}${used?', использован':''}">${tileArt(face,source===index&&own?rotation:0,source===index&&own?flipped:false)}<span>${used?'✓':index+1}</span></button>`;
    }).join('');
    $('#rr-specials').innerHTML=specials.map(s=>{
      const used=game.specialsUsed[shown].includes(s),available=editable&&game.specialsUsed[id].length<3&&!game.specialThisRound&&!used;
      return `<button class="rr-special ${used?'is-used':''} ${source===s&&own?'is-selected':''}" data-special="${s}" ${available?'':'disabled'} title="${pieces[s].label}" aria-label="${pieces[s].label}${used?', уже использован':''}" aria-pressed="${source===s&&own}">${tileArt(s,source===s&&own?rotation:0,source===s&&own?flipped:false)}${used?'<span>✓</span>':''}</button>`;
    }).join('');
    $('#rr-special-count').textContent=`Использовано ${game.specialsUsed[shown].length} из 3 спецмаршрутов. Не больше одного за раунд.`;
    $('#rr-piece-description').textContent=editable&&piece?`${pieces[piece].label} · ${rotation*90}°${flipped?' · отражён':''}`:own?'Выберите кубик или спецмаршрут.':'Просмотр чужого поля';
    $('#rr-rotate').disabled=!editable||!piece;$('#rr-flip').disabled=!editable||!piece;
    $('#rr-undo').disabled=!own||!game.canUndo||busy;$('#rr-finish').disabled=!own||!game.canFinish||busy;
    $('#rr-finish').textContent=game.ready.includes(id)?'Раунд подтверждён ✓':view.round===7?'Завершить игру':'Завершить раунд';
  }
  function report(game,target,record='') {
    const order=[...game.playerIds].sort((a,b)=>game.scores[b].total-game.scores[a].total||game.scores[a].errors-game.scores[b].errors);
    $(target).innerHTML=`<div class="rr-wrap">${record?`<p class="rr-record">${esc(record)}</p>`:''}${order.map(id=>{
      const s=game.scores[id];return `<section class="rr-result"><h3>${esc(game.names[id])}<strong>${s.total} очков</strong></h3><div class="rr-result-points"><span>Выходы <b>+${s.network}</b></span><span>Длинная дорога <b>+${s.highway}</b></span><span>Длинные рельсы <b>+${s.railway}</b></span><span>Центр <b>+${s.center}</b></span><span>Обрывы <b>−${s.errors}</b></span></div><details><summary>Посмотреть поле</summary>${boardMarkup(game.boards[id])}</details></section>`;
    }).join('')}</div>`;
  }
  function finish(view,target) {
    const game=view.railroad;let record='';
    if(game.playerIds.length===1&&game.playerIds[0]===view.me?.id&&view.winner===view.me.id){
      const total=game.scores[view.me.id].total;
      try{const previous=localStorage.getItem('railroad_solo_best');const best=previous===null?total:Math.max(Number(previous),total);localStorage.setItem('railroad_solo_best',String(best));record=`Личный рекорд в этом браузере: ${best} очков.`;}catch(e){}
    }
    report(game,target,record);
  }
  window.RailroadUI={render,report,finish};
})();
