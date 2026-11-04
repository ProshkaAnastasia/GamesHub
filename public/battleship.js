(() => {
  const $ = s => document.querySelector(s);
  const letters = 'АБВГДЕЖЗИК';
  const fleet = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  const coordinate = n => `${letters[n % 10]}${Math.floor(n / 10) + 1}`;
  let current, emit, length = 4, vertical = false, pending = false;
  function board(owner, game, own, arrange, fire) {
    const cells = game.boards[owner];
    let html = `<section class="bs-sea"><h3>${esc(game.names[owner])}${own ? ' · ваш флот' : ''}</h3><p class="hint-text">${game.ready[owner] ? `Кораблей осталось: ${game.shipsLeft[owner]}` : 'Расстановка флота'}</p><div class="bs-grid" role="group" aria-label="${own ? 'Ваше поле' : 'Поле ' + esc(game.names[owner])}"><span></span>${[...letters].map(l => `<span class="bs-axis">${l}</span>`).join('')}`;
    for (let row = 0; row < 10; row++) {
      html += `<span class="bs-axis">${row + 1}</span>`;
      for (let col = 0; col < 10; col++) {
        const index = row * 10 + col, cell = cells[index];
        const enabled = arrange || fire && cell === 'water';
        const title = ({water:'Неизвестно', ship:'Корабль', hit:'Попадание', sunk:'Потоплен', miss:'Промах'})[cell];
        html += `<button type="button" class="bs-cell bs-${cell}" data-index="${index}" data-owner="${esc(owner)}" ${enabled && !pending ? '' : 'disabled'} aria-label="${coordinate(index)} — ${title}">${cell === 'hit' || cell === 'sunk' ? '×' : cell === 'miss' ? '·' : ''}</button>`;
      }
    }
    return html + '</div></section>';
  }
  function boards(game, id, arrange = false, fire = false) {
    const order = game.playerIds.includes(id) ? [id, ...game.playerIds.filter(p => p !== id)] : game.playerIds;
    return order.map(owner => board(owner, game, owner === id, arrange && owner === id, fire && owner !== id)).join('');
  }
  function remaining(game) {
    const left = [...fleet];
    for (const ship of game.ownFleet) left.splice(left.indexOf(ship.length), 1);
    return left;
  }
  function render(view, send) {
    current = view; emit = send;
    const game = view.battleship, id = view.me.id, setup = view.phase === 'setup';
    const left = remaining(game);
    if (!left.includes(length)) length = left[0] || 1;
    $('#btn-force-end-game-bs').hidden = !view.canForceEnd;
    $('#bs-status').textContent = setup
      ? game.canArrange ? 'Расставьте свой флот' : game.playerIds.includes(id) ? 'Вы готовы. Ждём соперника.' : 'Игроки расставляют корабли'
      : game.canFire ? 'Ваш выстрел' : `Ход: ${game.names[game.currentPlayerId]}`;
    $('#bs-last').textContent = game.lastShot ? `${game.names[game.lastShot.playerId]} · ${coordinate(game.lastShot.index)} · ${{hit:'попадание — ещё один выстрел', sunk:'корабль потоплен — ещё один выстрел', miss:'мимо — ход переходит сопернику'}[game.lastShot.result]}` : 'Флот соперника скрыт до конца партии.';
    $('#bs-setup').hidden = !game.canArrange;
    $('#bs-fleet-picker').innerHTML = [4, 3, 2, 1].map(n => {
      const count = left.filter(v => v === n).length;
      return `<button type="button" data-length="${n}" class="bs-ship-choice ${length === n ? 'selected' : ''}" aria-pressed="${length === n}" ${count && !pending ? '' : 'disabled'}><span>${'■'.repeat(n)}</span><small>${n}-палубный · ${count}</small></button>`;
    }).join('');
    $('#bs-ready').disabled = !!left.length || pending;
    $('#bs-auto').disabled = $('#bs-clear').disabled = $('#bs-rotate').disabled = pending;
    $('#bs-rotate').textContent = vertical ? '↻ Вертикально' : '↻ Горизонтально';
    $('#bs-boards').innerHTML = boards(game, id, game.canArrange, game.canFire);
  }
  async function action(event, payload = {}) {
    if (pending) return;
    pending = true; render(current, emit);
    try {
      const result = await emit(event, payload);
      $('#bs-error').hidden = !result.error;
      $('#bs-error').textContent = result.error || '';
    } finally { pending = false; render(current, emit); }
  }
  $('#bs-fleet-picker').addEventListener('click', e => {
    const button = e.target.closest('[data-length]');
    if (button && !button.disabled) { length = Number(button.dataset.length); render(current, emit); }
  });
  $('#bs-rotate').addEventListener('click', () => { vertical = !vertical; render(current, emit); });
  $('#bs-auto').addEventListener('click', () => action('battleship-auto'));
  $('#bs-clear').addEventListener('click', () => action('battleship-layout', {ships:[]}));
  $('#bs-ready').addEventListener('click', () => action('battleship-ready'));
  $('#bs-boards').addEventListener('click', e => {
    const cell = e.target.closest('.bs-cell');
    if (!cell || cell.disabled || pending) return;
    const index = Number(cell.dataset.index), game = current.battleship;
    if (game.canArrange && cell.dataset.owner === current.me.id) {
      const old = game.ownFleet.find(ship => ship.includes(index));
      if (old) return action('battleship-layout', {ships:game.ownFleet.filter(ship => ship !== old)});
      if ((!vertical && index % 10 + length > 10) || (vertical && Math.floor(index / 10) + length > 10)) {
        $('#bs-error').hidden = false; $('#bs-error').textContent = 'Корабль выходит за край поля'; return;
      }
      action('battleship-layout', {ships:[...game.ownFleet, Array.from({length}, (_, n) => index + n * (vertical ? 10 : 1))]});
    } else if (game.canFire) action('battleship-fire', {index});
  });
  $('#bs-boards').addEventListener('pointerover', e => {
    if (!current?.battleship.canArrange) return;
    $('#bs-boards').querySelectorAll('.bs-preview').forEach(c => c.classList.remove('bs-preview'));
    const cell = e.target.closest('.bs-cell');
    if (!cell || cell.dataset.owner !== current.me.id || cell.disabled) return;
    const start = Number(cell.dataset.index);
    if ((!vertical && start % 10 + length > 10) || (vertical && Math.floor(start / 10) + length > 10)) return;
    for (let n = 0; n < length; n++) $('#bs-boards').querySelector(`[data-owner="${CSS.escape(current.me.id)}"][data-index="${start + n * (vertical ? 10 : 1)}"]`)?.classList.add('bs-preview');
  });
  $('#bs-boards').addEventListener('pointerleave', () => $('#bs-boards').querySelectorAll('.bs-preview').forEach(c => c.classList.remove('bs-preview')));
  window.BattleshipUI = {render, report(game, target) {$(target).innerHTML = `<div class="bs-boards">${boards(game, null)}</div>`;}};
})();
