(() => {
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const teamLabel = team => team === 'A' ? 'А' : 'Б';
  const kindLabel = kind => ({ A: 'Агент А', B: 'Агент Б', neutral: 'Мирный житель', assassin: 'Убийца' })[kind] || 'Неизвестно';
  const kindClass = kind => ['A', 'B', 'neutral', 'assassin'].includes(kind) ? kind : 'unknown';
  let current = null, send = null, turnKey = null;
  function boardMarkup(board, interactive, captainTeam = null) {
    return board.map((card, index) => `<button type="button" class="cn-card cn-${kindClass(card.kind)} ${card.revealed ? 'cn-revealed' : ''} ${captainTeam && card.kind === captainTeam && !card.revealed ? 'cn-own-agent' : ''}" data-index="${index}" ${interactive && !card.revealed ? '' : 'disabled'} aria-label="${escape(card.word)} — ${kindLabel(card.kind)}${card.revealed ? ', открыто' : ''}${captainTeam && card.kind === captainTeam ? ', ваша команда' : ''}"><span>${escape(card.word)}</span></button>`).join('');
  }
  const cardImages = {
  "A": "Синяя команда_ агент в кобальтовой палитре, в едином стиле с красной карточкой..png",
  "B": "Красная команда_ ретрошпионская иллюстрация агента, единый формат для печати, без надписей..png",
  "neutral": "Мирный житель_ тёплая бежевая иллюстрация горожанина, в общем стиле шпионского набора..png",
  "assassin": "Чёрная карточка_ таинственный убийца в нуарной палитре, без надписей и оружия..png"
};
  const mountedBoards = new WeakMap();
  let previousBoardKey = null, previousRevealed = new Set();
  function newReveals(key, board) {
    const revealed = new Set(board.flatMap((card, index) => card.revealed ? [index] : []));
    const added = key === previousBoardKey ? new Set([...revealed].filter(index => !previousRevealed.has(index))) : new Set();
    previousBoardKey = key;
    previousRevealed = revealed;
    return added;
  }
  function addCover(button, card, animate) {
    if (!card.revealed || !cardImages[card.kind] || button.querySelector('.cn-card-cover')) return;
    const image = document.createElement('img');
    image.className = 'cn-card-cover';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.draggable = false;
    const show = () => {
      if (!image.isConnected) return;
      button.classList.add('cn-art-loaded');
      if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        button.classList.add('cn-animating');
        image.classList.add('cn-cover-enter');
        image.addEventListener('animationend', () => {
          button.classList.remove('cn-animating');
          image.classList.remove('cn-cover-enter');
        }, { once: true });
      }
    };
    image.addEventListener('load', show, { once: true });
    // A missing asset leaves the colored card and readable word as fallback.
    image.addEventListener('error', () => image.remove(), { once: true });
    button.appendChild(image);
    image.src = `/codenames/cards/${encodeURIComponent(cardImages[card.kind])}`;
  }
  function renderBoard(element, board, interactive, captainTeam, key, entering = new Set()) {
    const signature = board.map(card => card.word).join('\0');
    const mounted = mountedBoards.get(element);
    if (!mounted || mounted.key !== key || mounted.signature !== signature) {
      element.innerHTML = boardMarkup(board, interactive, captainTeam);
      mountedBoards.set(element, { key, signature });
    }
    board.forEach((card, index) => {
      const button = element.children[index];
      const own = captainTeam && card.kind === captainTeam && !card.revealed;
      const loaded = button.classList.contains('cn-art-loaded');
      const animating = button.classList.contains('cn-animating');
      button.className = `cn-card cn-${kindClass(card.kind)} ${card.revealed ? 'cn-revealed' : ''} ${own ? 'cn-own-agent' : ''} ${loaded ? 'cn-art-loaded' : ''} ${animating ? 'cn-animating' : ''}`;
      button.disabled = !interactive || card.revealed;
      button.setAttribute('aria-label', `${card.word} — ${kindLabel(card.kind)}${card.revealed ? ', открыто' : ''}${own ? ', ваша команда' : ''}`);
      addCover(button, card, entering.has(index));
    });
  }
  function historyMarkup(turns) {
    return `<h3>История ходов</h3>${[...turns].reverse().map(turn => `<div class="cn-turn team-${turn.team.toLowerCase()}"><strong>Команда ${teamLabel(turn.team)} · ${escape(turn.clue.word)} — ${turn.clue.count === 'unlimited' ? '∞' : turn.clue.count}</strong><p>${turn.picks.map(pick => `<span class="cn-pick-${kindClass(pick.kind)}">${escape(pick.word)}</span>`).join(' · ') || 'Карточки ещё не открыты'}</p></div>`).join('')}`;
  }
  async function action(event, payload = {}) {
    const result = await send(event, payload);
    $('#cn-error').textContent = result.error || '';
    $('#cn-error').hidden = !result.error;
  }
  $('#cn-board').addEventListener('click', event => {
    const card = event.target.closest('button[data-index]');
    if (!card || card.disabled || !current?.codenames.canGuess) return;
    const index = Number(card.dataset.index);
    if (confirm(`Открыть «${current.codenames.board[index].word}»?`)) action('codenames-reveal', { index });
  });
  $('#cn-clue-form').addEventListener('submit', event => {
    event.preventDefault();
    const count = $('#cn-clue-count').value;
    action('codenames-clue', { word: $('#cn-clue-word').value.trim(), count: count === 'unlimited' ? count : Number(count) });
  });
  $('#cn-end-turn').addEventListener('click', () => action('codenames-end-turn'));
  window.CodenamesUI = {
    render(view, emit) {
      current = view; send = emit;
      const game = view.codenames;
      const key = `${view.code}:${view.pastGames.length}:${view.round}`;
      if (key !== turnKey) {
        $('#cn-clue-word').value = '';
        $('#cn-error').hidden = true;
        turnKey = key;
      }
      $('#btn-force-end-game-cn').hidden = !view.canForceEnd;
      $('#cn-roster').innerHTML = view.players.map(player => `<span class="roster-chip team-${(player.team || '').toLowerCase()} ${player.connected ? '' : 'offline'}">${escape(player.name)}${Object.values(game.captains).includes(player.id) ? ' · капитан' : player.role === 'spectator' ? ' · зритель' : ' · агент'}${player.connected ? '' : ' · офлайн'}</span>`).join('');
      $('#cn-status').innerHTML = `<div class="cn-scores"><span class="cn-count-A">А: осталось ${game.remaining.A}</span><span class="cn-count-B">Б: осталось ${game.remaining.B}</span></div><strong>Ход команды ${teamLabel(game.activeTeam)}</strong><p>${game.clue ? `Подсказка: ${escape(game.clue.word)} — ${game.clue.count === 'unlimited' ? '∞' : game.clue.count}. Попыток осталось: ${game.clue.count === 0 || game.clue.count === 'unlimited' ? 'без ограничения' : game.guessesLeft}` : 'Капитан придумывает подсказку'}</p>`;
      $('#cn-role').textContent = game.isCaptain ? `Вы капитан команды ${teamLabel(view.me.team)}` : view.me.role === 'spectator' ? 'Вы наблюдаете за игрой.' : `Вы агент команды ${teamLabel(view.me.team)}. Обсудите подсказку и выберите карточку.`;
      const boardKey = `${view.code}:${view.pastGames.length}`;
      renderBoard($('#cn-board'), game.board, game.canGuess, game.isCaptain ? view.me.team : null, boardKey, newReveals(boardKey, game.board));
      $('#cn-clue-form').hidden = !game.canGiveClue;
      $('#cn-end-turn').hidden = !game.canGuess;
      $('#cn-end-turn').disabled = !game.canEndTurn;
      $('#cn-history').innerHTML = historyMarkup(game.turns);
    },
    report(game, target, boardKey = null) {
      const container = $(target);
      if (!container.querySelector('.cn-board')) container.innerHTML = '<div class="cn-board"></div><div class="cn-report-history"></div>';
      renderBoard(container.querySelector('.cn-board'), game.board, false, null, boardKey || 'archive', boardKey ? newReveals(boardKey, game.board) : new Set());
      container.querySelector('.cn-report-history').innerHTML = historyMarkup(game.turns);
    },
  };
})();
