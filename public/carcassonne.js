(() => {
  const $=s=>document.querySelector(s),{tiles,rotatePoint}=window.CarcassonneTiles;
  const colors=['#ed776b','#6ca9ed','#dfbd61','#91bf7b','#b391d2'];
  const labels={city:'Город',road:'Дорога',field:'Поле',monastery:'Монастырь'};
  const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  let current=null,send=null,rotation=0,turnKey=null,size=88;
  function meeple(color,x,y,farmer=false){return `<g transform="translate(${x} ${y}) ${farmer?'rotate(80)':''}" fill="${color}" stroke="#263126" stroke-width="1.2"><circle cy="-7" r="4"/><path d="M-4-3L-10 1-8 5-4 3-6 13H-1L0 7 1 13H6L4 3 8 5 10 1 4-3Z"/></g>`;}
  function art(tile, players = []) {
    const spec = tiles[tile.id];
    let svg = `<img class="cc-tile-art" src="/carkasson/cards/${tile.id}.png" width="1024" height="1024" alt="" draggable="false" style="transform:rotate(${tile.rotation * 90}deg)"><svg class="cc-figures" viewBox="0 0 100 100" aria-hidden="true">`;
    // Rotate the landscape and its feature anchors together; keep figures upright.
    if (tile.meeple) {
      const feature = spec.features.find(f => f.id === tile.meeple.feature);
      const [x, y] = rotatePoint(feature.anchor, tile.rotation);
      svg += meeple(colors[players.indexOf(tile.meeple.playerId)], x, y, feature.type === 'field');
    }
    return svg + '</svg>';
  }
  function bounds(board,placements=[]){const all=[...board,...placements];return {minX:Math.min(...all.map(t=>t.x)),maxX:Math.max(...all.map(t=>t.x)),minY:Math.min(...all.map(t=>t.y)),maxY:Math.max(...all.map(t=>t.y))};}
  function boardMarkup(game,interactive=false){const positions=interactive&&game.phase!=='meeple'?(game.placements||[]):[];const b=bounds(game.board,positions);const w=b.maxX-b.minX+1,h=b.maxY-b.minY+1;let html=`<div class="cc-grid" style="width:${w*size}px;height:${h*size}px">`;
    for(const t of game.board){const last=game.lastPlaced?.x===t.x&&game.lastPlaced?.y===t.y;html+=`<div class="cc-tile ${last?'cc-last':''}" style="left:${(t.x-b.minX)*size}px;top:${(t.y-b.minY)*size}px;width:${size}px;height:${size}px">${art(t,game.playerIds)}`;
      if(interactive&&game.phase==='meeple'&&last)for(const id of game.choices||[]){const f=tiles[t.id].features.find(f=>f.id===id),[x,y]=rotatePoint(f.anchor,t.rotation);html+=`<button class="cc-claim" data-feature="${id}" style="left:${x}%;top:${y}%" title="${labels[f.type]}" aria-label="Поставить мипла: ${labels[f.type]}">+</button>`;}html+='</div>';}
    for(const p of positions)if(p.rotations.includes(rotation))html+=`<button class="cc-slot" data-x="${p.x}" data-y="${p.y}" style="left:${(p.x-b.minX)*size}px;top:${(p.y-b.minY)*size}px;width:${size}px;height:${size}px" aria-label="Положить плитку ${p.x}, ${p.y}">+</button>`;
    return html+'</div>';}
  function scoreMarkup(game){return game.playerIds.map((id,i)=>`<div class="cc-score ${id===game.currentPlayerId?'cc-current':''}" style="--cc-player:${colors[i]}"><span class="cc-player-dot"></span><strong>${esc(game.names[id])}</strong><span>${game.scores[id]} очк.</span><small>Миплы: ${game.meeples[id]} / 7</small></div>`).join('');}
  function logs(game){return '<h3>Начисление очков</h3>'+[...game.log].reverse().map(e=>`<p>${esc(e.label)} · +${e.points} · ${e.players.map(id=>esc(game.names[id])).join(', ')}</p>`).join('');}
  async function action(event,payload){const r=await send(event,payload);$('#cc-error').hidden=!r.error;$('#cc-error').textContent=r.error||'';}
  $('#cc-rotate').addEventListener('click',()=>{rotation=(rotation+1)%4;render(current,send);});
  $('#cc-skip').addEventListener('click',()=>action('carcassonne-meeple',{feature:null}));
  $('#cc-board').addEventListener('click',e=>{const feature=e.target.closest('[data-feature]');if(feature)return action('carcassonne-meeple',{feature:feature.dataset.feature});const slot=e.target.closest('[data-x]');if(slot)action('carcassonne-tile',{x:Number(slot.dataset.x),y:Number(slot.dataset.y),rotation});});
  $('#cc-zoom').addEventListener('input',e=>{size=Number(e.target.value);if(current)render(current,send);});
  function render(view,emit){current=view;send=emit;const game={...view.carcassonne,phase:view.phase};const k=view.code+':'+view.pastGames.length+':'+view.round;if(k!==turnKey){turnKey=k;rotation=0;$('#cc-error').hidden=true;}
    $('#cc-scores').innerHTML=scoreMarkup(game);$('#btn-force-end-game-cc').hidden=!view.canForceEnd;
    $('#cc-status').textContent=`${game.names[game.currentPlayerId]} · ${game.canAct?'ваш ход':'ходит'} · плиток в запасе: ${game.tilesLeft}`;
    $('#cc-instruction').textContent=view.phase==='meeple'?(game.canAct?'Выберите объект на новой плитке или завершите ход без мипла.':'Игрок выбирает, куда поставить мипла.'):(game.canAct?'Поверните плитку и нажмите на подходящее место на поле.':'Ожидаем размещение плитки.');
    $('#cc-rotate').hidden=!game.canAct||view.phase!=='tile';$('#cc-skip').hidden=!game.canAct||view.phase!=='meeple';
    $('#cc-preview').innerHTML=game.currentTile?art({id:game.currentTile,rotation,meeple:null}):'';
    const wrap=$('#cc-board-wrap'),wasEmpty=!$('#cc-board').children.length;
    $('#cc-board').innerHTML=boardMarkup(game,game.canAct);$('#cc-log').innerHTML=logs(game);
    if(wasEmpty){wrap.scrollLeft=(wrap.scrollWidth-wrap.clientWidth)/2;wrap.scrollTop=(wrap.scrollHeight-wrap.clientHeight)/2;}
  }
  window.CarcassonneUI={render,report(game,target){$(target).innerHTML=`<div class="cc-scores">${scoreMarkup(game)}</div><div class="cc-board-wrap">${boardMarkup(game)}</div><div class="cc-log">${logs(game)}</div>`;}};
})();
