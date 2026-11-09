(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const terrains = {forest:'Лес',desert:'Пустыня',water:'Вода',mountain:'Горы',swamp:'Болото'};
  const fills = {forest:'#386f59',desert:'#b68a4b',water:'#397b9b',mountain:'#777e91',swamp:'#69723e'};
  const colors = ['#f0ab72','#7fd1e2','#c0a0ee','#e7cc70','#ec93ae'];
  const colorNames = {white:['белый','белая'],green:['зелёный','зелёная'],blue:['синий','синяя']};
  const animalNames = {bear:'Медведь',cougar:'Пума'};
  let current,send,selected=null,target='',gameKey=null,turnKey=null,noteKey=null,busy=false,zoom=1;
  let mapSerial=0;
  const artwork = name => `/cryptid/${name}.png`;
  const label = cell => `${String.fromCharCode(65+cell.col)}${cell.row+1}`;
  const cellInfo = cell => [label(cell),terrains[cell.terrain],cell.animal?`территория: ${animalNames[cell.animal]}`:'',cell.structure?`${colorNames[cell.structure.color][cell.structure.type==='stone'?0:1]} ${cell.structure.type==='stone'?'камень':'хижина'}`:''].filter(Boolean).join(' · ');
  function mapMarkup(game,interactive=false) {
    const radius=32, dx=Math.sqrt(3)*radius, height=2*radius+8*1.5*radius+16, width=12.5*dx+16;
    const prefix=`cryptid-art-${++mapSerial}`;
    // Keep the original grayscale wood texture and alpha when tinting tokens.
    const filters=colors.map((color,index)=>{
      const rgb=[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16)/255*1.4);
      return `<filter id="${prefix}-player-${index}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${rgb[0]} 0 0 0 0 0 ${rgb[1]} 0 0 0 0 0 ${rgb[2]} 0 0 0 0 0 1 0"/></filter>`;
    }).join('');
    return `<svg class="cryptid-board" viewBox="0 0 ${width} ${height}" style="width:${width*zoom}px" role="group" aria-label="Карта: 12 столбцов, 9 строк"><defs>${filters}</defs>${game.cells.map(cell=>{
      const x=8+dx/2+dx*(cell.col+(cell.row%2)/2),y=8+radius+cell.row*1.5*radius;
      const points=Array.from({length:6},(_,i)=>{const a=(i*60-30)*Math.PI/180;return `${x+radius*Math.cos(a)},${y+radius*Math.sin(a)}`;}).join(' ');
      const marks=game.markers[cell.id]||[],excluded=marks.some(m=>m.kind==='cube');
      const description=`${cellInfo(cell)}${marks.length?'. '+marks.map(m=>`${game.names[m.playerId]}: ${m.kind==='cube'?'невозможно':'возможно'}`).join('; '):''}`;
      let svg=`<g class="cryptid-cell ${excluded?'is-excluded':''} ${selected===cell.id&&interactive?'is-selected':''} ${game.solution===cell.id?'is-solution':''}" ${interactive?`data-cell="${cell.id}" tabindex="0" role="button" aria-pressed="${selected===cell.id}"`:''} aria-label="${esc(description)}"><title>${esc(description)}</title><defs><clipPath id="${prefix}-cell-${cell.id}"><polygon points="${points}"/></clipPath></defs><polygon class="cryptid-terrain-fill" points="${points}" fill="${fills[cell.terrain]}"/><image class="cryptid-terrain-image" href="${artwork(`tile-${cell.terrain}`)}" x="${x-radius}" y="${y-radius}" width="${radius*2}" height="${radius*2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${prefix}-cell-${cell.id})"/><polygon class="cryptid-cell-outline" points="${points}" fill="none" stroke="#172c2b" stroke-width="1.6"/>`;
      if(cell.animal)svg+=`<polygon points="${points}" fill="none" stroke="${cell.animal==='bear'?'#ffb178':'#f5e6bd'}" stroke-width="2.8" stroke-dasharray="${cell.animal==='bear'?'3 2':'7 2'}"/><image class="cryptid-animal-image" href="${artwork(`territory-${cell.animal}`)}" x="${x-23}" y="${y-27}" width="24" height="24"/>`;
      if(cell.structure)svg+=`<image class="cryptid-structure-image" href="${artwork(`${cell.structure.type}-${cell.structure.color}`)}" x="${x+1}" y="${y-27}" width="24" height="24"/>`;
      svg+=`<rect x="${x-14}" y="${y-6}" width="28" height="14" rx="4" fill="#102524cf"/><text x="${x}" y="${y+5}" class="cryptid-cell-label">${label(cell)}</text>`;
      marks.forEach((m,i)=>{
        const split=marks.length>3,row=split?Math.floor(i/3):0,inRow=split?Math.min(3,marks.length-row*3):marks.length;
        const mx=x+((split?i%3:i)-(inRow-1)/2)*12,my=y+(split?(row?25:13):19),index=game.playerIds.indexOf(m.playerId);
        svg+=`<image class="cryptid-token-image" href="${artwork(`marker-${m.kind==='cube'?'cube':'disc'}`)}" x="${mx-7}" y="${my-7}" width="14" height="14" filter="url(#${prefix}-player-${index})"/><text class="cryptid-marker-number" x="${mx}" y="${my+2.5}">${index+1}</text>`;
      });
      return svg+'</g>';
    }).join('')}</svg>`;
  }
  function logMarkup(game) {
    return [...game.log].reverse().slice(0,100).map(entry=>{
      const who=esc(game.names[entry.playerId]),where=entry.cell!=null?label(game.cells[entry.cell]):'';
      if(entry.kind==='question')return `<p><strong>${who}</strong> спросил ${esc(game.names[entry.target])} о ${where}: <b>${entry.yes?'возможно ●':'невозможно ■'}</b></p>`;
      if(entry.kind==='search')return `<p><strong>${who}</strong> искал в ${where}: ${entry.yes?'существо найдено!':`отказ — ${esc(game.names[entry.answers.find(a=>!a.yes)?.playerId])}`}</p>`;
      if(entry.kind==='no-cube-space')return `<p>${who}: для обязательного кубика не осталось свободных мест.</p>`;
      return `<p><strong>${who}</strong> · ${entry.kind==='disc'?'диск ●':'кубик ■'} на ${where}</p>`;
    }).join('')||'<p>Журнал пока пуст.</p>';
  }
  function selectCell(id) { selected=id;render(current,send); }
  $('#cryptid-map').addEventListener('click',e=>{const cell=e.target.closest('[data-cell]');if(cell)selectCell(Number(cell.dataset.cell));});
  $('#cryptid-map').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){const cell=e.target.closest('[data-cell]');if(cell){e.preventDefault();selectCell(Number(cell.dataset.cell));$('#cryptid-map').querySelector(`[data-cell="${selected}"]`)?.focus();}}});
  $('#cryptid-target').addEventListener('change',e=>{target=e.target.value;render(current,send);});
  $('#cryptid-zoom').addEventListener('input',e=>{zoom=Number(e.target.value)/100;if(current)render(current,send);});
  $('#cryptid-notes').addEventListener('input',e=>{try{localStorage.setItem(noteKey,e.target.value);}catch(e){}});
  async function action(event,payload) {
    if(busy||selected==null)return;
    busy=true;render(current,send);
    try{const result=await send(event,payload);$('#cryptid-error').hidden=!result.error;$('#cryptid-error').textContent=result.error||'';}
    finally{busy=false;render(current,send);}
  }
  $('#cryptid-mark').addEventListener('click',()=>action('cryptid-mark',{cell:selected}));
  $('#cryptid-question').addEventListener('click',()=>action('cryptid-question',{cell:selected,target}));
  $('#cryptid-search').addEventListener('click',()=>{if(selected!=null&&confirm(`Объявить поиск в ${label(current.cryptid.cells[selected])}? Это ваш ход.`))action('cryptid-search',{cell:selected});});
  function render(view,emit) {
    current=view;send=emit;const game=view.cryptid;
    const nextGameKey=`${view.code}:${view.pastGames.length}:${view.me?.id}`;
    if(gameKey!==nextGameKey){gameKey=nextGameKey;selected=null;target='';$('#cryptid-secret').open=false;noteKey=`cryptid_notes:${nextGameKey}`;try{$('#cryptid-notes').value=localStorage.getItem(noteKey)||'';}catch(e){$('#cryptid-notes').value='';}}
    const nextTurnKey=`${gameKey}:${view.round}:${view.phase}:${game.currentPlayerId}`;
    if(turnKey!==nextTurnKey){turnKey=nextTurnKey;$('#cryptid-error').hidden=true;}
    $('#btn-force-end-game-cryptid').hidden=!view.canForceEnd;
    $('#cryptid-roster').innerHTML=game.playerIds.map((id,i)=>`<span class="cryptid-player ${id===game.currentPlayerId?'is-active':''}" style="--player-color:${colors[i]}"><b>${i+1}</b>${esc(game.names[id])}${id===view.me?.id?' · вы':''}${view.players.find(p=>p.id===id)?.connected?'':' · офлайн'}</span>`).join('');
    $('#cryptid-status').textContent=game.canAct?'Ваш ход':`Ход: ${game.names[game.currentPlayerId]}`;
    const instructions={setup:`Начальный обмен: кубик ${Math.floor(game.setupCount/game.playerIds.length)+1} из 2. Выберите клетку, где существа не может быть по вашей подсказке.`,turn:'Выберите клетку и задайте вопрос другому игроку или объявите поиск.',compensation:'Ответ был отрицательным. Поставьте свой кубик на другую клетку, запрещённую вашей подсказкой.', 'search-disc':'В месте поиска ваш диск уже стоит. Сначала поставьте диск в другой клетке, подходящей под вашу подсказку.'};
    $('#cryptid-instruction').textContent=(game.myClue?'':'Вы наблюдаете за экспедицией. ')+(instructions[view.phase]||'');
    $('#cryptid-secret').hidden=!game.myClue;$('#cryptid-clue').textContent=game.myClue?.text||'';
    $('#cryptid-notes-label').hidden=!game.myClue;
    $('#cryptid-legend').innerHTML=Object.entries(terrains).map(([key,name])=>`<span><img class="cryptid-terrain-swatch" src="${artwork(`tile-${key}`)}" alt="">${name}</span>`).join('')+`<span><img src="${artwork('territory-bear')}" alt="">Медведь</span><span><img src="${artwork('territory-cougar')}" alt="">Пума</span><span><img src="${artwork('stone-white')}" alt="">Камень</span><span><img src="${artwork('shack-white')}" alt="">Хижина</span><span>● возможно · ■ невозможно</span>`;
    const wrap=$('#cryptid-map'),left=wrap.scrollLeft,top=wrap.scrollTop;wrap.innerHTML=mapMarkup(game,true);wrap.scrollLeft=left;wrap.scrollTop=top;
    const cell=selected!=null?game.cells[selected]:null,marks=cell?game.markers[cell.id]:[],excluded=marks.some(m=>m.kind==='cube');
    $('#cryptid-selection').innerHTML=cell?`<div class="cryptid-selection-heading"><img src="${artwork('expedition-pawn')}" alt="" width="30" height="30"><strong>${esc(cellInfo(cell))}</strong></div><p>${marks.length?marks.map(m=>`<span style="color:${colors[game.playerIds.indexOf(m.playerId)]}">${esc(game.names[m.playerId])}: ${m.kind==='cube'?'■ невозможно':'● возможно'}</span>`).join(' · '):'Маркеров пока нет'}</p>`:'<strong>Выберите клетку на карте</strong>';
    const others=game.playerIds.filter(id=>id!==view.me?.id);if(!others.includes(target))target=others[0]||'';
    $('#cryptid-target').innerHTML=others.map(id=>`<option value="${esc(id)}" ${id===target?'selected':''}>${esc(game.names[id])}</option>`).join('');
    $('#cryptid-target-label').hidden=!game.canInvestigate;
    $('#cryptid-question').hidden=!game.canInvestigate;$('#cryptid-search').hidden=!game.canInvestigate;$('#cryptid-mark').hidden=!game.canMark;
    $('#cryptid-question').disabled=busy||!cell||excluded||marks.some(m=>m.playerId===target);
    $('#cryptid-search').disabled=busy||!cell||excluded;
    $('#cryptid-mark').disabled=busy||!cell||excluded||marks.some(m=>m.playerId===view.me?.id);
    $('#cryptid-mark').textContent=view.phase==='search-disc'?'Поставить диск ●':'Поставить кубик ■';
    $('#cryptid-catalog').innerHTML='<h3>Возможные личные подсказки</h3><ul>'+game.clueCatalog.map(c=>`<li>${esc(c.text)}</li>`).join('')+'</ul>';
    $('#cryptid-log').innerHTML=logMarkup(game);
  }
  function report(game,target) {
    $(target).innerHTML=`<div class="cryptid-wrap"><div class="cryptid-result-heading">${game.solution!=null?`<img src="${artwork('creature-found')}" alt="Найденное лесное существо" width="110" height="110">`:''}<h3>${game.solution!=null?`Место обитания: ${label(game.cells[game.solution])}`:'Экспедиция завершена'}</h3></div>${game.clues?game.playerIds.map((id,i)=>`<p style="border-left:3px solid ${colors[i]};padding-left:12px"><strong>${esc(game.names[id])}</strong> · ${esc(game.clues[id].text)}</p>`).join(''):''}<div class="cryptid-map">${mapMarkup(game)}</div><details class="cryptid-help"><summary>Журнал экспедиции</summary>${logMarkup(game)}</details></div>`;
  }
  window.CryptidUI={render,report};
})();
