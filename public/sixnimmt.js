(() => {
  const $ = s => document.querySelector(s);
  const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const heads = n => n === 55 ? 7 : n % 11 === 0 ? 5 : n % 10 === 0 ? 3 : n % 5 === 0 ? 2 : 1;
  const sum = row => row.reduce((n, card) => n + heads(card), 0);
  let current, send, selected = null, key = null, busy = false;
  function card(n, interactive = false, picked = false) {
    const tag = interactive ? 'button' : 'span';
    return `<${tag} class="six-card six-value-${heads(n)} ${picked ? 'is-picked' : ''}" ${interactive ? `type="button" data-card="${n}" aria-pressed="${picked}"` : ''} aria-label="${n}, штраф ${heads(n)}"><small>${String(n).padStart(3,'0')}</small><strong>${n}</strong><span class="six-heads">♉︎ ${heads(n)}</span></${tag}>`;
  }
  function scoreMarkup(game, view) {
    return [...game.playerIds].sort((a,b) => game.scores[a] - game.scores[b]).map(id => {
      const status = view?.phase === 'choosing' ? (game.submitted.includes(id) ? '✓ Карта выбрана' : 'Выбирает карту') : view?.phase === 'review' ? (game.ready.includes(id) ? '✓ Готов' : 'Смотрит результат') : '';
      return `<div class="six-score ${id === view?.me?.id ? 'is-me' : ''}"><strong>${esc(game.names[id])}${id === view?.me?.id ? ' · вы' : ''}</strong><b>${game.scores[id]} <small>♉︎</small></b><span>${status}</span></div>`;
    }).join('');
  }
  function moveMarkup(game, moves) {
    return moves.map(m => `<p><strong>${esc(game.names[m.playerId])}</strong> · карта ${m.card} → ряд ${m.row + 1}${m.penalty ? ` <span class="six-penalty">+${m.penalty} ♉︎</span> <small>(забраны ${m.taken.join(', ')})</small>` : ''}</p>`).join('');
  }
  async function action(event, payload = {}) {
    if (busy) return;
    busy = true;
    try {
      const r = await send(event, payload);
      $('#six-error').hidden = !r.error;
      $('#six-error').textContent = r.error || '';
    } finally { busy = false; }
  }
  $('#six-hand').addEventListener('click', e => {
    const button = e.target.closest('[data-card]');
    if (!button || !current.sixnimmt.canSelect || busy) return;
    selected = Number(button.dataset.card);
    render(current, send);
  });
  $('#six-submit').addEventListener('click', () => { if (selected != null) action('sixnimmt-select', { card: selected }); });
  $('#six-rows').addEventListener('click', e => {
    const button = e.target.closest('[data-row]');
    if (button && current.sixnimmt.canChooseRow) action('sixnimmt-row', { row: Number(button.dataset.row) });
  });
  $('#six-next').addEventListener('click', () => action('sixnimmt-next'));
  function render(view, emit) {
    current = view; send = emit;
    const game = view.sixnimmt, nextKey = `${view.code}:${view.pastGames.length}:${view.round}`;
    if (key !== nextKey) { key = nextKey; selected = null; $('#six-error').hidden = true; }
    $('#btn-force-end-game-six').hidden = !view.canForceEnd;
    $('#six-scores').innerHTML = scoreMarkup(game, view);
    $('#six-round').textContent = `Раздача ${game.handNumber} · ход ${game.turn} из 10 · игра до 66 ♉︎`;
    const spectator = !game.playerIds.includes(view.me?.id);
    let instruction, detail;
    if (view.phase === 'choosing') {
      instruction = spectator ? 'Игроки выбирают карты' : game.canSelect ? 'Какую карту сыграете?' : 'Карта подтверждена';
      detail = `${game.submitted.length} из ${game.playerIds.length} готовы. ${game.canSelect ? 'Выберите карту и подтвердите. Остальные увидят её, только когда готовы все.' : 'Ждём остальных игроков.'}`;
    } else if (view.phase === 'choosing-row') {
      instruction = game.canChooseRow ? 'Ваша карта меньше всех крайних — выберите ряд' : `${game.names[game.pendingPlayerId]} выбирает ряд`;
      detail = game.canChooseRow ? 'Заберёте все карты этого ряда и получите указанный штраф.' : 'После выбора продолжим раскладывать карты по возрастанию.';
    } else {
      instruction = game.hand.length || spectator && game.handCounts[game.playerIds[0]] ? 'Карты разыграны' : 'Раздача завершена';
      detail = spectator ? 'Ждём готовности игроков.' : game.canContinue ? 'Посмотрите результат и нажмите «Дальше».' : `Готовы ${game.ready.length} из ${game.playerIds.length}. Ждём остальных.`;
    }
    $('#six-instruction').textContent = instruction;
    $('#six-detail').textContent = spectator ? 'Вы наблюдаете. ' + detail : detail;
    $('#six-revealed').hidden = view.phase === 'choosing';
    $('#six-revealed').innerHTML = game.revealed.map(m => `<div class="six-played ${m.playerId === game.pendingPlayerId ? 'is-pending' : ''}">${card(m.card)}<span>${esc(game.names[m.playerId])}</span></div>`).join('');
    $('#six-rows').innerHTML = game.rows.map((row, i) => `<div class="six-row ${game.canChooseRow ? 'is-choosable' : ''}"><span class="six-row-number">${i+1}</span><div class="six-row-cards">${row.map(n => card(n)).join('')}${Array.from({length:5-row.length},()=>'<span class="six-empty-slot" aria-hidden="true"></span>').join('')}</div><div class="six-row-end"><strong>${sum(row)} ♉︎</strong>${game.canChooseRow ? `<button class="btn btn-secondary" data-row="${i}" aria-label="Забрать ряд ${i+1}, штраф ${sum(row)}">Забрать</button>` : '<small>штраф</small>'}</div></div>`).join('');
    $('#six-hand-section').hidden = spectator || view.phase !== 'choosing';
    $('#six-hand').innerHTML = game.hand.map(n => card(n, game.canSelect, n === (game.selectedCard ?? selected))).join('');
    $('#six-submit').disabled = !game.canSelect || selected == null;
    $('#six-submit').textContent = game.selectedCard != null ? `Карта ${game.selectedCard} подтверждена ✓` : selected != null ? `Сыграть ${selected}` : 'Подтвердить карту';
    $('#six-next').hidden = view.phase !== 'review' || spectator;
    $('#six-next').disabled = !game.canContinue;
    $('#six-next').textContent = game.canContinue ? game.hand.length ? 'Дальше →' : 'Следующая раздача →' : 'Ждём остальных…';
    $('#six-moves').innerHTML = game.moves.length ? `<h3>Этот ход</h3>${moveMarkup(game, game.moves)}` : '';
  }
  function report(game, target) {
    $(target).innerHTML = `<div class="six-scores">${scoreMarkup(game)}</div><details class="six-history"><summary>История · ${game.history.length} ходов</summary>${[...game.history].reverse().map(h => `<h4>Раздача ${h.handNumber} · ход ${h.turn}</h4>${moveMarkup(game,h.moves)}`).join('')}</details>`;
  }
  window.SixNimmtUI = { render, report };
})();
