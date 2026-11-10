(() => {
  const socket = io({ autoConnect: false });

  let lobbyCountdown = null;
  const state = {
    myId: null,
    lastView: null,
    historyOpen: false,
    chatOpen: false,
    gamesOpen: false,
    ttrLastCurrentPlayerId: null,
    ccLastTurnKey: null,
    teamLastTurnKey: null,
    sixLastActionKey: null,
    cryptidLastActionKey: null,
    railroadLastRoundKey: null,
  };

  // ---------- утилиты ----------
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  function showScreen(name) {
    if (name !== 'lobby') { clearInterval(lobbyCountdown); lobbyCountdown = null; }
    $all('.screen').forEach(s => s.classList.remove('active'));
    $(`#screen-${name}`).classList.add('active');
  }
  $('#btn-reload-game').addEventListener('click', () => location.reload());

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      if (!socket.connected) return resolve({ error: 'Нет соединения с сервером' });
      socket.timeout(10000).emit(event, payload, (error, res) => resolve(error ? { error: 'Сервер не ответил. Повторите действие.' } : (res || {})));
    });
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = !message;
  }

  // ---------- звук уведомления о своём ходе ----------
  function getTtrSoundEnabled() {
    try { return localStorage.getItem('ttr_sound_enabled') !== '0'; } catch (e) { return true; }
  }
  function setTtrSoundEnabled(enabled) {
    try { localStorage.setItem('ttr_sound_enabled', enabled ? '1' : '0'); } catch (e) {}
  }
  let ttrAudioCtx = null;
  function getTurnAudioContext() {
    if (!ttrAudioCtx || ttrAudioCtx.state === 'closed') {
      ttrAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ttrAudioCtx;
  }
  function unlockTurnAudio() {
    try {
      const ctx = getTurnAudioContext();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch (e) { /* Звук может быть недоступен в браузере. */ }
  }
  // Создаём и разблокируем аудио во время действия пользователя,
  // до того как уведомление о ходе придёт по сокету.
  document.addEventListener('click', unlockTurnAudio, { capture: true });
  document.addEventListener('keydown', unlockTurnAudio, { capture: true });
  function playTtrTurnSound() {
    if (!getTtrSoundEnabled()) return;
    playTurnSound();
  }
  function getCcSoundEnabled() {
    try { return localStorage.getItem('cc_sound_enabled') !== '0'; } catch (e) { return true; }
  }
  function getTeamSoundEnabled(gameType) {
    try { return localStorage.getItem(`${gameType}_sound_enabled`) !== '0'; } catch (e) { return true; }
  }
  function updateTeamTurnSound(view) {
    let active = false;
    let phaseKey = view.phase;
    if (view.status === 'playing' && view.me && view.me.role !== 'spectator') {
      if (view.gameType === 'decoder' && view.teamView) {
        const tv = view.teamView;
        active = (view.phase === 'clue-giving' && !tv.mySubmittedClues && view.loneTeam !== tv.myTeamKey)
          || view.phase === 'guessing'
          || (view.phase === 'tiebreak' && !tv.isSharedPlayer);
      } else if (view.gameType === 'codenames' && view.codenames) {
        const game = view.codenames;
        const side = game.mode === 'duet' ? game.ownSide : view.me.team;
        const actingTeam = game.mode === 'duet' && view.phase === 'guessing'
          ? (game.activeTeam === 'A' ? 'B' : 'A') : game.activeTeam;
        active = ['clue', 'guessing'].includes(view.phase) && !!side && side === actingTeam;
        if (game.mode === 'duet' && view.phase === 'sudden-death') active = !!game.canGuess;
        phaseKey = `${view.phase}:${game.activeTeam}`;
      }
    }
    const key = view.status === 'playing' && ['decoder', 'codenames'].includes(view.gameType)
      ? `${view.code}:${view.gameType}:${view.pastGames?.length || 0}:${view.round}:${phaseKey}` : null;
    if (active && key !== state.teamLastTurnKey && getTeamSoundEnabled(view.gameType)) playTurnSound();
    state.teamLastTurnKey = key;
  }
  function updateCcTurnSound(view) {
    const game = view.status === 'playing' && view.gameType === 'carcassonne' ? view.carcassonne : null;
    const turnKey = game ? `${view.code}:${view.pastGames?.length || 0}:${view.round}:${game.currentPlayerId}` : null;
    if (game?.canAct && view.me?.role !== 'spectator' && turnKey !== state.ccLastTurnKey && getCcSoundEnabled()) {
      playTurnSound();
    }
    state.ccLastTurnKey = turnKey;
  }
  async function playTurnSound() {
    try {
      const ctx = getTurnAudioContext();
      if (ctx.state !== 'running') await ctx.resume();
      if (ctx.state !== 'running') return;
      const now = ctx.currentTime;
      // короткое восходящее «динь-дон» из двух тонов, без файлов-ассетов
      [880, 1175].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const start = now + i * 0.12;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.2, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.2);
      });
    } catch (e) { /* Web Audio недоступен — не критично */ }
  }

  // ---------- персистентная личность и кэш комнаты ----------
  // clientId переживает перезагрузку страницы (в отличие от socket.id),
  // это позволяет узнать вернувшегося игрока и восстановить его в комнате
  let clientId = null;

  function saveRoomCache(view) {
    try {
      localStorage.setItem('decoder_room_code', view.code);
      localStorage.setItem('decoder_cached_view', JSON.stringify(view));
    } catch (e) {}
  }
  function clearRoomCache() {
    try {
      localStorage.removeItem('decoder_room_code');
      localStorage.removeItem('decoder_cached_view');
    } catch (e) {}
  }
  function readCachedView(roomCode) {
    try {
      const raw = localStorage.getItem('decoder_cached_view');
      if (!raw) return null;
      const view = JSON.parse(raw);
      if (view && view.code === roomCode) return view;
    } catch (e) {}
    return null;
  }

  const urlRoomCodeEarly = new URLSearchParams(location.search).get('room');
  // код комнаты берём ТОЛЬКО из адреса страницы, не из localStorage — иначе
  // голый localhost:3000 (без ?room=) в браузере, где раньше уже была игра,
  // всегда перекидывал бы на неё вместо экрана входа. Кэш в localStorage
  // остаётся нужен только для мгновенной отрисовки при обычной перезагрузке
  // той же ?room=CODE страницы и для переподключения сокета в рамках уже
  // открытой вкладки (см. currentRoomCode = view.code в applyRoomUpdate)
  let currentRoomCode = urlRoomCodeEarly ? urlRoomCodeEarly.toUpperCase() : null;

  socket.on('connect', () => {
    ['btn-find-game', 'btn-create', 'btn-join'].forEach(id => { document.getElementById(id).disabled = false; });
    state.myId = socket.id;
    refreshReturnRooms();
    if (currentRoomCode) {
      emit('rejoin-room', { roomCode: currentRoomCode, clientId }).then((res) => {
        if (res.error) {
          currentRoomCode = null;
          clearRoomCache();
          // Keep the invitation URL so a new visitor can join after rejoin fails.
          // комнаты, чей чат мы оптимистично отрисовали из кэша, на самом
          // деле больше нет — прячем чат обратно, иначе кнопка и старые
          // сообщения останутся висеть поверх экрана входа
          state.chatOpen = false;
          $('#btn-toggle-chat').hidden = true;
          $('#chat-panel').hidden = true;
          $('#btn-toggle-games').hidden = true;
          $('#games-panel').hidden = true;
          showScreen('landing');
        }
      });
    }
  });

  socket.on('disconnect', () => {
    ['btn-find-game', 'btn-create', 'btn-join'].forEach(id => { document.getElementById(id).disabled = true; });
  });

  // ---------- ЭКРАН: вход ----------
  const nameInput = $('#input-name');
  const roomCodeInput = $('#input-room-code');
  const landingError = $('#landing-error');

  const CODENAME_WORDS = [
    'Феникс', 'Тень', 'Призрак', 'Сокол', 'Комета', 'Вихрь', 'Шторм', 'Стрела',
    'Клинок', 'Полночь', 'Скаут', 'Плющ', 'Барсук', 'Ворон', 'Лис', 'Тигр',
    'Кобра', 'Орёл', 'Панда', 'Йети',
  ];
  function generateRandomName() {
    const word = CODENAME_WORDS[Math.floor(Math.random() * CODENAME_WORDS.length)];
    const num = Math.floor(Math.random() * 90) + 10;
    return `Агент ${word}-${num}`;
  }

  let savedName = null;
  try { savedName = localStorage.getItem('decoder_name'); } catch (e) { /* localStorage может быть недоступен — не критично */ }

  if (savedName) {
    nameInput.value = savedName;
  } else {
    // случайное имя показываем как подсказку (placeholder), а не готовое
    // значение — поле выглядит пустым, но если ничего не вводить и просто
    // нажать «Создать»/«Войти», используется именно оно и сохраняется
    nameInput.value = '';
    nameInput.placeholder = generateRandomName();
  }

  function resolveName() {
    const typed = nameInput.value.trim();
    return typed || (nameInput.placeholder || '').trim();
  }

  // если в ссылке есть код комнаты — подставим
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('room')) roomCodeInput.value = urlParams.get('room').toUpperCase();

  $('#btn-create').addEventListener('click', async () => {
    const name = resolveName();
    if (!name) return showError(landingError, 'Введите имя');
    nameInput.value = name;
    try { localStorage.setItem('decoder_name', name); } catch (e) {}
    showError(landingError, '');
    const res = await emit('create-room', { name, clientId });
    if (res.error) return showError(landingError, res.error);
  });

  $('#btn-join').addEventListener('click', async () => {
    const name = resolveName();
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    if (!name) return showError(landingError, 'Введите имя');
    if (!roomCode) return showError(landingError, 'Введите код комнаты');
    nameInput.value = name;
    try { localStorage.setItem('decoder_name', name); } catch (e) {}
    showError(landingError, '');

    // сначала пробуем восстановить уже существующее членство (например, если
    // игрок раньше вышел из этой же комнаты посреди игры) — join-room не
    // пускает обратно в комнату, где игра уже началась, а rejoin-room пускает
    const rejoinRes = await emit('rejoin-room', { roomCode, clientId });
    if (rejoinRes.ok) return;

    const invite = new URLSearchParams(location.search).get('invite') || undefined;
    const res = await emit('join-room', { name, roomCode, invite });
    if (res.error) return showError(landingError, res.error);
  });

  async function refreshReturnRooms() {
    const res = await emit('my-rooms');
    const wrap = $('#resume-rooms');
    const rooms = res.rooms || [];
    wrap.hidden = rooms.length === 0;
    wrap.innerHTML = rooms.map(room => `
      <button class="btn btn-secondary resume-room" data-code="${escapeHtml(room.code)}">${room.status === 'finished' ? 'Посмотреть завершённую игру' : 'Вернуться в игру'} · ${room.gameType === 'monopoly' ? 'Монополия' : room.gameType === 'railroad' ? 'Railroad Ink' : room.gameType === 'cryptid' ? 'Криптид' : room.gameType === 'sixnimmt' ? 'Корова 006' : room.gameType === 'battleship' ? 'Морской бой' : room.gameType === 'carcassonne' ? 'Каркассон' : room.gameType === 'codenames' ? 'Codenames' : room.gameType === 'ttr' ? 'Ticket to Ride' : room.gameType === 'decoder' ? 'Декодер' : 'Приватная комната'} · ${escapeHtml(room.code)}</button>
    `).join('');
    wrap.querySelectorAll('.resume-room').forEach(button => button.addEventListener('click', async () => {
      const result = await emit('rejoin-room', { roomCode: button.dataset.code });
      if (result.error) { showError(landingError, result.error); refreshReturnRooms(); }
    }));
  }

  async function findGame(gameType) {
    const name = resolveName();
    nameInput.value = name;
    try { localStorage.setItem('decoder_name', name); } catch (e) {}
    const res = await emit('find-game', { name, gameType });
    if (res.error) showError(landingError, res.error);
    return res;
  }
  $('#btn-find-game').addEventListener('click', () => findGame($('#match-game-select input:checked')?.value));
  $('#invitation-entry').hidden = !urlParams.get('invite') || !urlParams.get('room');

  // ---------- ЭКРАН: лобби ----------
  // navigator.clipboard требует secure context (https или localhost) — при
  // заходе по обычному http (например, по IP в локальной сети с телефона,
  // ровно тот сценарий, для которого эта кнопка и нужна) API просто
  // отсутствует, и writeText тихо ничего не делает; execCommand('copy')
  // через временный textarea работает и без secure context
  async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) { /* пробуем запасной способ ниже */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  $('#btn-copy-link').addEventListener('click', async () => {
    const code = state.lastView?.code;
    if (!code) return;
    const url = `${location.origin}${location.pathname}?room=${code}&invite=${state.lastView.inviteToken}`;
    const btn = $('#btn-copy-link');
    const ok = await copyTextToClipboard(url);
    const prevText = btn.textContent;
    btn.textContent = ok ? '✓' : '✕';
    setTimeout(() => { btn.textContent = prevText; }, 1200);
  });

  async function leaveRoom() {
    if (state.lastView?.status === 'playing') {
      if (!confirm('Выйти из комнаты? Если вы участник партии, она завершится для всех.')) return;
    }
    const res = await emit('leave-room', {});
    if (res.error) return alert(res.error);
    currentRoomCode = null;
    clearRoomCache();
    history.replaceState(null, '', location.pathname);
    state.lastView = null;
    state.chatOpen = false;
    chatReplyTo = null;
    renderChatReplyPreview();
    $('#btn-toggle-chat').hidden = true;
    $('#chat-panel').hidden = true;
    $('#btn-toggle-games').hidden = true;
    $('#games-panel').hidden = true;
    showScreen('landing');
    refreshReturnRooms();
  }
  $('#btn-leave-finished').addEventListener('click', leaveRoom);
  $('#btn-leave-lobby').addEventListener('click', leaveRoom);
  $('#btn-leave-game').addEventListener('click', leaveRoom);
  $('#btn-leave-game-ttr').addEventListener('click', leaveRoom);
  $('#btn-leave-game-cn').addEventListener('click', leaveRoom);
  $('#btn-leave-game-cc').addEventListener('click', leaveRoom);
  $('#btn-leave-game-monopoly').addEventListener('click', leaveRoom);
  $('#btn-force-end-game-monopoly').addEventListener('click', forceEndGame);
  $('#btn-leave-game-railroad').addEventListener('click', leaveRoom);
  $('#btn-force-end-game-railroad').addEventListener('click', forceEndGame);
  $('#btn-leave-game-cryptid').addEventListener('click', leaveRoom);
  $('#btn-force-end-game-cryptid').addEventListener('click', forceEndGame);
  $('#btn-leave-game-six').addEventListener('click', leaveRoom);
  $('#btn-force-end-game-six').addEventListener('click', forceEndGame);
  $('#btn-leave-game-bs').addEventListener('click', leaveRoom);
  $('#btn-force-end-game-bs').addEventListener('click', forceEndGame);
  $('#btn-force-end-game-cc').addEventListener('click', forceEndGame);

  const btnTtrSoundToggle = $('#btn-ttr-sound-toggle');
  function renderTtrSoundToggle() {
    const enabled = getTtrSoundEnabled();
    btnTtrSoundToggle.textContent = enabled ? '🔔' : '🔕';
    btnTtrSoundToggle.title = enabled ? 'Звук хода: включён' : 'Звук хода: выключен';
  }
  btnTtrSoundToggle.addEventListener('click', () => {
    setTtrSoundEnabled(!getTtrSoundEnabled());
    renderTtrSoundToggle();
  });
  renderTtrSoundToggle();

  const btnCcSoundToggle = $('#btn-cc-sound-toggle');
  function renderCcSoundToggle() {
    const enabled = getCcSoundEnabled();
    btnCcSoundToggle.textContent = enabled ? '🔔' : '🔕';
    btnCcSoundToggle.title = enabled ? 'Звук хода: включён' : 'Звук хода: выключен';
    btnCcSoundToggle.setAttribute('aria-label', btnCcSoundToggle.title);
    btnCcSoundToggle.setAttribute('aria-pressed', String(enabled));
  }
  btnCcSoundToggle.addEventListener('click', () => {
    const enabled = !getCcSoundEnabled();
    try { localStorage.setItem('cc_sound_enabled', enabled ? '1' : '0'); } catch (e) {}
    renderCcSoundToggle();
    if (enabled) playTurnSound();
  });
  renderCcSoundToggle();

  for (const gameType of ['decoder', 'codenames', 'sixnimmt', 'cryptid', 'railroad', 'monopoly']) {
    const button = $(`#btn-${gameType}-sound-toggle`);
    const render = () => {
      const enabled = getTeamSoundEnabled(gameType);
      button.textContent = enabled ? '🔔' : '🔕';
      button.title = `${['sixnimmt', 'cryptid', 'railroad', 'monopoly'].includes(gameType) ? 'Звук хода' : 'Звук хода команды'}: ${enabled ? 'включён' : 'выключен'}`;
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(enabled));
    };
    button.addEventListener('click', () => {
      const enabled = !getTeamSoundEnabled(gameType);
      try { localStorage.setItem(`${gameType}_sound_enabled`, enabled ? '1' : '0'); } catch (e) {}
      render();
      if (enabled) playTurnSound();
    });
    render();
  }

  async function forceEndGame() {
    if (!confirm('Завершить текущую игру для всех? Победитель не будет определён.')) return;
    const res = await emit('force-end-game', {});
    if (res.error) alert(res.error);
  }
  $all('.btn-end-offline').forEach(button => button.addEventListener('click', forceEndGame));
  $('#btn-force-end-game').addEventListener('click', forceEndGame);
  $('#btn-force-end-game-ttr').addEventListener('click', forceEndGame);
  $('#btn-force-end-game-cn').addEventListener('click', forceEndGame);

  function updateLeaveButtons(view) {
    const safe = view.canLeaveSafely?.safe !== false;
    const reason = view.canLeaveSafely?.reason;
    [$('#btn-leave-lobby'), $('#btn-leave-game'), $('#btn-leave-game-ttr'), $('#btn-leave-game-cn'), $('#btn-leave-game-cc'), $('#btn-leave-game-bs'), $('#btn-leave-game-six'), $('#btn-leave-game-cryptid'), $('#btn-leave-game-railroad'), $('#btn-leave-game-monopoly')].forEach((btn) => {
      btn.disabled = !safe;
      btn.title = safe ? 'Выйти из комнаты' : reason;
    });
  }

  $all('.btn-join-team').forEach(btn => {
    btn.addEventListener('click', () => emit('choose-team', { team: btn.dataset.team }));
  });

  $('#btn-start-game').addEventListener('click', async () => {
    const res = await emit('start-game', {});
    if (res.error) alert(res.error);
  });

  // переключатель вида игры — сейчас единственный вариант «Декодер», но
  // сервер уже отдаёт список доступных модулей, так что новые виды игр
  // появятся здесь сами, без изменений на клиенте
  function renderGameTypePicker(view) {
    const isHost = view.me?.isHost;
    const types = (view.availableGameTypes || []).filter(t => view.visibility !== 'public' || t.id === view.gameType);
    $('#game-type-picker').innerHTML = types.map(t => `
      <button type="button" class="game-type-btn ${t.id === view.gameType ? 'active' : ''}" data-type="${t.id}" ${isHost ? '' : 'disabled'}>${escapeHtml(t.label)}</button>
    `).join('');
    if (isHost) {
      $all('.game-type-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.classList.contains('active')) return;
          const res = await emit('set-game-type', { gameType: btn.dataset.type });
          if (res.error) alert(res.error);
        });
      });
    }
  }

  function renderLobby(view) {
    $('#lobby-room-code').textContent = view.code;
    renderGameTypePicker(view);

    const isHost = view.me?.isHost;
    const isPublic = view.visibility === 'public';
    $('#btn-copy-link').hidden = isPublic;
    $('.lobby-hint').textContent = isPublic
      ? 'Подбираем игроков. Старт начнётся автоматически после короткого отсчёта.'
      : 'Отправьте друзьям ссылку-приглашение. По одному номеру войти нельзя.';
    const gameChosen = !!view.gameType;
    const pendingHint = $('#game-type-pending-hint');
    const currentModule = (view.availableGameTypes || []).find(t => t.id === view.gameType);
    const hasTeams = !!(currentModule?.teamKeys?.length) && !currentModule.autoAssignTeams;
    $('#teams-section').hidden = false;
    pendingHint.hidden = gameChosen;
    if (!gameChosen) {
      pendingHint.textContent = isHost ? 'Выберите игру, чтобы продолжить' : 'Хост выбирает игру…';
      $('#btn-start-game').hidden = true;
    }
    $('#lobby-status').hidden = !gameChosen;
    // игры без команд (teamKeys: []), например Ticket to Ride — прячем
    // блок выбора А/Б, но список игроков всё равно нужен, поэтому
    // переиспользуем unassigned-list как общий ростер (team у всех так и
    // остаётся null, никто его в таких играх не выставляет)
    $('.teams-grid').hidden = !hasTeams;

    const byTeam = { A: [], B: [], AB: [], none: [] };
    view.players.forEach(p => {
      if (!hasTeams) byTeam.none.push(p);
      else if (p.team === 'A') byTeam.A.push(p);
      else if (p.team === 'B') byTeam.B.push(p);
      else if (p.team === 'AB') byTeam.AB.push(p);
      else byTeam.none.push(p);
    });

    const renderList = (el, players) => {
      el.innerHTML = players.map(p => `
        <li class="${p.connected ? '' : 'is-offline'}">
          ${escapeHtml(p.name)}
          ${p.isHost ? '<span class="player-tag-host">хост</span>' : ''}
          ${p.id === view.me?.id ? '<span class="player-tag-you">вы</span>' : ''}
          ${!p.connected ? '<span class="player-tag-offline">офлайн</span>' : ''}
        </li>
      `).join('') || '<li style="opacity:.5">пусто</li>';
    };

    renderList($('#team-a-list'), byTeam.A);
    renderList($('#team-b-list'), byTeam.B);
    renderList($('#unassigned-list'), byTeam.none);
    $('#unassigned-wrap .field-label').textContent = hasTeams ? 'Ещё не в команде' : 'Игроки';
    $('#unassigned-wrap').hidden = hasTeams && byTeam.none.length === 0;

    const startBtn = $('#btn-start-game');
    startBtn.hidden = !isHost || !gameChosen;
    startBtn.disabled = !view.canStart;
    clearInterval(lobbyCountdown);
    const lobbyStatus = $('#lobby-status');
    if (isPublic) {
      const tick = () => {
        lobbyStatus.textContent = view.startDeadline
          ? `Игра начнётся через ${Math.max(0, Math.ceil((view.startDeadline - Date.now()) / 1000))} сек.`
          : `Ожидаем игроков… ${view.players.filter(p => p.connected).length} онлайн. ${currentModule?.startRequirementText || ''}`;
      };
      tick();
      if (view.startDeadline) lobbyCountdown = setInterval(tick, 250);
      return;
    }
    lobbyStatus.textContent = view.canStart
      ? ((isHost ? 'Можно начинать!' : 'Хост может начинать игру') + (currentModule?.autoAssignTeams ? ' Команды распределятся случайно.' : ''))
      : (currentModule?.startRequirementText || 'Недостаточно игроков');
  }

  // ---------- ЭКРАН: игра ----------
  let ownGuessDraft = [null, null, null];
  let interceptGuessDraft = [null, null, null];
  let clueInputsRound = null; // раунд, для которого сейчас отрисованы поля подсказок
  let tiebreakInputsBuilt = false; // построены ли уже 4 поля ввода тай-брейка

  let clueTimerInterval = null;

  function stopClueTimer() {
    if (clueTimerInterval) {
      clearInterval(clueTimerInterval);
      clueTimerInterval = null;
    }
    $('#clue-timer').hidden = true;
  }

  function startClueTimer(deadline) {
    stopClueTimer();
    if (!deadline) return;
    const timerEl = $('#clue-timer');
    timerEl.hidden = false;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
      const ss = String(remaining % 60).padStart(2, '0');
      timerEl.textContent = `${mm}:${ss}`;
      timerEl.classList.toggle('warning', remaining > 0 && remaining <= 15);
      timerEl.classList.toggle('expired', remaining <= 0);
      if (remaining <= 0) clearInterval(clueTimerInterval);
    };
    tick();
    clueTimerInterval = setInterval(tick, 250);
  }

  function renderRoster(view) {
    const myTeam = view.me?.role !== 'spectator' ? view.teamView?.myTeamKey : null;
    const sharedEncryptingTeam = view.round % 2 ? 'A' : 'B';
    const sharedTeam = view.phase === 'clue-giving' ? sharedEncryptingTeam : (sharedEncryptingTeam === 'A' ? 'B' : 'A');
    $('#roster-row').innerHTML = view.players.map(p => {
      const team = p.id === view.sharedPlayerId ? sharedTeam : p.team;
      const teammate = !!myTeam && team === myTeam && p.role !== 'spectator';
      return `
      <span class="roster-chip team-${(team || '').toLowerCase()} ${teammate ? 'roster-teammate' : ''} ${p.connected ? '' : 'offline'}"${teammate ? ' title="Ваша команда"' : ''}>
        <span class="dot"></span>${escapeHtml(p.name)}${p.connected ? '' : ' (офлайн)'}
        ${p.id === view.me?.id ? '<span class="player-tag-you">вы</span>' : ''}
        ${p.team === 'AB' ? '<span class="player-tag-host">общий игрок</span>' : ''}
        ${p.role === 'spectator' ? '<span class="player-tag-spectator">зритель</span>' : ''}
      </span>
    `; }).join('');
  }

  function renderGame(view) {
    $('#btn-force-end-game').hidden = !view.canForceEnd;
    renderRoster(view);
    $('#round-number').textContent = view.round;
    if (view.scoreboard) {
      $('#score-a-int').textContent = view.scoreboard.A.interceptions;
      $('#score-a-mis').textContent = view.scoreboard.A.miscommunications;
      $('#score-b-int').textContent = view.scoreboard.B.interceptions;
      $('#score-b-mis').textContent = view.scoreboard.B.miscommunications;
    }

    const tv = view.teamView;
    if (!tv) {
      $('#word-slots').innerHTML = '<div class="hint-text">👁 Вы наблюдаете за игрой.</div>';
      stopClueTimer();
      updatePauseBanner(null, null);
      return;
    }

    $('#word-slots').innerHTML = tv.myWords.length === 0
      ? '<div class="hint-text">Ваша команда не загадывает слова — весь раунд вы перехватываете код соперника.</div>'
      : tv.myWords.map((w, i) => `
      <div class="word-slot">
        <span class="slot-num">${i + 1}</span>
        <span class="slot-word">${escapeHtml(w)}</span>
      </div>
    `).join('');

    $('#my-words-terminal .terminal-label').textContent = tv.isSharedPlayer
      ? `Слова команды ${tv.myTeamKey === 'A' ? 'А' : 'Б'} — сейчас вы ${view.phase === 'clue-giving' ? 'шифруете' : view.phase === 'guessing' ? 'разгадываете' : 'смотрите результат'}`
      : 'Слова вашей команды';
    $('#shared-role-hint').hidden = !tv.isSharedPlayer;
    $('#shared-role-hint').textContent = tv.isSharedPlayer
      ? 'Вы общий игрок: шифруете для одной команды и разгадываете код другой. Перехваты и тай-брейк выполняют игроки А и Б.' : '';
    $all('.phase-panel').forEach(p => p.classList.remove('active'));

    if (view.phase !== 'clue-giving') stopClueTimer();
    if (view.phase !== 'reveal') stopRevealTimer();

    if (view.phase === 'clue-giving') {
      $('#phase-clue-giving').classList.add('active');
      renderClueGiving(view, tv);
      startClueTimer(view.clueDeadline);
    } else if (view.phase === 'guessing') {
      $('#phase-guessing').classList.add('active');
      renderGuessing(view, tv);
    } else if (view.phase === 'reveal') {
      $('#phase-reveal').classList.add('active');
      renderReveal(view, tv);
      startRevealTimer(view.revealDeadline);
    } else if (view.phase === 'tiebreak') {
      $('#phase-tiebreak').classList.add('active');
      renderTiebreak(view, tv);
    }

    updatePauseBanner(view, tv);
    renderHistory(view, tv);
    renderAssocTables(view, tv);
  }

  function updatePauseBanner(view, tv) {
    const banner = $('#pause-banner');
    let message = null;

    if (view && tv) {
      if (tv.myTeamBlocked?.blocked) {
        message = `Игра на паузе — вашей команде не хватает игроков онлайн, ждём переподключения (${tv.myTeamBlocked.offlineName || '...'})`;
      } else if (tv.oppTeamBlocked?.blocked) {
        message = `Игра на паузе — команде соперника не хватает игроков онлайн, ждём переподключения (${tv.oppTeamBlocked.offlineName || '...'})`;
      }
    }

    banner.hidden = !message;
    $('#pause-banner-text').textContent = message || '';
  }

  function renderClueGiving(view, tv) {
    const encView = $('#encryptor-view');
    const waitView = $('#waiting-view');

    if (view.loneTeam === tv.myTeamKey) {
      // соло-команда никого не шифрует — просто ждём подсказки соперника,
      // чтобы попробовать их перехватить
      encView.hidden = true;
      waitView.hidden = false;
      $('#waiting-text').textContent = tv.oppSubmittedClues
        ? 'Подсказки соперника уже переданы — сейчас начнётся перехват…'
        : `Ваша команда не шифрует. Ждём подсказки от соперника (шифрует ${tv.oppEncryptorName || '…'})…`;
      return;
    }

    if (tv.isEncryptor && !tv.mySubmittedClues) {
      encView.hidden = false;
      waitView.hidden = true;
      $('#my-code-digits').textContent = tv.myCode.join(' — ');
      const inputsWrap = $('#clue-inputs');
      // перерисовываем поля заново на каждый новый раунд (иначе у игрока,
      // повторно ставшего шифровальщиком, остаётся текст из прошлого раза);
      // в рамках ОДНОГО раунда лишний раз не трогаем — не стираем то, что
      // человек уже печатает, при повторных перерисовках экрана
      if (clueInputsRound !== view.round) {
        inputsWrap.innerHTML = tv.myCode.map((digit, i) => `
          <input type="text" maxlength="40" placeholder="Подсказка №${i + 1} (для слова №${digit})" data-idx="${i}">
        `).join('');
        clueInputsRound = view.round;
      }
    } else {
      encView.hidden = true;
      waitView.hidden = false;
      if (tv.isEncryptor && tv.mySubmittedClues) {
        $('#waiting-text').textContent = 'Подсказки переданы. Ждём другую команду…';
      } else if (!tv.mySubmittedClues) {
        const offlineNote = tv.encryptorConnected === false ? ' — потерял соединение, ждём…' : '';
        $('#waiting-text').textContent = `Шифровальщик вашей команды (${tv.encryptorName || '…'}) придумывает подсказки…${offlineNote}`;
      } else {
        $('#waiting-text').textContent = 'Ждём подсказки от соперника…';
      }
    }
  }

  $('#btn-submit-clues').addEventListener('click', async () => {
    const clues = $all('#clue-inputs input').map(i => i.value.trim());
    if (clues.some(c => !c)) return alert('Заполните все 3 подсказки');
    const res = await emit('submit-clues', { clues });
    if (res.error) alert(res.error);
  });

  function renderGuessing(view, tv) {
    const partnerGuesses = $('#shared-partner-guesses');
    partnerGuesses.hidden = !tv.isSharedPlayer;
    partnerGuesses.innerHTML = tv.isSharedPlayer ? `
      <div class="partner-section-heading"><h3>Ответы партнёров</h3><span>Обновляются по ходу выбора</span></div>
      <div class="partner-cards">${(tv.partnerGuesses || []).map(partner => {
        const answer = (label, guess, locked) => {
          const started = guess.some(digit => digit != null);
          return `<div class="partner-answer ${locked ? 'is-confirmed' : ''}">
            <div class="partner-answer-heading"><span>${label}</span><span class="partner-answer-status ${locked ? 'is-confirmed' : ''}">${locked ? '✓ Подтверждено' : started ? 'Выбирает' : 'Ожидаем ответ'}</span></div>
            <div class="partner-digits" aria-label="${label}: ${guess.map(digit => digit ?? 'не выбрано').join(', ')}">${guess.map(digit => `<span class="partner-digit ${digit == null ? 'is-empty' : ''}">${digit ?? '·'}</span>`).join('')}</div>
          </div>`;
        };
        const oppositeTeam = partner.team === 'A' ? 'Б' : 'А';
        return `<article class="partner-card team-${partner.team.toLowerCase()}">
          <header class="partner-card-heading"><div><strong>${escapeHtml(partner.name)}</strong><p>${partner.ownGuess ? 'Разгадывает ваш код' : 'Подсказывает вам'}</p></div><span class="partner-team-badge">${partner.team === 'A' ? 'А' : 'Б'}</span></header>
          ${partner.ownGuess ? answer('Ваш код', partner.ownGuess, partner.ownLocked) : ''}
          ${answer(`Перехват команды ${oppositeTeam}`, partner.interceptGuess, partner.interceptLocked)}
        </article>`;
      }).join('')}</div>` : '';
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    const isLoneMe = view.loneTeam === tv.myTeamKey;
    const oppIsLone = view.loneTeam === oppTeamKey;

    $('#clue-card-mine').className = `clue-card team-${tv.myTeamKey.toLowerCase()}`;
    $('#clue-card-opponent').className = `clue-card team-${oppTeamKey.toLowerCase()}`;
    $('#clues-mine').innerHTML = isLoneMe
      ? '<p class="hint-text">Ваша команда не даёт подсказок</p>'
      : (tv.clues.mine || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');
    $('#clues-opponent').innerHTML = oppIsLone
      ? '<p class="hint-text">Соперник не шифрует — перехватывать нечего</p>'
      : (tv.clues.opponent || []).map(c => `<li>${escapeHtml(c)}</li>`).join('');

    // соло-команде нечего расшифровывать у себя; команде из двух нечего
    // перехватывать у соло-соперника — прячем неактуальную половину панели
    $('#guess-board-own').hidden = isLoneMe;
    $('#guess-board-intercept').hidden = oppIsLone || tv.isSharedPlayer;
    $('#guess-board-intercept').setAttribute('aria-disabled', String(!!tv.isSharedPlayer));
    $('#intercept-board-hint').textContent = tv.isSharedPlayer
      ? '(общий игрок не участвует в перехватах)' : '(попробуйте перехватить)';

    ownGuessDraft = tv.ownGuess ? [...tv.ownGuess] : [null, null, null];
    interceptGuessDraft = tv.interceptGuess ? [...tv.interceptGuess] : [null, null, null];

    if (!isLoneMe) renderPicker('picker-own', ownGuessDraft, tv.ownLocked || tv.isEncryptor, 'own');
    if (!oppIsLone) renderPicker('picker-intercept', interceptGuessDraft, tv.interceptLocked || tv.isSharedPlayer, 'intercept');

    $('#own-board-hint').textContent = tv.isEncryptor
      ? '(отгадывают товарищи по команде)'
      : '(расшифруйте свои подсказки)';

    const lockOwnBtn = $('#lock-own');
    const lockInterceptBtn = $('#lock-intercept');
    lockOwnBtn.disabled = tv.ownLocked || tv.isEncryptor;
    lockOwnBtn.textContent = tv.ownLocked ? 'Подтверждено ✓' : (tv.isEncryptor ? 'Не для вас' : 'Подтвердить');
    lockInterceptBtn.disabled = tv.interceptLocked || tv.isSharedPlayer;
    lockInterceptBtn.textContent = tv.isSharedPlayer ? 'Недоступно' : tv.interceptLocked ? 'Подтверждено ✓' : 'Подтвердить';
  }

  function renderPicker(elId, draft, locked, kind) {
    const el = $(`#${elId}`);
    el.innerHTML = draft.map((val, slotIdx) => `
      <div class="digit-slot ${val ? 'filled' : ''} ${locked ? 'locked' : ''}" data-slot="${slotIdx}" data-kind="${kind}">
        ${val || '?'}
      </div>
    `).join('');
    if (!locked) {
      $all(`#${elId} .digit-slot`).forEach(slot => {
        slot.addEventListener('click', () => cycleDigit(kind, Number(slot.dataset.slot)));
      });
    }
  }

  async function cycleDigit(kind, slotIdx) {
    const draft = kind === 'own' ? ownGuessDraft : interceptGuessDraft;
    const current = draft[slotIdx] || 0;
    draft[slotIdx] = (current % 4) + 1;
    renderPicker(kind === 'own' ? 'picker-own' : 'picker-intercept', draft,
      false, kind);
    await emit('update-guess', { kind, guess: draft });
  }

  $('#lock-own').addEventListener('click', async () => {
    const res = await emit('lock-guess', { kind: 'own' });
    if (res.error) alert(res.error);
  });
  $('#lock-intercept').addEventListener('click', async () => {
    const res = await emit('lock-guess', { kind: 'intercept' });
    if (res.error) alert(res.error);
  });

  function digitChips(guess, allCorrect) {
    return guess.map(g => `<span class="digit-chip ${allCorrect === null ? '' : allCorrect ? 'match' : 'miss'}">${g}</span>`).join('');
  }

  function renderReveal(view, tv) {
    if (!tv.lastReveal) return;
    const board = $('#reveal-board');
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    const byKey = { [tv.myTeamKey]: tv.lastReveal.mine, [oppTeamKey]: tv.lastReveal.opponent };
    const order = tv.myTeamKey === 'A' ? ['A', 'B'] : ['B', 'A'];

    board.innerHTML = order.map((key) => {
      const r = byKey[key];
      const isLoneCard = view.loneTeam === key;
      // справа от названия команды ничего не показываем — только сам ход
      // (цифры хода) и цвет говорят, угадали или нет; никаких «?»
      const head = `
        <div class="reveal-head">
          <span class="team-dot"></span>
          <strong>Команда ${key === 'A' ? 'А' : 'Б'}</strong>
        </div>
      `;

      if (isLoneCard) {
        // соло-команда не загадывает код — единственный итог для неё:
        // её собственная попытка перехватить код соперника
        const otherKey = key === 'A' ? 'B' : 'A';
        const otherR = byKey[otherKey];
        const intercepted = otherR ? otherR.interceptCorrect : false;
        const guess = otherR ? otherR.interceptGuess : null;
        return `
          <div class="reveal-team team-${key.toLowerCase()}">
            ${head}
            <div class="reveal-line">
              <span class="reveal-line-label">Перехват кода соперника</span>
              <span class="digit-row">${guess ? digitChips(guess, intercepted) : ''}</span>
            </div>
          </div>
        `;
      }

      const interceptLine = view.loneTeam ? '' : `
        <div class="reveal-line">
          <span class="reveal-line-label">Перехват соперника</span>
          <span class="digit-row">${digitChips(r.interceptGuess, r.interceptCorrect)}</span>
        </div>
      `;

      return `
        <div class="reveal-team team-${key.toLowerCase()}">
          ${head}
          <div class="reveal-line">
            <span class="reveal-line-label">Настоящий код</span>
            <span class="digit-row">${digitChips(r.code, true)}</span>
          </div>
          <div class="reveal-line">
            <span class="reveal-line-label">Своя расшифровка</span>
            <span class="digit-row">${digitChips(r.ownGuess, r.ownCorrect)}</span>
          </div>
          ${interceptLine}
        </div>
      `;
    }).join('');
  }

  let revealTimerInterval = null;
  function stopRevealTimer() {
    if (revealTimerInterval) {
      clearInterval(revealTimerInterval);
      revealTimerInterval = null;
    }
  }
  function startRevealTimer(deadline) {
    stopRevealTimer();
    const el = $('#next-round-seconds');
    if (!deadline || !el) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.textContent = remaining;
      if (remaining <= 0) stopRevealTimer();
    };
    tick();
    revealTimerInterval = setInterval(tick, 250);
  }

  // тай-брейк: счёт равный даже по основным условиям — обе команды по
  // памяти пытаются угадать все 4 слова соперника (не порядок, а сами слова)
  function renderTiebreak(view, tv) {
    if (!tv.tiebreak) return;
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    const tb = tv.tiebreak;

    const formWrap = $('#tiebreak-form-wrap');
    const waiting = $('#tiebreak-waiting');
    const resultEl = $('#tiebreak-result');

    if (tb.result) {
      formWrap.hidden = true;
      waiting.hidden = true;
      resultEl.hidden = false;
      const myScore = tb.result[tv.myTeamKey];
      const oppScore = tb.result[oppTeamKey];
      resultEl.innerHTML = `
        <div class="tiebreak-scores">
          <div class="tiebreak-score-line">Ваша команда угадала: <strong>${myScore} из 4</strong></div>
          <div class="tiebreak-score-line">Соперник угадал: <strong>${oppScore} из 4</strong></div>
        </div>
        <div class="tiebreak-words">
          <div class="field-label">Слова соперника были:</div>
          <div class="tiebreak-word-chips">${(tb.oppWords || []).map(w => `<span class="tiebreak-word-chip">${escapeHtml(w)}</span>`).join('')}</div>
        </div>
      `;
      tiebreakInputsBuilt = false; // на случай нового тай-брейка в будущей игре
      return;
    }

    resultEl.hidden = true;

    $('#tiebreak-waiting p').textContent = tv.isSharedPlayer
      ? 'Вы знаете слова обеих команд. Ждём ответы игроков А и Б…'
      : 'Ответ подтверждён. Ждём соперника…';
    if (tb.myLocked || tv.isSharedPlayer) {
      formWrap.hidden = true;
      waiting.hidden = false;
      return;
    }

    formWrap.hidden = false;
    waiting.hidden = true;

    if (!tiebreakInputsBuilt) {
      $('#tiebreak-inputs').innerHTML = [0, 1, 2, 3].map(i => `
        <input type="text" class="tiebreak-input" maxlength="30" data-idx="${i}"
          placeholder="Слово соперника №${i + 1}" autocomplete="off"
          value="${escapeHtml(tb.myGuess?.[i] || '')}">
      `).join('');
      $all('.tiebreak-input').forEach(inp => {
        inp.addEventListener('input', async () => {
          const words = $all('.tiebreak-input').map(el => el.value);
          await emit('update-tiebreak-guess', { words });
        });
      });
      tiebreakInputsBuilt = true;
    }

    // черновик общий на команду — подтягиваем то, что напечатали товарищи
    // по команде, но не трогаем поле, в которое сейчас печатает сам игрок
    // (иначе перебьём ввод и собьём позицию курсора)
    $all('.tiebreak-input').forEach((inp, i) => {
      if (document.activeElement === inp) return;
      const val = tb.myGuess?.[i] || '';
      if (inp.value !== val) inp.value = val;
    });
  }

  $('#btn-submit-tiebreak').addEventListener('click', async () => {
    const res = await emit('lock-tiebreak-guess');
    if (res.error) alert(res.error);
  });

  // раскрашивает угаданные в тай-брейке слова: зелёный, если слово реально
  // есть среди настоящих слов соперника (без повторного зачёта одного и
  // того же слова дважды), иначе красный
  function wordChips(guessWords, actualWords) {
    const pool = (actualWords || []).map(w => w.toLowerCase());
    return (guessWords || []).map(w => {
      const idx = pool.indexOf((w || '').toLowerCase());
      const match = idx !== -1;
      if (match) pool.splice(idx, 1);
      return `<span class="tiebreak-word-chip ${match ? 'match' : 'miss'}">${escapeHtml(w || '—')}</span>`;
    }).join('');
  }

  // тай-брейк — тоже раунд для истории: показываем, какие слова
  // соперника угадывала наша команда и какие наши слова угадывал соперник
  function renderTiebreakHistoryBlock(view, tv) {
    const tb = tv.tiebreak;
    if (!tb || !tb.result) return '';
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    return `
      <div class="history-round">
        <div class="h-round-num">Тай-брейк</div>
        <div class="h-team-block team-${tv.myTeamKey.toLowerCase()}">
          <div class="h-team-head">
            <span class="team-dot"></span>
            <span>Команда ${tv.myTeamKey === 'A' ? 'А' : 'Б'}</span>
          </div>
          <div class="h-clues">Угадывали слова команды ${oppTeamKey === 'A' ? 'А' : 'Б'}</div>
          <div class="tiebreak-word-chips">${wordChips(tb.myGuess, tb.oppWords)}</div>
        </div>
        <div class="h-team-block team-${oppTeamKey.toLowerCase()}">
          <div class="h-team-head">
            <span class="team-dot"></span>
            <span>Команда ${oppTeamKey === 'A' ? 'А' : 'Б'}</span>
          </div>
          <div class="h-clues">Угадывали слова команды ${tv.myTeamKey === 'A' ? 'А' : 'Б'}</div>
          <div class="tiebreak-word-chips">${wordChips(tb.oppGuess, tv.myWords)}</div>
        </div>
      </div>
    `;
  }

  // история раундов: только реальный ход команды (её догадка) и цвет —
  // без текстовых пометок «ошибка/успех» и без символов «?», цвет чипа сам
  // по себе говорит, угадали или нет
  function renderHistory(view, tv, targetSelector = '#history-content') {
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    const byRound = new Map();
    (tv.history.mine || []).forEach(h => {
      if (!byRound.has(h.round)) byRound.set(h.round, {});
      byRound.get(h.round)[tv.myTeamKey] = h;
    });
    (tv.history.opponent || []).forEach(h => {
      if (!byRound.has(h.round)) byRound.set(h.round, {});
      byRound.get(h.round)[oppTeamKey] = h;
    });

    const rounds = [...byRound.entries()].sort((a, b) => b[0] - a[0]);

    // тай-брейк случается после всех обычных раундов — показываем его
    // первым (сверху), как самое недавнее событие
    const tiebreakHtml = renderTiebreakHistoryBlock(view, tv);

    $(targetSelector).innerHTML = tiebreakHtml + (rounds.map(([roundNum, teams]) => `
      <div class="history-round">
        <div class="h-round-num">Раунд ${roundNum}</div>
        ${[tv.myTeamKey, oppTeamKey].map((key) => {
          const h = teams[key];
          if (!h) return '';
          const otherKey = key === 'A' ? 'B' : 'A';
          const otherH = teams[otherKey];
          // interceptGuess/interceptCorrect в истории КОМАНДЫ-ПРОТИВНИКА (otherH)
          // на самом деле хранят попытку ЭТОЙ команды (key) перехватить otherKey —
          // так мы получаем «наш» перехват из «их» записи за тот же раунд
          const weIntercepted = otherH ? otherH.interceptCorrect : false;
          const interceptGuess = otherH ? otherH.interceptGuess : null;
          const isLoneTeam = view.loneTeam === key;
          // у команды из двух, если соперник — соло-игрок, перехватывать
          // нечего (у соло нет кода) — эта строка для неё бессмысленна
          const isDuoVsSoloOpponent = view.loneTeam && !isLoneTeam;
          return `
            <div class="h-team-block team-${key.toLowerCase()}">
              <div class="h-team-head">
                <span class="team-dot"></span>
                <span>Команда ${key === 'A' ? 'А' : 'Б'}</span>
              </div>
              ${isLoneTeam ? '' : `<div class="h-clues">${(h.clues || []).map(escapeHtml).join(' · ')}</div>`}
              <div class="h-code-head" aria-hidden="true"><span></span><span>Версия</span><span>Результат</span></div>
              ${isLoneTeam ? '' : `
                <div class="h-line h-code-line">
                  <span class="h-line-label">Своя расшифровка</span>
                  <span class="digit-row" aria-label="Предположение команды">${digitChips(h.ownGuess, h.ownCorrect)}</span>
                  <span class="digit-row" aria-label="Настоящий код своей команды">${h.code ? digitChips(h.code, null) : '—'}</span>
                </div>
              `}
              ${isDuoVsSoloOpponent ? '' : `
                <div class="h-line h-code-line">
                  <span class="h-line-label">Перехват соперника</span>
                  <span class="digit-row" aria-label="Предположение перехвата">${interceptGuess ? digitChips(interceptGuess, weIntercepted) : '<span class="assoc-empty">—</span>'}</span>
                  <span class="digit-row" aria-label="Настоящий код соперника">${otherH?.code ? digitChips(otherH.code, null) : '—'}</span>
                </div>
              `}
            </div>
          `;
        }).join('')}
      </div>
    `).join('')) || '<p class="hint-text">Пока нет истории</p>';
  }

  // строит по раундам таблицу «какая подсказка соответствовала какому слову»:
  // код раунда — это перестановка 3 из 4 номеров слов, clues[i] — подсказка
  // для слова под номером code[i]
  function buildAssocRows(history) {
    return [...history].sort((a, b) => a.round - b.round).map(h => {
      const bySlot = [null, null, null, null];
      // В старом соло-режиме у перехватчика нет собственного кода —
      // тогда мы не знаем, какая подсказка к какому слову относилась
      if (h.code) h.code.forEach((wordNum, i) => { bySlot[wordNum - 1] = h.clues[i]; });
      return { round: h.round, bySlot };
    });
  }

  function renderAssocTable(rows) {
    if (!rows.length) return '<p class="hint-text">Пока нет данных</p>';
    return `
      <table class="assoc-table">
        <thead><tr><th>Раунд</th><th>1</th><th>2</th><th>3</th><th>4</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="assoc-round">${r.round}</td>
              ${r.bySlot.map(c => `<td>${c ? escapeHtml(c) : '<span class="assoc-empty">—</span>'}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // группирует историю по СЛОВУ (а не по раунду): для каждого из 4 слов —
  // список подсказок, которые к нему давали, по всем сыгранным раундам
  function buildWordAssoc(history, words) {
    const perWord = words.map((word, i) => ({ slot: i + 1, word, entries: [] }));
    [...history].sort((a, b) => a.round - b.round).forEach(h => {
      if (!h.code) return;
      h.code.forEach((wordNum, i) => {
        perWord[wordNum - 1].entries.push({ round: h.round, clue: h.clues[i] });
      });
    });
    return perWord;
  }

  // слово в рамке (как на игровом экране) + все ассоциации к нему снизу,
  // без номеров раундов — просто список всех подсказок, что к нему давали
  function renderWordAssocCards(words, history) {
    if (!words || !words.length) return '<p class="hint-text">Нет слов</p>';
    const perWord = buildWordAssoc(history, words);
    return `
      <div class="assoc-word-grid">
        ${perWord.map(w => `
          <div class="assoc-word-card">
            <div class="assoc-word-title">${escapeHtml(w.word)}</div>
            <div class="assoc-word-list">
              ${w.entries.length ? w.entries.map(e => `
                <div class="assoc-word-entry">${escapeHtml(e.clue)}</div>
              `).join('') : '<div class="assoc-word-entry assoc-empty">—</div>'}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // full=true — режим финального экрана: слова уже не секрет, показываем
  // их в рамке и все ассоциации к ним по всем раундам; иначе (во время
  // игры) слова соперника ещё неизвестны — остаётся старая таблица по слотам
  function renderAssocTables(view, tv, targetSelector = '#assoc-content', full = false) {
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';

    const mineSection = view.loneTeam === tv.myTeamKey
      ? '<p class="hint-text">Ваша команда не загадывает слова</p>'
      : (full ? renderWordAssocCards(tv.myWords, tv.history.mine || []) : renderAssocTable(buildAssocRows(tv.history.mine || [])));
    const oppSection = view.loneTeam === oppTeamKey
      ? '<p class="hint-text">У соперника нет своих слов</p>'
      : (full ? renderWordAssocCards(tv.oppWords, tv.history.opponent || []) : renderAssocTable(buildAssocRows(tv.history.opponent || [])));

    $(targetSelector).innerHTML = `
      <div class="assoc-block">
        <div class="assoc-block-title">Ваши слова</div>
        ${mineSection}
      </div>
      <div class="assoc-block">
        <div class="assoc-block-title">Слова соперника</div>
        ${oppSection}
      </div>
    `;
  }

  $all('.history-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $all('.history-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('#history-content').hidden = btn.dataset.tab !== 'rounds';
      $('#assoc-content').hidden = btn.dataset.tab !== 'assoc';
    });
  });

  function toggleHistoryPanel() {
    state.historyOpen = !state.historyOpen;
    $('#history-panel').hidden = !state.historyOpen;
  }
  $('#btn-toggle-history').addEventListener('click', toggleHistoryPanel);
  $('#btn-toggle-history-finished').addEventListener('click', toggleHistoryPanel);
  $('#btn-close-history').addEventListener('click', () => {
    state.historyOpen = false;
    $('#history-panel').hidden = true;
  });

  // ---------- ПРОШЛЫЕ ИГРЫ В КОМНАТЕ ----------
  // законченные партии больше не секрет ни для кого в комнате, поэтому
  // просто пересобираем их в форму teamView/view, которую уже умеют
  // рисовать renderHistory/renderAssocTables — с точки зрения команды
  // текущего игрока (а если он не в команде — с точки зрения А)
  function buildPastGameTv(game, perspectiveTeam) {
    const otherTeam = perspectiveTeam === 'A' ? 'B' : 'A';
    const myTeam = game.teams[perspectiveTeam];
    const oppTeam = game.teams[otherTeam];
    const tb = game.tiebreak;
    return {
      myTeamKey: perspectiveTeam,
      myWords: myTeam.words,
      oppWords: oppTeam.words,
      history: { mine: myTeam.history, opponent: oppTeam.history },
      tiebreak: (tb && tb.result) ? {
        myGuess: tb.guesses[perspectiveTeam],
        oppGuess: tb.guesses[otherTeam],
        result: tb.result,
        oppWords: oppTeam.words,
      } : null,
    };
  }

  function renderGamesList(view) {
    const games = view.pastGames || [];
    $('#games-list-content').hidden = false;
    $('#games-detail-content').hidden = true;
    if (!games.length) {
      $('#games-list-content').innerHTML = '<p class="hint-text">В этой комнате пока не было завершённых игр</p>';
      return;
    }
    $('#games-list-content').innerHTML = [...games].reverse().map(g => {
      const isDraw = g.winner === 'draw';
      const title = g.monopoly ? (isDraw ? 'Партия завершена' : `Победа: ${escapeHtml(g.monopoly.names[g.winner] || '')}`) : g.railroad ? (isDraw ? 'Разделённая победа' : `Railroad Ink: ${escapeHtml(g.railroad.names[g.winner] || '')}`) : g.cryptid ? (isDraw ? 'Партия завершена' : `Открытие: ${escapeHtml(g.cryptid.names[g.winner] || '')}`) : g.sixnimmt ? (isDraw ? 'Разделённая победа' : `Победа: ${escapeHtml(g.sixnimmt.names[g.winner] || '')}`) : g.battleship ? (isDraw ? 'Ничья' : `Победа: ${escapeHtml(g.battleship.names[g.winner] || '')}`) : g.carcassonne ? (isDraw ? 'Ничья' : `Победа: ${escapeHtml(g.carcassonne.names[g.winner] || '')}`) : g.codenames?.mode === 'duet' ? (g.winner === 'coop-win' ? 'Миссия выполнена' : isDraw ? 'Партия завершена' : 'Миссия провалена') : isDraw ? 'Ничья' : `Победа команды ${g.winner === 'A' ? 'А' : 'Б'}`;
      const when = new Date(g.finishedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `
        <button class="games-list-item" data-game="${g.gameNumber}">
          <span class="games-item-title">Игра ${g.gameNumber} — ${title}</span>
          <span class="games-item-reason">${escapeHtml(g.winReason || '')} · ${when}</span>
        </button>
      `;
    }).join('');
    $all('.games-list-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const game = games.find(g => g.gameNumber === Number(btn.dataset.game));
        if (game) renderGameDetail(view, game);
      });
    });
  }

  function renderGameDetail(view, game) {
    if (game.gameType === 'monopoly') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Монополия · Москва — игра ${game.gameNumber}`;
      $('#games-detail-assoc').innerHTML = '';
      window.MonopolyUI.report(game.monopoly, '#games-detail-history');
      return;
    }
    if (game.gameType === 'railroad') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Railroad Ink — игра ${game.gameNumber}`;
      window.RailroadUI.report(game.railroad, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    if (game.gameType === 'cryptid') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Криптид — игра ${game.gameNumber}`;
      window.CryptidUI.report(game.cryptid, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    if (game.gameType === 'sixnimmt') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Корова 006 — игра ${game.gameNumber}`;
      window.SixNimmtUI.report(game.sixnimmt, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    if (game.gameType === 'battleship') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Морской бой — игра ${game.gameNumber}`;
      window.BattleshipUI.report(game.battleship, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    if (game.gameType === 'carcassonne') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Каркассон — игра ${game.gameNumber}`;
      window.CarcassonneUI.report(game.carcassonne, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    if (game.gameType === 'codenames') {
      $('#games-list-content').hidden = true;
      $('#games-detail-content').hidden = false;
      $('#games-detail-title').textContent = `Codenames — игра ${game.gameNumber}`;
      window.CodenamesUI.report(game.codenames, '#games-detail-history');
      $('#games-detail-assoc').innerHTML = '';
      return;
    }
    const perspectiveTeam = view.me?.team === 'B' ? 'B' : 'A';
    const pastTv = buildPastGameTv(game, perspectiveTeam);
    const pastView = { loneTeam: game.loneTeam };

    $('#games-list-content').hidden = true;
    $('#games-detail-content').hidden = false;
    const isDraw = game.winner === 'draw';
    const title = isDraw ? 'Ничья' : `Победа команды ${game.winner === 'A' ? 'А' : 'Б'}`;
    $('#games-detail-title').textContent = `Игра ${game.gameNumber} — ${title}`;
    renderHistory(pastView, pastTv, '#games-detail-history');
    renderAssocTables(pastView, pastTv, '#games-detail-assoc', true);
  }

  $('#btn-games-back').addEventListener('click', () => {
    $('#games-list-content').hidden = false;
    $('#games-detail-content').hidden = true;
  });

  $('#btn-toggle-games').addEventListener('click', () => {
    state.gamesOpen = !state.gamesOpen;
    $('#games-panel').hidden = !state.gamesOpen;
    if (state.gamesOpen && state.lastView) renderGamesList(state.lastView);
  });
  $('#btn-close-games').addEventListener('click', () => {
    state.gamesOpen = false;
    $('#games-panel').hidden = true;
  });

  // ---------- ЭКРАН: конец игры ----------
  function renderFinished(view) {
    $('#monopoly-finished-report').hidden = view.gameType !== 'monopoly';
    $('#railroad-finished-report').hidden = view.gameType !== 'railroad';
    $('#cryptid-finished-report').hidden = view.gameType !== 'cryptid';
    $('#sixnimmt-finished-report').hidden = view.gameType !== 'sixnimmt';
    $('#battleship-finished-report').hidden = view.gameType !== 'battleship';
    $('#carcassonne-finished-report').hidden = view.gameType !== 'carcassonne';
    $('#codenames-finished-report').hidden = view.gameType !== 'codenames';
    const isTtr = ['ttr', 'carcassonne', 'battleship', 'sixnimmt', 'cryptid', 'railroad', 'monopoly'].includes(view.gameType);
    const isDraw = view.winner === 'draw';
    const won = isTtr ? (view.winner === view.me?.id) : (!isDraw && view.me?.team && view.winner === view.me.team);
    $('#finished-title').textContent = isDraw
      ? 'Ничья! 🤝'
      : won ? 'Победа! 🎉' : (isTtr || !view.me?.team || view.me.team === 'AB' ? 'Игра окончена' : 'Поражение');
    if (view.codenames?.mode === 'duet') $('#finished-title').textContent = view.winner === 'coop-win' ? 'Миссия выполнена! 🎉' : view.winner === 'draw' ? 'Партия завершена' : 'Миссия провалена';
    $('#finished-reason').textContent = view.winReason || '';
    const isHost = view.me?.isHost;
    const isPublic = view.visibility === 'public';
    $('#btn-play-again').hidden = !isPublic && !view.canRestart;
    $('#btn-play-again').textContent = isPublic ? 'Найти новую игру' : 'Играть ещё раз';
    $('#finished-wait-hint').hidden = isPublic || !!view.canRestart;
    if (!isPublic && !isHost) {
      const host = view.players.find(p => p.isHost);
      $('#finished-wait-hint').textContent = (host && !host.connected)
        ? `Ждём хоста (${host.name}) — потерял соединение…`
        : 'Ждём хоста…';
    }

    if (view.gameType === 'monopoly') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.MonopolyUI.report(view.monopoly, '#monopoly-finished-report');
      return;
    }
    if (view.gameType === 'railroad') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      if (view.railroad.playerIds.length === 1 && view.winner !== 'draw') $('#finished-title').textContent = 'Сеть построена!';
      window.RailroadUI.finish(view, '#railroad-finished-report');
      return;
    }
    if (view.gameType === 'cryptid') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.CryptidUI.report(view.cryptid, '#cryptid-finished-report');
      return;
    }
    if (view.gameType === 'sixnimmt') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.SixNimmtUI.report(view.sixnimmt, '#sixnimmt-finished-report');
      return;
    }
    if (view.gameType === 'battleship') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.BattleshipUI.report(view.battleship, '#battleship-finished-report');
      return;
    }
    if (view.gameType === 'carcassonne') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.CarcassonneUI.report(view.carcassonne, '#carcassonne-finished-report');
      return;
    }
    if (view.gameType === 'codenames') {
      $('#finished-report').hidden = true;
      $('#ttr-finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      window.CodenamesUI.report(view.codenames, '#codenames-finished-report', `${view.code}:${view.pastGames.length}`);
      return;
    }
    if (isTtr) {
      $('#finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      $('#ttr-finished-report').hidden = false;
      loadTtrAssets().then(() => {
        if (state.lastView !== view) return; // комната уже ушла дальше, пока грузилась карта
        if (!ttrFinishedMapMounted) { mountTtrFinishedMap(); ttrFinishedMapMounted = true; }
        paintTtrFinishedRoutes(view);
        renderTtrFinishedScores(view);
      });
      return;
    }
    $('#ttr-finished-report').hidden = true;

    // игра закончилась — сразу показываем таблицы ассоциаций (свои слова и
    // слова соперника), а историю раундов — по кнопке, в том же боковом
    // окне, что и во время игры
    const tv = view.teamView;
    $('#finished-report').hidden = !tv;
    $('#btn-toggle-history-finished').hidden = !tv;
    if (tv) {
      renderAssocTables(view, tv, '#finished-assoc-content', true);
      renderHistory(view, tv);
      renderAssocTables(view, tv);
    }
  }

  $('#btn-play-again').addEventListener('click', async () => {
    if (state.lastView?.visibility === 'public') {
      const res = await findGame(state.lastView.gameType);
      if (res.error) alert(res.error);
      return;
    }
    const res = await emit('play-again', {});
    if (res.error) alert(res.error);
  });

  // ---------- ЭКРАН: игра (Ticket to Ride) ----------
  // палитра карт вагонов — цвета сверены с заливками в самом SVG (см. map.js
  // и CLAUDE.md про #AC7F5E = "white"); отдельная палитра для цвета ИГРОКА
  // (playerColor), т.к. это две не пересекающиеся шкалы: цвет карты
  // маршрута — игровые данные, цвет владения — окраска клиента поверх карты
  const TTR_CARD_HEX = {
    pink: '#FBB0C7', white: '#AC7F5E', blue: '#0088FF', yellow: '#FFCC00',
    orange: '#FF8D28', black: '#8E8E93', red: '#FF383C', green: '#34C759',
    locomotive: '#B980F0',
  };
  // ключ 'white' остаётся 'white' (нужен для сопоставления с правилами
  // маршрутов/составом колоды — см. CLAUDE.md про #AC7F5E), но подпись для
  // игрока — "Коричневый": реальный цвет карты визуально коричневый/кремовый,
  // называть его "Белый" в UI только путало при выборе карт на оплату
  const TTR_CARD_LABELS = {
    pink: 'Розовый', white: 'Коричневый', blue: 'Синий', yellow: 'Жёлтый',
    orange: 'Оранжевый', black: 'Чёрный', red: 'Красный', green: 'Зелёный',
    locomotive: 'Локомотив',
  };
  // картинки карт вагонов (public/ttr/cards/) — имена файлов совпадают с
  // игровыми цветами, кроме двух: официальный цвет "white" на самом деле
  // рисуется коричневым (см. CLAUDE.md про #AC7F5E), и локомотив-джокер
  // называется "rainbow"
  const TTR_CARD_IMAGE = {
    pink: 'pink.jpg', white: 'brown.png', blue: 'blue.jpg', yellow: 'yellow.jpg',
    orange: 'orange.jpg', black: 'black.jpg', red: 'red.jpg', green: 'green.jpg',
    locomotive: 'rainbow.jpg',
  };
  const TTR_PLAYER_HEX = { red: '#E5484D', blue: '#0091FF', green: '#30A46C', yellow: '#F5D90A', black: '#495057' };

  // сдвигает hex-цвет к белому (percent > 0) или к чёрному (percent < 0)
  function ttrShade(hex, percent) {
    const num = parseInt(hex.slice(1), 16);
    const amt = Math.round(2.55 * percent);
    const r = Math.max(0, Math.min(255, (num >> 16) + amt));
    const g = Math.max(0, Math.min(255, (num >> 8 & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (num & 0xff) + amt));
    return '#' + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
  }

  // градиент + обводка на цвет владения — иначе купленный красным игроком
  // маршрут с исходным игровым цветом "red" неотличим от простого красного
  // маршрута (плоская заливка та же). Градиент даёт объёмный "жетон", не
  // пересекается по виду с плоскими игровыми цветами карт.
  function buildTtrOwnerGradients(svg) {
    const svgNS = 'http://www.w3.org/2000/svg';
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(svgNS, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    Object.entries(TTR_PLAYER_HEX).forEach(([name, hex]) => {
      const grad = document.createElementNS(svgNS, 'linearGradient');
      grad.setAttribute('id', `ttr-owner-grad-${name}`);
      // вертикальный (поперёк длины вагона, а не вдоль неё) градиент с
      // резким светлым краем сверху — читается как скруглённый выпуклый
      // брусок, освещённый сверху, а не просто плоская заливка с переливом
      grad.setAttribute('x1', '0%'); grad.setAttribute('y1', '0%');
      grad.setAttribute('x2', '0%'); grad.setAttribute('y2', '100%');
      [
        [0, ttrShade(hex, 65)],
        [25, ttrShade(hex, 30)],
        [55, hex],
        [100, ttrShade(hex, -40)],
      ].forEach(([offset, color]) => {
        const stop = document.createElementNS(svgNS, 'stop');
        stop.setAttribute('offset', `${offset}%`);
        stop.setAttribute('stop-color', color);
        grad.appendChild(stop);
      });
      defs.appendChild(grad);
    });
  }

  let ttrAssets = null; // { citiesById, routesById, trainColors } — статика карты, грузим один раз
  let ttrAssetsPromise = null;
  let ttrPaymentState = null; // { routeId, payment: {color: n} } — открытая панель оплаты маршрута
  let ttrTunnelRouteId = null; // routeId текущего pendingTunnel — чтобы не сбрасывать черновик доплаты зря
  let ttrTunnelDraft = {};
  // сразу после ответа emit('claim-route', ...) на туннельный маршрут — не
  // дожидаясь следующего broadcast view (иначе панель с вскрытыми картами
  // иногда не успевала бы показаться вовремя, а если доплата не нужна вовсе
  // — view.pendingTunnel никогда и не появится, сервер коммитит маршрут сразу)
  let ttrTunnelLocal = null; // { routeId, payment, revealed, extraNeeded, colorUsed, autoResolved }
  let ttrTicketPickerKey = null; // "from-to|from-to..." текущего показанного набора билетов
  let ttrTicketPickerSelected = new Set();
  let ttrSuggestedPath = null; // { idx, from, to, routeIds: Set<routeId> } — подсказка пути по клику на билет

  // сколько карт стоит СЛЕДУЮЩАЯ станция игрока — 1-я станция 1 карту,
  // 2-я — 2, 3-я — 3 (см. STATIONS_PER_PLAYER/buildStation в
  // server/games/ttr/index.js — держать в синхроне, если поменяется там)
  const TTR_STATIONS_PER_PLAYER = 3;
  function ttrNextStationCost(stationsLeft) {
    return TTR_STATIONS_PER_PLAYER + 1 - stationsLeft;
  }

  // граф "цены в картах" между городами — свои уже построенные/подключённые
  // станцией маршруты бесплатны (вес 0), чужой ЕЩЁ не подключённый маршрут —
  // не тупик, а проходим через постройку туда своей станции (вес — цена
  // следующей станции, те же "единицы карт", что и у обычных маршрутов),
  // если станций совсем не осталось — недоступен. Общий для расчёта путей
  // всех билетов разом (см. ttrFindBestPath ниже), веса от текущего view
  // не зависят от конкретной пары городов, поэтому строится один раз.
  function ttrBuildWeightedGraph(view) {
    const routeOwner = view.routeOwner || {};
    const myId = view.me?.id;
    const myLinkedRoutes = new Set((view.stationMarkers || []).filter(m => m.playerId === myId).map(m => m.routeId));
    const myStationsLeft = (view.ttrPlayers || []).find(p => p.id === myId)?.stationsLeft || 0;
    const stationCost = ttrNextStationCost(myStationsLeft);
    const adj = new Map(); // city -> [{to, routeId, weight}]
    Object.values(ttrAssets.routesById).forEach((r) => {
      const owner = routeOwner[r.id];
      const isMineOrLinked = owner === myId || myLinkedRoutes.has(r.id);
      let weight;
      if (isMineOrLinked) {
        weight = 0;
      } else if (owner) {
        if (myStationsLeft <= 0) return;
        weight = stationCost;
      } else {
        weight = r.length;
      }
      if (!adj.has(r.from)) adj.set(r.from, []);
      if (!adj.has(r.to)) adj.set(r.to, []);
      adj.get(r.from).push({ to: r.to, routeId: r.id, weight });
      adj.get(r.to).push({ to: r.from, routeId: r.id, weight });
    });
    return adj;
  }

  // Дейкстра от одного города до всех остальных по уже построенному графу —
  // городов мало (47), обычный перебор без кучи вполне достаточен
  function ttrDijkstraFrom(adj, startCity) {
    const dist = new Map([[startCity, 0]]);
    const cameFrom = new Map(); // city -> { prevCity, routeId }
    const visited = new Set();
    while (true) {
      let cur = null;
      let curDist = Infinity;
      for (const [city, d] of dist) {
        if (!visited.has(city) && d < curDist) { cur = city; curDist = d; }
      }
      if (cur === null) break;
      visited.add(cur);
      for (const { to, routeId, weight } of adj.get(cur) || []) {
        if (visited.has(to)) continue;
        const nd = curDist + weight;
        if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
          dist.set(to, nd);
          cameFrom.set(to, { prevCity: cur, routeId });
        }
      }
    }
    return { dist, cameFrom };
  }

  // восстанавливает путь (список routeId) из cameFrom, посчитанного
  // ttrDijkstraFrom(adj, fromCity) — null, если toCity недостижим
  function ttrExtractPath(cameFrom, fromCity, toCity) {
    if (fromCity === toCity) return [];
    if (!cameFrom.has(toCity)) return null;
    const path = [];
    let node = toCity;
    while (node !== fromCity) {
      const step = cameFrom.get(node);
      if (!step) return null;
      path.push(step.routeId);
      node = step.prevCity;
    }
    return path;
  }

  // путь для конкретного билета (fromCity/toCity), но выбранный с оглядкой
  // на ВСЮ сеть игрока — города этого билета плюс города всех уже
  // ОСТАВЛЕННЫХ билетов ("Мои билеты"; ещё не подтверждённые кандидаты в
  // пикере не считаются — от них можно отказаться) — целиком, а не только
  // двух городов текущего билета по отдельности. Так общие участки пути,
  // нужные сразу нескольким билетам, не считаются/не строятся дважды: это
  // 2-аппроксимация дерева Штейнера (кратчайшие пути между всеми парами
  // терминалов -> MST по этим расстояниям -> объединение путей вдоль рёбер
  // MST), стандартный приём для таких задач, а не полный (NP-полный) перебор.
  // Подсвечивается на карте по-прежнему только путь ЭТОГО билета — общая
  // сеть тут только влияет на то, ЧЕРЕЗ какие маршруты он выгоднее пройдёт.
  // Возвращает список routeId или null, если соперники перекрыли все
  // варианты (в т.ч. станций больше нет).
  function ttrFindBestPath(view, fromCity, toCity) {
    const adj = ttrBuildWeightedGraph(view);

    const terminals = new Set([fromCity, toCity]);
    (view.myTickets || []).forEach((t) => { terminals.add(t.from); terminals.add(t.to); });

    // билет — единственный в сети (нет других оставленных, или оба города
    // совпали с ним же) — дерево Штейнера с двумя терминалами это и есть
    // обычный кратчайший путь, без лишней работы
    if (terminals.size <= 2) {
      return ttrExtractPath(ttrDijkstraFrom(adj, fromCity).cameFrom, fromCity, toCity);
    }

    const terminalList = [...terminals];
    const dijkstraByTerminal = new Map(terminalList.map((t) => [t, ttrDijkstraFrom(adj, t)]));

    // Prim: растим дерево на терминалах, каждый раз добавляя ближайший
    // ещё не подключённый терминал по уже посчитанным расстояниям
    const inTree = new Set([terminalList[0]]);
    const treeRouteIds = new Set();
    while (inTree.size < terminalList.length) {
      let best = null; // { from, to, dist }
      for (const a of inTree) {
        const { dist } = dijkstraByTerminal.get(a);
        for (const b of terminalList) {
          if (inTree.has(b)) continue;
          const d = dist.has(b) ? dist.get(b) : Infinity;
          if (d < Infinity && (!best || d < best.dist)) best = { from: a, to: b, dist: d };
        }
      }
      if (!best) break; // остальные терминалы недостижимы (перекрыты соперниками) — не страшно, ниже есть подстраховка
      inTree.add(best.to);
      const path = ttrExtractPath(dijkstraByTerminal.get(best.from).cameFrom, best.from, best.to);
      if (path) path.forEach((id) => treeRouteIds.add(id));
    }

    // путь между fromCity/toCity ВНУТРИ уже собранной общей сети — те же
    // веса, что и в основном графе (берём их оттуда, а не пересчитываем)
    const treeAdj = new Map();
    treeRouteIds.forEach((routeId) => {
      const r = ttrAssets.routesById[routeId];
      const fromEdges = adj.get(r.from) || [];
      const weight = (fromEdges.find((e) => e.routeId === routeId) || {}).weight ?? r.length;
      if (!treeAdj.has(r.from)) treeAdj.set(r.from, []);
      if (!treeAdj.has(r.to)) treeAdj.set(r.to, []);
      treeAdj.get(r.from).push({ to: r.to, routeId, weight });
      treeAdj.get(r.to).push({ to: r.from, routeId, weight });
    });
    const treePath = ttrExtractPath(ttrDijkstraFrom(treeAdj, fromCity).cameFrom, fromCity, toCity);
    if (treePath) return treePath;

    // подстраховка: если общая сеть почему-то не связала именно эту пару
    // (например, редкий случай недостижимости где-то ещё в дереве) —
    // обычный прямой путь без оглядки на остальные билеты
    return ttrExtractPath(ttrDijkstraFrom(adj, fromCity).cameFrom, fromCity, toCity);
  }

  function loadTtrAssets() {
    if (!ttrAssetsPromise) {
      ttrAssetsPromise = Promise.all([
        fetch('/api/ttr/map').then(r => r.json()),
        fetch('/ttr/ttr-map-new-new.svg').then(r => r.text()),
      ]).then(([mapData, svgText]) => {
        const citiesById = {};
        mapData.cities.forEach(c => { citiesById[c.id] = c; });
        const routesById = {};
        mapData.routes.forEach(r => { routesById[r.id] = r; });
        ttrAssets = { citiesById, routesById, trainColors: mapData.trainColors, svgText };
      }).catch((err) => {
        // не запоминаем неудачную попытку как окончательную — иначе при
        // следующем вызове (следующий room-update) отдавался бы тот же
        // самый уже отклонённый promise, и карта не загрузилась бы больше
        // никогда за всё время открытой вкладки, даже если сеть на
        // мгновение моргнула и уже восстановилась (это и было причиной
        // "иногда карта просто вечно висит на загрузке")
        ttrAssetsPromise = null;
        throw err;
      });
    }
    return ttrAssetsPromise;
  }

  function ttrCanAct(view) {
    return view.currentPlayerId === view.me?.id
      && (view.phase === 'playing' || view.phase === 'final-round')
      && !view.pendingTunnel
      && !view.myPendingTickets;
  }

  // --- пан/зум карты: единый transform (translate+scale) на <svg>, без
  // нативного скролла контейнера. Один и тот же стейт двигают четыре
  // источника — колесо мыши (зум к курсору), pointer-события (мышь-драг
  // и палец: один палец — пан, два — pinch-zoom, Pointer Events одинаково
  // стреляют для мыши/тача/стилуса, поэтому код общий), стрелки на
  // клавиатуре и кнопки +/-/сброс. clampTtrPan() после каждого изменения
  // не даёт утащить карту за край контейнера (см. ниже).
  let ttrZoom = 1;
  let ttrPanX = 0;
  let ttrPanY = 0;
  let ttrContW = 0;
  let ttrContH = 0;
  const TTR_ZOOM_MIN = 1;
  const TTR_ZOOM_MAX = 5;
  const TTR_WHEEL_ZOOM_FACTOR = 1.15;
  const TTR_KEY_PAN_STEP = 80;
  const TTR_DRAG_CLICK_THRESHOLD = 6;

  function ttrMapSvg() {
    return $('#ttr-map-container svg');
  }

  // контейнер задаёт фиксированный размер, SVG рисуется ровно в этот
  // размер (preserveAspectRatio="xMidYMid meet" — вся карта видна целиком,
  // при несовпадении пропорций остаются белые поля по бокам, сливающиеся
  // с фоном). Раз внешний бокс SVG всегда равен размеру контейнера, формула
  // ограничения панорамы в clampTtrPan остаётся простой независимо от
  // того, что внутри — обрезки самой карты при этом никогда не будет.
  function ttrRefitMapSize() {
    const container = $('#ttr-map-container');
    const svg = ttrMapSvg();
    if (!container || !svg) return;
    ttrContW = container.clientWidth;
    ttrContH = container.clientHeight;
    svg.style.width = `${ttrContW}px`;
    svg.style.height = `${ttrContH}px`;
    clampTtrPan();
    applyTtrTransform();
  }

  // не даёт карте уехать за пределы контейнера ни при каком zoom: край
  // карты не может зайти за границу контейнера и обнажить пустоту
  function clampTtrPan() {
    const minPanX = Math.min(0, ttrContW - ttrContW * ttrZoom);
    const minPanY = Math.min(0, ttrContH - ttrContH * ttrZoom);
    ttrPanX = Math.max(minPanX, Math.min(0, ttrPanX));
    ttrPanY = Math.max(minPanY, Math.min(0, ttrPanY));
  }

  function applyTtrTransform() {
    const svg = ttrMapSvg();
    if (svg) svg.style.transform = `translate(${ttrPanX}px, ${ttrPanY}px) scale(${ttrZoom})`;
  }

  // меняет zoom так, чтобы точка карты под anchorX/anchorY (курсор или
  // середина между двумя пальцами) осталась под ним же — иначе зум "от
  // угла" ощущается дёрганым
  function ttrZoomAt(anchorX, anchorY, newZoom) {
    newZoom = Math.max(TTR_ZOOM_MIN, Math.min(TTR_ZOOM_MAX, newZoom));
    if (newZoom === ttrZoom) return;
    const contentX = (anchorX - ttrPanX) / ttrZoom;
    const contentY = (anchorY - ttrPanY) / ttrZoom;
    ttrZoom = newZoom;
    ttrPanX = anchorX - contentX * ttrZoom;
    ttrPanY = anchorY - contentY * ttrZoom;
    clampTtrPan();
    applyTtrTransform();
  }

  function resetTtrZoom() {
    ttrZoom = 1;
    ttrPanX = 0;
    ttrPanY = 0;
    applyTtrTransform();
  }

  // подгоняет пан/зум так, чтобы все переданные города гарантированно
  // попали в кадр — используется при просмотре билета в пикере, чтобы
  // подсвеченный маршрут не оказался за пределами текущего вида карты
  // (если она до этого была приближена/сдвинута куда-то ещё). padding —
  // в единицах viewBox (14472×11804), даёт немного места вокруг городов,
  // а не впритык по их точкам.
  function ttrFitToCities(cityIds, { padding = 900 } = {}) {
    if (!ttrContW || !ttrContH) return;
    const pts = cityIds.map(id => ttrAssets.citiesById[id]).filter(Boolean);
    if (!pts.length) return;
    const VIEWBOX_W = 14472;
    // контейнер держит aspect-ratio: 14472/11804 (см. .ttr-map-container в
    // CSS), так что масштаб viewBox->CSS-пиксели один и тот же по обеим осям
    const s = ttrContW / VIEWBOX_W;
    const minX = Math.min(...pts.map(p => p.x)) - padding;
    const maxX = Math.max(...pts.map(p => p.x)) + padding;
    const minY = Math.min(...pts.map(p => p.y)) - padding;
    const maxY = Math.max(...pts.map(p => p.y)) + padding;
    const boxW = (maxX - minX) * s;
    const boxH = (maxY - minY) * s;
    const fitZoom = Math.min(ttrContW / boxW, ttrContH / boxH);
    ttrZoom = Math.max(TTR_ZOOM_MIN, Math.min(TTR_ZOOM_MAX, fitZoom));
    const centerX = ((minX + maxX) / 2) * s;
    const centerY = ((minY + maxY) / 2) * s;
    ttrPanX = ttrContW / 2 - centerX * ttrZoom;
    ttrPanY = ttrContH / 2 - centerY * ttrZoom;
    clampTtrPan();
    applyTtrTransform();
  }

  function mountTtrMap() {
    const container = $('#ttr-map-container');
    container.innerHTML = ttrAssets.svgText;
    const svg = container.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      // "meet" (не "slice"): контейнер сильно шире по пропорциям, чем
      // карта — при slice/cover лишнее по высоте обрезалось бы навсегда
      // (юг Италии/Палермо просто никогда не попадал бы в кадр ни при
      // каком zoom, т.к. зум только увеличивает уже обрезанный кусок).
      // meet показывает карту целиком с белыми полями по бокам (сливаются
      // с белым фоном контейнера) — жертвуем немного эстетикой ради того,
      // чтобы вся карта была реально достижима.
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      buildTtrOwnerGradients(svg);
    }
    resetTtrZoom();
    ttrRefitMapSize();
    closeTtrPayment();
  }

  function renderTtrGame(view, freshStart) {
    loadTtrAssets().then(() => {
      // комната могла уйти на другой экран, пока грузилась карта — не рисуем в пустоту
      if (state.lastView !== view) return;
      if (freshStart) mountTtrMap();
      renderTtrRoster(view);
      paintTtrRoutes(view);
      paintTtrStationMarks(view);
      renderTtrHand(view);
      renderTtrDeckFaceUp(view);
      renderTtrTickets(view);
      renderTtrTicketPicker(view);
      renderTtrPaymentPanel(view);
      renderTtrTunnelPanel(view);
    }).catch((err) => {
      console.error('Не удалось загрузить карту TTR, повтор через 2с', err);
      if (state.lastView !== view) return;
      const container = $('#ttr-map-container');
      if (container) container.innerHTML = '<p class="hint-text">Не удалось загрузить карту, повторная попытка…</p>';
      setTimeout(() => { if (state.lastView === view) renderTtrGame(view, freshStart); }, 2000);
    });
  }

  function renderTtrRoster(view) {
    $('#btn-force-end-game-ttr').hidden = !view.canForceEnd;
    const players = view.ttrPlayers || [];
    const roomPlayers = view.players || [];
    $('#ttr-roster-row').innerHTML = players.map((p) => {
      const roomP = roomPlayers.find(rp => rp.id === p.id);
      const offline = roomP && !roomP.connected;
      const isTurn = p.id === view.currentPlayerId;
      const hex = TTR_PLAYER_HEX[p.color] || '#999';
      return `
        <span class="roster-chip ttr-roster-chip ${offline ? 'offline' : ''} ${isTurn ? 'ttr-turn' : ''}">
          <span class="dot" style="background:${hex}"></span>${escapeHtml(p.name)}${offline ? ' (офлайн)' : ''}
          ${p.id === view.me?.id ? '<span class="player-tag-you">вы</span>' : ''}
          <span class="ttr-roster-stats">🚃<b style="color:${hex}">${p.trainsLeft}</b> · 🚉${p.stationsLeft} · 🏆${p.score}</span>
        </span>
      `;
    }).join('');

    // зрители не входят в ttrPlayers (это отдельный, чисто игровой список,
    // см. TicketToRideGame.viewFor) — берём их из общего room-level списка
    const spectators = roomPlayers.filter(p => p.role === 'spectator');
    const spectatorsRow = $('#ttr-spectators-row');
    spectatorsRow.hidden = !spectators.length;
    if (spectators.length) spectatorsRow.textContent = `👁 Зрители: ${spectators.map(p => p.name).join(', ')}`;

    const turnPlayer = players.find(p => p.id === view.currentPlayerId);
    const indicator = $('#ttr-turn-indicator');
    // сам я — зритель (не в ttrPlayers вообще) — отдельная приписка спереди,
    // остальной текст (чей сейчас ход) остаётся как есть, он всем полезен
    const spectatorPrefix = view.me?.role === 'spectator' ? '👁 Вы наблюдаете · ' : '';
    if (view.pendingTunnel) {
      indicator.textContent = spectatorPrefix + ((view.pendingTunnel.playerId === view.me?.id) ? 'Решите судьбу туннеля' : 'Соперник решает судьбу туннеля');
    } else if (view.myPendingTickets) {
      indicator.textContent = spectatorPrefix + 'Выберите билеты';
    } else if (turnPlayer) {
      indicator.textContent = spectatorPrefix + ((turnPlayer.id === view.me?.id) ? 'Ваш ход' : `Ход: ${turnPlayer.name}`);
    } else {
      indicator.textContent = spectatorPrefix;
    }
  }

  function paintRouteShapes(routeEl, colorName) {
    const hex = TTR_PLAYER_HEX[colorName] || '#999';
    const shapes = /^(rect|path|polygon|circle)$/i.test(routeEl.tagName) ? [routeEl] : routeEl.querySelectorAll('rect, path, polygon, circle');
    shapes.forEach((s) => {
      s.setAttribute('fill', colorName ? `url(#ttr-owner-grad-${colorName})` : hex);
      s.setAttribute('fill-opacity', '1');
      s.setAttribute('stroke', ttrShade(hex, -45));
      s.setAttribute('stroke-width', '14');
    });
  }

  function paintTtrRoutes(view) {
    const container = $('#ttr-map-container');
    const canAct = ttrCanAct(view);
    const myId = view.me?.id;
    const myStationsLeft = (view.ttrPlayers || []).find(p => p.id === myId)?.stationsLeft || 0;
    const myLinkedRoutes = new Set((view.stationMarkers || []).filter(m => m.playerId === myId).map(m => m.routeId));
    Object.keys(ttrAssets.routesById).forEach((routeId) => {
      const el = container.querySelector('#' + routeId);
      if (!el) return;
      const ownerId = view.routeOwner[routeId];
      el.classList.remove('ttr-claimable', 'ttr-selected', 'ttr-suggested-mine', 'ttr-suggested-needed');
      if (ttrSuggestedPath && ttrSuggestedPath.routeIds.has(routeId)) {
        // уже мой (построен или подключён станцией) кусок пути — зелёным,
        // ещё не построенный — обычным цветом подсказки; чтобы игрок видел,
        // что из маршрута уже готово, а что ещё предстоит построить
        const isMine = ownerId === myId || myLinkedRoutes.has(routeId);
        el.classList.add(isMine ? 'ttr-suggested-mine' : 'ttr-suggested-needed');
      }
      if (ttrPaymentState && ttrPaymentState.routeId === routeId) el.classList.add('ttr-selected');
      if (ownerId) {
        const player = (view.ttrPlayers || []).find(p => p.id === ownerId);
        paintRouteShapes(el, player?.color);
        // чужой маршрут, ещё можно поставить сюда станцию — тоже кликабелен
        if (canAct && ownerId !== myId && myStationsLeft > 0 && !myLinkedRoutes.has(routeId)) {
          el.classList.add('ttr-claimable');
        }
      } else if (canAct) {
        el.classList.add('ttr-claimable');
      }
    });
  }

  // чёрточка-«переезд» поперёк маршрута в цвет игрока — станция, поставленная
  // на этот (чужой) маршрут. Середина и угол считаются от координат городов
  // (они уже есть в данных карты), не от геометрии самих SVG-кусочков —
  // проще и для прямых/почти прямых маршрутов даёт то же самое визуально
  function paintTtrStationMarks(view) {
    const svg = $('#ttr-map-container svg');
    if (!svg) return;
    svg.querySelectorAll('.ttr-station-mark').forEach((el) => el.remove());

    const svgNS = 'http://www.w3.org/2000/svg';
    const byRoute = new Map();
    (view.stationMarkers || []).forEach((m) => {
      if (!byRoute.has(m.routeId)) byRoute.set(m.routeId, []);
      byRoute.get(m.routeId).push(m.playerId);
    });

    byRoute.forEach((playerIds, routeId) => {
      const route = ttrAssets.routesById[routeId];
      const from = route && ttrAssets.citiesById[route.from];
      const to = route && ttrAssets.citiesById[route.to];
      if (!from || !to) return;
      // центр — из реальной отрисованной геометрии ЭТОЙ КОНКРЕТНОЙ полосы
      // маршрута (getBBox), а не усреднённо по координатам городов: на
      // маршрутах с двумя параллельными "дорожками" между одними и теми же
      // городами (variant 1/2, напр. route_berlin_warszawa_1/_2) середина
      // по городам одна и та же для обеих дорожек, хотя визуально они
      // разнесены — метка станции "уезжала" в промежуток между дорожками
      // вместо той, на которой реально построена станция
      const routeEl = svg.querySelector('#' + routeId);
      const bbox = routeEl ? routeEl.getBBox() : null;
      const midX = bbox ? bbox.x + bbox.width / 2 : (from.x + to.x) / 2;
      const midY = bbox ? bbox.y + bbox.height / 2 : (from.y + to.y) / 2;
      const angleRad = Math.atan2(to.y - from.y, to.x - from.x);
      const angleDeg = (angleRad * 180) / Math.PI;
      const spacing = 140; // если станций на одном пути несколько — раздвигаем вдоль него
      playerIds.forEach((playerId, i) => {
        const offset = (i - (playerIds.length - 1) / 2) * spacing;
        const cx = midX + Math.cos(angleRad) * offset;
        const cy = midY + Math.sin(angleRad) * offset;
        const player = (view.ttrPlayers || []).find((p) => p.id === playerId);
        const hex = TTR_PLAYER_HEX[player?.color] || '#fff';
        const half = 100;
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', cx - half);
        line.setAttribute('y1', cy);
        line.setAttribute('x2', cx + half);
        line.setAttribute('y2', cy);
        line.setAttribute('transform', `rotate(${angleDeg + 90} ${cx} ${cy})`);
        line.setAttribute('stroke', hex);
        line.setAttribute('stroke-width', '45');
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('class', 'ttr-station-mark');
        svg.appendChild(line);
      });
    });
  }

  function onTtrRouteClick(routeId) {
    const view = state.lastView;
    if (!view || !ttrAssets) return;
    if (!ttrCanAct(view)) return;
    const route = ttrAssets.routesById[routeId];
    if (!route) return;
    const ownerId = view.routeOwner[routeId];
    const myId = view.me?.id;

    if (!ownerId) {
      ttrPaymentState = { kind: 'route', routeId: route.id, payment: {} };
      renderTtrPaymentPanel(view);
      paintTtrRoutes(view);
      return;
    }

    // занятый маршрут — свой трогать нечего, чужой можно попробовать
    // "подключить" станцией (см. buildStation на сервере)
    if (ownerId === myId) return;
    const myStationsLeft = (view.ttrPlayers || []).find(p => p.id === myId)?.stationsLeft || 0;
    if (myStationsLeft <= 0) { alert('Станции закончились.'); return; }
    const alreadyLinked = (view.stationMarkers || []).some(m => m.routeId === routeId && m.playerId === myId);
    if (alreadyLinked) return; // тут уже стоит моя станция — второй раз незачем

    ttrPaymentState = { kind: 'station', routeId: route.id, payment: {} };
    renderTtrPaymentPanel(view);
    paintTtrRoutes(view);
  }

  // общий стиль для .ttr-card — картинка карты (если для цвета есть файл)
  // поверх hex-фолбэка (на случай, если картинка не найдётся/не прогрузится)
  function ttrCardBgStyle(color) {
    const hex = TTR_CARD_HEX[color] || '#999';
    const img = TTR_CARD_IMAGE[color];
    return `--ttr-card-color:${hex};${img ? `background-image:url(/ttr/cards/${img});` : ''}`;
  }

  function ttrCardTile(color, count) {
    return `<span class="ttr-card" style="${ttrCardBgStyle(color)}" title="${TTR_CARD_LABELS[color] || color}">${count != null ? `<b>${count}</b>` : ''}</span>`;
  }

  function renderTtrHand(view) {
    const hand = view.myHand || {};
    const order = [...(ttrAssets.trainColors || []), 'locomotive'];
    const html = order.filter(c => (hand[c] || 0) > 0).map(c => ttrCardTile(c, hand[c])).join('');
    $('#ttr-hand').innerHTML = html || '<p class="hint-text">Рука пуста</p>';
  }

  function renderTtrDeckFaceUp(view) {
    $('#ttr-deck-count').textContent = view.deckCount;
    const canAct = ttrCanAct(view);
    $('#ttr-draw-deck').disabled = !canAct;
    $('#ttr-faceup-row').innerHTML = (view.faceUp || []).map((color, idx) => `
      <button type="button" class="ttr-card ttr-faceup-btn" data-idx="${idx}" style="${ttrCardBgStyle(color)}" title="${TTR_CARD_LABELS[color] || color}" ${canAct ? '' : 'disabled'}></button>
    `).join('');
  }

  function ttrPaymentTile(color, used, have, max) {
    const label = TTR_CARD_LABELS[color] || color;
    return `
      <div class="ttr-payment-tile">
        <span class="ttr-card" style="${ttrCardBgStyle(color)}"></span>
        <span class="ttr-payment-label">${label}<br><span class="hint-text">есть: ${have}</span></span>
        <div class="ttr-stepper">
          <button type="button" class="ttr-step-minus" data-color="${color}" ${used <= 0 ? 'disabled' : ''}>−</button>
          <b>${used}</b>
          <button type="button" class="ttr-step-plus" data-color="${color}" ${used >= max ? 'disabled' : ''}>+</button>
        </div>
      </div>
    `;
  }

  function closeTtrPayment() {
    ttrPaymentState = null;
    $('#ttr-payment-panel').hidden = true;
    if (state.lastView) paintTtrRoutes(state.lastView);
  }

  function renderTtrPaymentPanel(view) {
    const panel = $('#ttr-payment-panel');
    if (!ttrPaymentState) { panel.hidden = true; return; }
    if (ttrPaymentState.kind === 'station') { renderTtrStationPaymentPanel(view); return; }
    // маршрут мог быть занят кем-то другим, пока была открыта панель
    if (view.routeOwner[ttrPaymentState.routeId]) { closeTtrPayment(); return; }
    const route = ttrAssets.routesById[ttrPaymentState.routeId];
    if (!route) { closeTtrPayment(); return; }
    panel.hidden = false;

    const hand = view.myHand || {};
    const payment = ttrPaymentState.payment;
    const chosenColor = Object.keys(payment).find(c => c !== 'locomotive' && payment[c] > 0);
    const allowedColors = route.color === 'gray' ? (ttrAssets.trainColors || []) : [route.color];

    const fromCity = ttrAssets.citiesById[route.from]?.name || route.from;
    const toCity = ttrAssets.citiesById[route.to]?.name || route.to;
    $('#ttr-payment-title').textContent = `${fromCity} — ${toCity} (${route.length})`;

    const total = Object.values(payment).reduce((a, b) => a + b, 0);
    const locoCount = payment.locomotive || 0;

    const tiles = [];
    allowedColors.forEach((color) => {
      if (chosenColor && color !== chosenColor) return;
      const have = hand[color] || 0;
      const used = payment[color] || 0;
      const max = Math.min(have, route.length - (total - used));
      tiles.push(ttrPaymentTile(color, used, have, max));
    });
    const locoHave = hand.locomotive || 0;
    const locoMax = Math.min(locoHave, route.length - (total - locoCount));
    tiles.push(ttrPaymentTile('locomotive', locoCount, locoHave, locoMax));
    $('#ttr-payment-cards').innerHTML = tiles.join('');

    let statusText = `Выбрано ${total} из ${route.length}`;
    if (route.ferry) statusText += ` · паром: нужно минимум ${route.ferry} локомотив(ов)`;
    $('#ttr-payment-status').textContent = statusText;

    $('#btn-ttr-payment-confirm').disabled = !(total === route.length && locoCount >= (route.ferry || 0));
  }

  // станция ставится на уже занятый ЧУЖОЙ маршрут — любым одним цветом
  // (нет привязки к цвету самого маршрута, в отличие от обычной постройки),
  // стоимость растёт с каждой следующей станцией (1/2/3)
  function renderTtrStationPaymentPanel(view) {
    const panel = $('#ttr-payment-panel');
    const route = ttrAssets.routesById[ttrPaymentState.routeId];
    const ownerId = view.routeOwner[ttrPaymentState.routeId];
    const myId = view.me?.id;
    if (!route || !ownerId || ownerId === myId) { closeTtrPayment(); return; }
    panel.hidden = false;

    const me = (view.ttrPlayers || []).find(p => p.id === myId);
    const cost = 4 - (me?.stationsLeft ?? 0); // 3 осталось -> 1-я станция стоит 1, и т.д.
    const hand = view.myHand || {};
    const payment = ttrPaymentState.payment;
    const chosenColor = Object.keys(payment).find(c => c !== 'locomotive' && payment[c] > 0);
    const total = Object.values(payment).reduce((a, b) => a + b, 0);
    const locoCount = payment.locomotive || 0;

    const fromCity = ttrAssets.citiesById[route.from]?.name || route.from;
    const toCity = ttrAssets.citiesById[route.to]?.name || route.to;
    $('#ttr-payment-title').textContent = `Станция: ${fromCity} — ${toCity}`;

    const tiles = [];
    (ttrAssets.trainColors || []).forEach((color) => {
      if (chosenColor && color !== chosenColor) return;
      const have = hand[color] || 0;
      const used = payment[color] || 0;
      const max = Math.min(have, cost - (total - used));
      tiles.push(ttrPaymentTile(color, used, have, max));
    });
    const locoHave = hand.locomotive || 0;
    const locoMax = Math.min(locoHave, cost - (total - locoCount));
    tiles.push(ttrPaymentTile('locomotive', locoCount, locoHave, locoMax));
    $('#ttr-payment-cards').innerHTML = tiles.join('');

    $('#ttr-payment-status').textContent = `Станция №${cost} из 3 · выбрано ${total} из ${cost}`;
    $('#btn-ttr-payment-confirm').disabled = total !== cost;
  }

  function renderTtrTunnelPanel(view) {
    const panel = $('#ttr-tunnel-panel');
    // view.pendingTunnel — канонический источник (сервер), но между ack
    // на claim-route и следующим broadcast'ом view проходит время, и если
    // доплата вообще не нужна (autoResolved) — pendingTunnel на сервере
    // никогда и не появляется. ttrTunnelLocal ставится сразу из ответа
    // claim-route и служит запасным/единственным источником для этих
    // случаев, view.pendingTunnel просто перебивает его, когда придёт.
    const pending = view.pendingTunnel
      || (ttrTunnelLocal && !ttrTunnelLocal.autoResolved ? ttrTunnelLocal : null);
    const autoInfo = !view.pendingTunnel && ttrTunnelLocal && ttrTunnelLocal.autoResolved ? ttrTunnelLocal : null;

    if (!pending && !autoInfo) { panel.hidden = true; ttrTunnelRouteId = null; return; }
    panel.hidden = false;

    const revealed = (pending || autoInfo).revealed;
    $('#ttr-tunnel-revealed').innerHTML = revealed.map(c => ttrCardTile(c)).join('');

    if (autoInfo) {
      $('#ttr-tunnel-text').textContent = 'Доплата не понадобилась — маршрут построен!';
      $('#ttr-tunnel-cards').innerHTML = '';
      $('#btn-ttr-tunnel-pay').hidden = true;
      $('#btn-ttr-tunnel-decline').hidden = true;
      $('#btn-ttr-tunnel-ok').hidden = false;
      return;
    }
    $('#btn-ttr-tunnel-pay').hidden = false;
    $('#btn-ttr-tunnel-decline').hidden = false;
    $('#btn-ttr-tunnel-ok').hidden = true;

    if (ttrTunnelRouteId !== pending.routeId) {
      ttrTunnelRouteId = pending.routeId;
      ttrTunnelDraft = {};
    }

    $('#ttr-tunnel-text').innerHTML = `Нужно доплатить ${pending.extraNeeded} карт(ы) цвета <b>${TTR_CARD_LABELS[pending.colorUsed] || pending.colorUsed}</b> (или локомотивами), либо отказаться от маршрута.`;

    const hand = view.myHand || {};
    // карты, уже потраченные на первоначальную оплату самого маршрута
    // (pending.payment), больше не "доступны" для доплаты — в хэнде на
    // сервере они пока физически лежат (спишутся только при коммите), но
    // показывать и разрешать выбирать их второй раз для доплаты нельзя
    const alreadySpent = pending.payment || {};
    const total = Object.values(ttrTunnelDraft).reduce((a, b) => a + b, 0);
    const locoCount = ttrTunnelDraft.locomotive || 0;

    const tiles = [];
    if (pending.colorUsed !== 'locomotive') {
      const colorCount = ttrTunnelDraft[pending.colorUsed] || 0;
      const colorHave = Math.max(0, (hand[pending.colorUsed] || 0) - (alreadySpent[pending.colorUsed] || 0));
      tiles.push(ttrPaymentTile(pending.colorUsed, colorCount, colorHave, Math.min(colorHave, pending.extraNeeded - (total - colorCount))));
    }
    const locoHave = Math.max(0, (hand.locomotive || 0) - (alreadySpent.locomotive || 0));
    tiles.push(ttrPaymentTile('locomotive', locoCount, locoHave, Math.min(locoHave, pending.extraNeeded - (total - locoCount))));
    $('#ttr-tunnel-cards').innerHTML = tiles.join('');

    $('#btn-ttr-tunnel-pay').disabled = total !== pending.extraNeeded;
  }

  // карточка билета — реальная картинка (город-город-очки уже нарисованы
  // на самой карточке), а не текстовая строка; short/long — разные папки
  // и слегка разные пропорции исходников (см. .ttr-ticket-short/-long)
  function ttrTicketImagePath(t) {
    return `/ttr/tickets/${t.long ? 'long' : 'short'}/${t.from.toUpperCase()}-${t.to.toUpperCase()}.png`;
  }

  function ttrTicketTitle(t) {
    const from = ttrAssets.citiesById[t.from]?.name || t.from;
    const to = ttrAssets.citiesById[t.to]?.name || t.to;
    return `${from} → ${to} (${t.points})`;
  }

  function ttrTicketRow(t, idx) {
    const isActive = ttrSuggestedPath && ttrSuggestedPath.source === 'owned' && ttrSuggestedPath.idx === idx;
    const cls = `ttr-ticket-row ttr-ticket-card ${t.long ? 'ttr-ticket-long' : 'ttr-ticket-short'}${t.fulfilled ? ' ttr-ticket-fulfilled' : ''}${isActive ? ' ttr-ticket-active' : ''}`;
    return `<div class="${cls}" data-idx="${idx}" data-from="${t.from}" data-to="${t.to}" style="background-image:url(${ttrTicketImagePath(t)})" title="${escapeHtml(ttrTicketTitle(t))}"></div>`;
  }

  function renderTtrTickets(view) {
    const tickets = view.myTickets || [];
    $('#ttr-tickets-list').innerHTML = tickets.length
      ? tickets.map((t, idx) => ttrTicketRow(t, idx)).join('')
      : '<p class="hint-text">Пока нет билетов</p>';
    $('#btn-ttr-draw-tickets').disabled = !ttrCanAct(view);
  }

  // гасит подсказку пути на карте, если она сейчас от пикера билетов
  // (а не от клика по «Мои билеты» — те независимы, см. source). Красит
  // маршруты заново сама — вызывается уже ПОСЛЕ paintTtrRoutes() в общем
  // рендер-проходе (см. renderTtrGame), иначе подсветка пути зависала бы
  // на карте до следующего обновления view
  function ttrClearPickerSuggestion(view) {
    if (ttrSuggestedPath && ttrSuggestedPath.source === 'picker') {
      ttrHighlightCities(ttrSuggestedPath.from, ttrSuggestedPath.to, false);
      ttrSuggestedPath = null;
      if (view) paintTtrRoutes(view);
    }
  }

  function renderTtrTicketPicker(view) {
    const dock = $('#ttr-ticket-picker');
    const gamePanel = $('#ttr-panel');
    const heading = dock.querySelector('h3');
    const confirmBtn = $('#btn-ttr-confirm-tickets');
    const pending = view.myPendingTickets;

    if (pending) {
      dock.hidden = false;
      gamePanel.hidden = true;
      heading.textContent = 'Выберите билеты';
      confirmBtn.hidden = false;
      const key = pending.map(t => `${t.from}-${t.to}`).join('|');
      if (ttrTicketPickerKey !== key) {
        ttrTicketPickerKey = key;
        // по умолчанию оставляем все — игрок сам снимает лишние выше минимума
        ttrTicketPickerSelected = new Set(pending.map((_, i) => i));
        ttrClearPickerSuggestion(view);
      }
      $('#ttr-ticket-picker-hint').textContent = `Оставьте минимум ${view.myPendingTicketsMinKeep || 1} из ${pending.length}. Клик по картинке — посмотреть маршрут на карте, галочка в углу — оставить/отклонить билет.`;
      $('#ttr-ticket-picker-list').innerHTML = pending.map((t, i) => {
        const selected = ttrTicketPickerSelected.has(i);
        // клик по картинке карточки — только просмотр маршрута на карте,
        // саму карточку никак не подсвечивает; единственный сигнал на
        // карточке — зелёная подсветка при выборе (галочка + вся карточка)
        const cls = `ttr-ticket-pick ttr-ticket-card ${t.long ? 'ttr-ticket-long' : 'ttr-ticket-short'}${selected ? ' selected' : ''}`;
        const toggleTitle = selected ? 'Не оставлять этот билет' : 'Оставить этот билет';
        return `
          <div class="${cls}" data-idx="${i}">
            <button type="button" class="ttr-ticket-pick-preview" style="background-image:url(${ttrTicketImagePath(t)})" title="${escapeHtml(ttrTicketTitle(t))}"></button>
            <button type="button" class="ttr-ticket-pick-toggle${selected ? ' selected' : ''}" title="${toggleTitle}">${selected ? '✓' : ''}</button>
          </div>
        `;
      }).join('');
      confirmBtn.disabled = ttrTicketPickerSelected.size < (view.myPendingTicketsMinKeep || 1);
      return;
    }

    ttrTicketPickerKey = null;
    ttrClearPickerSuggestion(view);
    // фаза initial-tickets общая на всех — пока хоть кто-то не выбрал,
    // партия не переходит в 'playing'; сам я мог уже выбрать и жду других,
    // показываем это явно, а не тихо распахиваем игровое поле
    if (view.phase !== 'initial-tickets') { dock.hidden = true; gamePanel.hidden = false; return; }

    dock.hidden = false;
    gamePanel.hidden = true;
    heading.textContent = 'Ожидание';
    confirmBtn.hidden = true;
    const waitingNames = (view.awaitingInitialTickets || [])
      .map(id => (view.ttrPlayers || []).find(p => p.id === id)?.name || '?');
    $('#ttr-ticket-picker-hint').textContent = waitingNames.length
      ? `Ждём выбор билетов: ${waitingNames.join(', ')}`
      : 'Все выбрали — игра вот-вот начнётся…';
    $('#ttr-ticket-picker-list').innerHTML = '';
  }

  function renderTtrFinishedScores(view) {
    const players = [...(view.ttrPlayers || [])].sort((a, b) => b.score - a.score);
    const rows = players.map(p => `
      <tr class="${p.id === view.winner ? 'ttr-winner-row' : ''}">
        <td><span class="dot" style="background:${TTR_PLAYER_HEX[p.color] || '#999'}"></span> ${escapeHtml(p.name)}</td>
        <td>${p.score}</td>
      </tr>
    `).join('');
    $('#ttr-finished-scores').innerHTML = `<thead><tr><th>Игрок</th><th>Очки</th></tr></thead><tbody>${rows}</tbody>`;

    // разбивку очков показываем только для себя — подробности чужих очков
    // за столом обычно не нужны, а список на всех игроков раздувал экран
    const me = players.find(p => p.id === view.me?.id);
    const log = me ? [...(me.scoreLog || [])].sort((a, b) => a.ts - b.ts) : [];
    const items = log.map((e) => {
      const pts = e.points >= 0 ? `+${e.points}` : `${e.points}`;
      // "маршрут"/"билет" — есть конкретное место на карте, кликабельны
      // (см. обработчик #ttr-finished-breakdown); у бонуса за длинный путь
      // и штрафа за станции такого места нет — просто строки
      const dataAttrs = e.type === 'route' ? `data-type="route" data-route-id="${e.routeId}"`
        : e.type === 'ticket' ? `data-type="ticket" data-from="${e.from}" data-to="${e.to}"`
        : '';
      const cls = dataAttrs ? ' class="ttr-score-log-clickable"' : '';
      return `<li${cls}${dataAttrs ? ' ' + dataAttrs : ''}><span>${ttrScoreLogText(e)}</span><b class="${e.points >= 0 ? 'ttr-score-pos' : 'ttr-score-neg'}">${pts}</b></li>`;
    }).join('');
    $('#ttr-finished-breakdown').innerHTML = me ? `
      <div class="ttr-score-breakdown-player">
        <ul class="ttr-score-breakdown-list">${items || '<li class="hint-text">Нет начислений</li>'}</ul>
      </div>
    ` : '';
  }

  // текстовое описание одной записи журнала очков — "когда и за что"
  // (порядок записей уже хронологический, см. сортировку по ts выше)
  function ttrScoreLogText(entry) {
    if (entry.type === 'route') {
      const route = ttrAssets.routesById[entry.routeId];
      const from = route ? (ttrAssets.citiesById[route.from]?.name || route.from) : entry.routeId;
      const to = route ? (ttrAssets.citiesById[route.to]?.name || route.to) : '';
      return `Маршрут ${escapeHtml(from)} — ${escapeHtml(to)}`;
    }
    if (entry.type === 'ticket') {
      const from = ttrAssets.citiesById[entry.from]?.name || entry.from;
      const to = ttrAssets.citiesById[entry.to]?.name || entry.to;
      return `Билет ${escapeHtml(from)} → ${escapeHtml(to)} (${entry.fulfilled ? 'выполнен' : 'не выполнен'})`;
    }
    if (entry.type === 'longest-path') {
      return `Бонус за самый длинный путь (${entry.length} вагон.)`;
    }
    if (entry.type === 'station-penalty') {
      return `Штраф за неиспользованные станции (${entry.count} шт.)`;
    }
    return entry.type;
  }

  // карта на экране результатов — статичная (без пан/зума, в отличие от
  // игрового экрана): вся партия и так видна целиком, крутить нечего.
  // Монтируется один раз за комнату (структура карты не меняется между
  // партиями, перевставлять дорогой ~2.4МБ DOM ради каждой новой партии
  // незачем) — перекрашивается заново при каждом показе финального экрана.
  let ttrFinishedMapMounted = false;
  function mountTtrFinishedMap() {
    const container = $('#ttr-finished-map-container');
    if (!container) return;
    container.innerHTML = ttrAssets.svgText;
    const svg = container.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      buildTtrOwnerGradients(svg);
    }
  }

  // красит все маршруты по их итоговому владельцу — просто финальная
  // картина доски, без ttrClaimable/ttrSelected и прочего игрового
  // состояния (игра уже кончилась, эти понятия тут не нужны)
  function paintTtrFinishedRoutes(view) {
    const container = $('#ttr-finished-map-container');
    if (!container) return;
    Object.keys(ttrAssets.routesById).forEach((routeId) => {
      const el = container.querySelector('#' + routeId);
      if (!el) return;
      const ownerId = view.routeOwner[routeId];
      if (ownerId) {
        const player = (view.ttrPlayers || []).find((p) => p.id === ownerId);
        paintRouteShapes(el, player?.color);
      }
    });
  }

  // путь между городами билета ВНУТРИ уже построенной (к концу игры) сети
  // самого игрока — не "как было бы дешевле", а как реально вышло сыграть;
  // для невыполненного билета вернёт null (никакого пути и не было)
  function ttrOwnedPathBetween(view, fromCity, toCity) {
    if (fromCity === toCity) return [];
    const myId = view.me?.id;
    const myRoutes = new Set([
      ...Object.keys(view.routeOwner || {}).filter((id) => view.routeOwner[id] === myId),
      ...(view.stationMarkers || []).filter((m) => m.playerId === myId).map((m) => m.routeId),
    ]);
    const adj = new Map();
    myRoutes.forEach((routeId) => {
      const r = ttrAssets.routesById[routeId];
      if (!r) return;
      if (!adj.has(r.from)) adj.set(r.from, []);
      if (!adj.has(r.to)) adj.set(r.to, []);
      adj.get(r.from).push({ to: r.to, routeId });
      adj.get(r.to).push({ to: r.from, routeId });
    });
    const cameFrom = new Map();
    const visited = new Set([fromCity]);
    const queue = [fromCity];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === toCity) break;
      for (const { to, routeId } of adj.get(cur) || []) {
        if (visited.has(to)) continue;
        visited.add(to);
        cameFrom.set(to, { prevCity: cur, routeId });
        queue.push(to);
      }
    }
    if (!cameFrom.has(toCity)) return null;
    const path = [];
    let node = toCity;
    while (node !== fromCity) {
      const step = cameFrom.get(node);
      path.push(step.routeId);
      node = step.prevCity;
    }
    return path;
  }

  let ttrFinishedHighlightRouteIds = [];
  let ttrFinishedHighlightCities = null; // { from, to }
  function ttrClearFinishedHighlight() {
    const container = $('#ttr-finished-map-container');
    if (!container) return;
    ttrFinishedHighlightRouteIds.forEach((routeId) => {
      const el = container.querySelector('#' + routeId);
      if (el) el.classList.remove('ttr-finished-highlight');
    });
    ttrFinishedHighlightRouteIds = [];
    if (ttrFinishedHighlightCities) {
      ttrHighlightCities(ttrFinishedHighlightCities.from, ttrFinishedHighlightCities.to, false, container);
      ttrFinishedHighlightCities = null;
    }
  }

  $('#ttr-finished-breakdown').addEventListener('click', (e) => {
    const li = e.target.closest('.ttr-score-log-clickable');
    if (!li || !state.lastView) return;
    const container = $('#ttr-finished-map-container');
    if (!container) return;

    ttrClearFinishedHighlight();
    $all('#ttr-finished-breakdown .ttr-score-log-active').forEach((el) => el.classList.remove('ttr-score-log-active'));

    let from;
    let to;
    let routeIds;
    if (li.dataset.type === 'route') {
      const route = ttrAssets.routesById[li.dataset.routeId];
      if (!route) return;
      from = route.from;
      to = route.to;
      routeIds = [li.dataset.routeId];
    } else {
      from = li.dataset.from;
      to = li.dataset.to;
      // билет мог остаться невыполненным — тогда своего пути между
      // городами нет вообще, подсвечиваем только сами города
      routeIds = ttrOwnedPathBetween(state.lastView, from, to) || [];
    }

    li.classList.add('ttr-score-log-active');
    routeIds.forEach((routeId) => {
      const el = container.querySelector('#' + routeId);
      if (el) el.classList.add('ttr-finished-highlight');
    });
    ttrHighlightCities(from, to, true, container);
    ttrFinishedHighlightRouteIds = routeIds;
    ttrFinishedHighlightCities = { from, to };
    container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  // --- обработчики (делегирование на статичные контейнеры — переживает
  // перерисовку innerHTML динамических списков внутри них) ---
  // клик "гасится", если ему предшествовало перетаскивание карты (см.
  // pointerup ниже) — иначе панорама мышью/пальцем случайно открывала бы
  // оплату маршрута, оказавшегося под курсором в момент отпускания
  let ttrSuppressNextClick = false;
  // pointerdown ставит capture на mapContainer для надёжного драга (см.
  // ниже), из-за чего браузер ретаргетит следующий click на сам
  // mapContainer, а не на реальный маршрут под курсором — поэтому берём
  // элемент из pointerdown (см. ttrPointerDownTarget), а не e.target клика
  let ttrPointerDownTarget = null;

  $('#ttr-map-container').addEventListener('click', (e) => {
    if (ttrSuppressNextClick) { ttrSuppressNextClick = false; return; }
    const routeEl = (ttrPointerDownTarget || e.target).closest('[id^="route_"]');
    if (!routeEl) return;
    onTtrRouteClick(routeEl.id);
  });

  // клик на карточку билета (в списке "Мои билеты") подсвечивает на карте
  // два города, которые этот билет требует связать — держится до снятия
  // подсказки, наведение курсора тут больше ни при чём
  function ttrHighlightCities(fromId, toId, on, container = $('#ttr-map-container')) {
    if (!container) return;
    [fromId, toId].forEach((cityId) => {
      const el = container.querySelector('#city_' + cityId);
      if (el) el.classList.toggle('ttr-city-highlight', on);
    });
  }

  $('#ttr-tickets-list').addEventListener('click', (e) => {
    const row = e.target.closest('.ttr-ticket-row');
    if (!row || !state.lastView) return;
    const idx = Number(row.dataset.idx);

    // повторный клик по тому же билету — снять подсказку и погасить его города
    if (ttrSuggestedPath && ttrSuggestedPath.source === 'owned' && ttrSuggestedPath.idx === idx) {
      ttrHighlightCities(ttrSuggestedPath.from, ttrSuggestedPath.to, false);
      ttrSuggestedPath = null;
      paintTtrRoutes(state.lastView);
      renderTtrTickets(state.lastView);
      return;
    }

    // переключились на другой билет — погасить города предыдущего активного
    if (ttrSuggestedPath) ttrHighlightCities(ttrSuggestedPath.from, ttrSuggestedPath.to, false);

    const path = ttrFindBestPath(state.lastView, row.dataset.from, row.dataset.to);
    if (!path) {
      alert('Соперники заняли все маршруты между этими городами — билет больше не выполнить.');
      ttrSuggestedPath = null;
    } else {
      ttrSuggestedPath = { source: 'owned', idx, from: row.dataset.from, to: row.dataset.to, routeIds: new Set(path) };
      ttrHighlightCities(row.dataset.from, row.dataset.to, true);
    }
    paintTtrRoutes(state.lastView);
    renderTtrTickets(state.lastView);
  });

  function ttrPointerPos(e, container) {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function ttrDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function ttrMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  // В Safari/WebKit хит-тестирование указателя по такому большому и сложному
  // SVG (2.4МБ, viewBox 14472×11804, сотни путей) само по себе на порядок
  // дороже, чем в Chromium — драг карты давал ~8 fps даже когда наши
  // обработчики вообще ничего не делали (проверено отдельно), т.е. тормозит
  // не наш JS, а сам браузер при попытке понять, над каким элементом курсор
  // на каждое событие. На время активного перетаскивания/зума маршруты под
  // курсором роли не играют (кликнуть по ним всё равно нельзя, пока драг не
  // завершится), поэтому на это время отключаем pointer-events у самого
  // <svg> — событию тогда некуда "проваливаться" глубже контейнера, и
  // хит-тест почти бесплатный. Возвращаем обратно по окончании
  // взаимодействия — обычные клики по маршрутам продолжают работать.
  function ttrSetSvgInteractive(enabled) {
    const svg = ttrMapSvg();
    if (svg) svg.style.pointerEvents = enabled ? '' : 'none';
  }

  {
    const mapContainer = $('#ttr-map-container');

    // колесо мыши — зум к точке под курсором (десктоп). Отдельного
    // "конца" у серии wheel-событий нет (в отличие от pointerup) —
    // отключаем интерактивность SVG на первый тик и включаем обратно
    // через debounce-таймер после паузы в событиях
    let ttrWheelIdleTimer = null;
    mapContainer.addEventListener('wheel', (e) => {
      if (!ttrMapSvg()) return;
      e.preventDefault();
      ttrSetSvgInteractive(false);
      clearTimeout(ttrWheelIdleTimer);
      ttrWheelIdleTimer = setTimeout(() => ttrSetSvgInteractive(true), 200);
      const { x, y } = ttrPointerPos(e, mapContainer);
      const factor = e.deltaY < 0 ? TTR_WHEEL_ZOOM_FACTOR : 1 / TTR_WHEEL_ZOOM_FACTOR;
      ttrZoomAt(x, y, ttrZoom * factor);
    }, { passive: false });

    // Pointer Events — общий код для мыши и тача: один активный указатель
    // (зажатая мышь ИЛИ один палец) двигает панораму, два одновременных
    // указателя (два пальца) — pinch-zoom с якорем в их середине.
    const ttrActivePointers = new Map();
    let ttrDragStart = null; // { x, y, panX, panY } — точка начала панорамы
    let ttrPinchStartDist = null;
    let ttrPointerMoved = 0;

    // capture ставим сразу на pointerdown (иначе на очень быстром/большом
    // драге курсор может выйти за пределы окна ещё до первого зафиксированного
    // pointermove — без раннего capture эти события до нас просто не дойдут).
    mapContainer.addEventListener('pointerdown', (e) => {
      if (!ttrMapSvg()) return;
      mapContainer.setPointerCapture(e.pointerId);
      ttrPointerDownTarget = e.target;
      ttrSetSvgInteractive(false);
      const pos = ttrPointerPos(e, mapContainer);
      ttrActivePointers.set(e.pointerId, pos);
      ttrPointerMoved = 0;
      if (ttrActivePointers.size === 1) {
        ttrDragStart = { x: pos.x, y: pos.y, panX: ttrPanX, panY: ttrPanY };
      } else if (ttrActivePointers.size === 2) {
        const [a, b] = [...ttrActivePointers.values()];
        ttrPinchStartDist = ttrDist(a, b);
        ttrDragStart = null;
      }
    });

    mapContainer.addEventListener('pointermove', (e) => {
      if (!ttrActivePointers.has(e.pointerId)) return;
      const pos = ttrPointerPos(e, mapContainer);
      ttrActivePointers.set(e.pointerId, pos);

      if (ttrActivePointers.size === 2) {
        const [a, b] = [...ttrActivePointers.values()];
        const dist = ttrDist(a, b);
        const mid = ttrMid(a, b);
        if (ttrPinchStartDist) ttrZoomAt(mid.x, mid.y, ttrZoom * (dist / ttrPinchStartDist));
        ttrPinchStartDist = dist;
        ttrPointerMoved += 999; // pinch — точно не одиночный клик
        return;
      }

      if (ttrDragStart) {
        const dx = pos.x - ttrDragStart.x;
        const dy = pos.y - ttrDragStart.y;
        ttrPointerMoved += Math.abs(dx) + Math.abs(dy);
        ttrPanX = ttrDragStart.panX + dx;
        ttrPanY = ttrDragStart.panY + dy;
        clampTtrPan();
        applyTtrTransform();
      }
    });

    function ttrPointerEnd(e) {
      if (mapContainer.hasPointerCapture(e.pointerId)) mapContainer.releasePointerCapture(e.pointerId);
      ttrActivePointers.delete(e.pointerId);
      if (ttrActivePointers.size < 2) ttrPinchStartDist = null;
      if (ttrActivePointers.size === 1) {
        const [only] = [...ttrActivePointers.values()];
        ttrDragStart = { x: only.x, y: only.y, panX: ttrPanX, panY: ttrPanY };
      }
      if (ttrActivePointers.size === 0) {
        ttrDragStart = null;
        if (ttrPointerMoved > TTR_DRAG_CLICK_THRESHOLD) ttrSuppressNextClick = true;
        ttrSetSvgInteractive(true);
      }
    }
    mapContainer.addEventListener('pointerup', ttrPointerEnd);
    mapContainer.addEventListener('pointercancel', ttrPointerEnd);
  }

  // стрелки — панорама с клавиатуры (десктоп); не перехватываем, если
  // фокус в текстовом поле (например, наборе сообщения в чате)
  document.addEventListener('keydown', (e) => {
    if (!$('#screen-game-ttr')?.classList.contains('active')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const dirs = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    const dir = dirs[e.key];
    if (!dir) return;
    e.preventDefault();
    ttrPanX += dir[0] * TTR_KEY_PAN_STEP;
    ttrPanY += dir[1] * TTR_KEY_PAN_STEP;
    clampTtrPan();
    applyTtrTransform();
  });

  // мобильный браузер может менять видимую высоту (адресная строка) или
  // ориентацию экрана — пересчитываем размер карты и границы панорамы
  window.addEventListener('resize', () => {
    if ($('#screen-game-ttr')?.classList.contains('active')) ttrRefitMapSize();
  });
  window.addEventListener('orientationchange', () => {
    if ($('#screen-game-ttr')?.classList.contains('active')) ttrRefitMapSize();
  });

  $('#ttr-draw-deck').addEventListener('click', async () => {
    const res = await emit('draw-card', { source: 'deck' });
    if (res.error) alert(res.error);
  });

  $('#ttr-faceup-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.ttr-faceup-btn');
    if (!btn) return;
    const res = await emit('draw-card', { source: Number(btn.dataset.idx) });
    if (res.error) alert(res.error);
  });

  $('#btn-ttr-draw-tickets').addEventListener('click', async () => {
    const res = await emit('draw-tickets', {});
    if (res.error) alert(res.error);
  });

  $('#ttr-ticket-picker-list').addEventListener('click', (e) => {
    const card = e.target.closest('.ttr-ticket-pick');
    if (!card || !state.lastView) return;
    const idx = Number(card.dataset.idx);

    // галочка в углу — только решение "оставляю/не оставляю", карты не
    // трогает вообще
    if (e.target.closest('.ttr-ticket-pick-toggle')) {
      if (ttrTicketPickerSelected.has(idx)) ttrTicketPickerSelected.delete(idx);
      else ttrTicketPickerSelected.add(idx);
      renderTtrTicketPicker(state.lastView);
      return;
    }

    // сама картинка билета — только "покажи мне этот маршрут на карте",
    // выбор оставить/выкинуть не трогает; независимые действия, разведены
    // по разным элементам карточки, а не по одному клику сразу на оба смысла
    if (!e.target.closest('.ttr-ticket-pick-preview')) return;
    const t = (state.lastView.myPendingTickets || [])[idx];
    if (!t) return;
    if (ttrSuggestedPath) ttrHighlightCities(ttrSuggestedPath.from, ttrSuggestedPath.to, false);
    const path = ttrFindBestPath(state.lastView, t.from, t.to);
    if (path) {
      ttrSuggestedPath = { source: 'picker', idx, from: t.from, to: t.to, routeIds: new Set(path) };
      ttrHighlightCities(t.from, t.to, true);
      ttrFitToCities([t.from, t.to]);
      // пикер лежит под картой — на невысоком экране клик по нижней
      // карточке может проскроллить страницу вниз, к самому пикеру,
      // и увести карту с подсвеченным маршрутом за пределы видимой
      // области; прокручиваем обратно, чтобы маршрут правда было видно
      $('.ttr-map-wrap').scrollIntoView({ block: 'nearest' });
    } else {
      ttrSuggestedPath = null;
    }
    paintTtrRoutes(state.lastView);
    renderTtrTicketPicker(state.lastView);
  });

  $('#btn-ttr-confirm-tickets').addEventListener('click', async () => {
    const res = await emit('choose-tickets', { keepIndices: [...ttrTicketPickerSelected] });
    if (res.error) alert(res.error);
  });

  $('#ttr-payment-cards').addEventListener('click', (e) => {
    const btn = e.target.closest('.ttr-step-plus, .ttr-step-minus');
    if (!btn || !ttrPaymentState) return;
    const color = btn.dataset.color;
    const delta = btn.classList.contains('ttr-step-plus') ? 1 : -1;
    const payment = ttrPaymentState.payment;
    if (delta > 0 && color !== 'locomotive') {
      Object.keys(payment).forEach((c) => { if (c !== 'locomotive' && c !== color) delete payment[c]; });
    }
    payment[color] = Math.max(0, (payment[color] || 0) + delta);
    if (payment[color] === 0) delete payment[color];
    renderTtrPaymentPanel(state.lastView);
  });

  $('#btn-ttr-payment-cancel').addEventListener('click', closeTtrPayment);

  $('#btn-ttr-payment-confirm').addEventListener('click', async () => {
    if (!ttrPaymentState) return;
    const { kind, routeId, payment } = ttrPaymentState;
    const event = kind === 'station' ? 'build-station' : 'claim-route';
    const res = await emit(event, { routeId, payment });
    if (res.error) { alert(res.error); return; }
    closeTtrPayment();
    // не ждём следующего broadcast view — показываем вскрытые тоннельные
    // карты сразу же по ответу сервера, иначе при autoResolved (доплата не
    // нужна) панель не появилась бы вообще никогда (view.pendingTunnel в
    // этом случае на сервере не выставляется, коммит происходит сразу)
    if (event === 'claim-route' && res.tunnel) {
      ttrTunnelLocal = { routeId, payment, ...res.tunnel };
      renderTtrTunnelPanel(state.lastView);
    }
  });

  $('#ttr-tunnel-cards').addEventListener('click', (e) => {
    const btn = e.target.closest('.ttr-step-plus, .ttr-step-minus');
    if (!btn) return;
    const color = btn.dataset.color;
    const delta = btn.classList.contains('ttr-step-plus') ? 1 : -1;
    ttrTunnelDraft[color] = Math.max(0, (ttrTunnelDraft[color] || 0) + delta);
    if (ttrTunnelDraft[color] === 0) delete ttrTunnelDraft[color];
    renderTtrTunnelPanel(state.lastView);
  });

  $('#btn-ttr-tunnel-decline').addEventListener('click', async () => {
    const res = await emit('resolve-tunnel', { decision: null });
    if (res.error) { alert(res.error); return; }
    ttrTunnelLocal = null;
    renderTtrTunnelPanel(state.lastView);
  });

  $('#btn-ttr-tunnel-pay').addEventListener('click', async () => {
    const res = await emit('resolve-tunnel', { decision: { extraPayment: ttrTunnelDraft } });
    if (res.error) { alert(res.error); return; }
    ttrTunnelLocal = null;
    renderTtrTunnelPanel(state.lastView);
  });

  // информационный оверлей (доплата не понадобилась) — маршрут уже
  // построен сервером сразу при claim-route, тут только закрыть попап
  $('#btn-ttr-tunnel-ok').addEventListener('click', () => {
    ttrTunnelLocal = null;
    renderTtrTunnelPanel(state.lastView);
  });

  // ---------- маршрутизация состояния ----------
  function applyRoomUpdate(view) {
    updateCcTurnSound(view);
    const mp = view.status === 'playing' && view.gameType === 'monopoly' ? view.monopoly : null;
    const mpActor = mp ? (mp.auction?.turn || mp.debt?.from || mp.currentPlayerId) : null;
    const mpKey = mp ? `${view.code}:${view.pastGames.length}:${view.round}:${mpActor}` : null;
    if (mp?.canAct && mpActor === view.me?.id && mpKey !== state.monopolyTurnKey && getTeamSoundEnabled('monopoly')) playTurnSound();
    state.monopolyTurnKey = mpKey;
    const railroad = view.status === 'playing' && view.gameType === 'railroad' ? view.railroad : null;
    const railroadKey = railroad ? `${view.code}:${view.pastGames.length}:${view.round}` : null;
    if (railroad?.canBuild && railroadKey !== state.railroadLastRoundKey && getTeamSoundEnabled('railroad')) playTurnSound();
    state.railroadLastRoundKey = railroadKey;
    const cryptid = view.status === 'playing' && view.gameType === 'cryptid' ? view.cryptid : null;
    const cryptidKey = cryptid ? `${view.code}:${view.pastGames.length}:${view.round}:${view.phase}:${cryptid.currentPlayerId}` : null;
    if (cryptid?.canAct && cryptidKey !== state.cryptidLastActionKey && getTeamSoundEnabled('cryptid')) playTurnSound();
    state.cryptidLastActionKey = cryptidKey;
    const six = view.status === 'playing' && view.gameType === 'sixnimmt' ? view.sixnimmt : null;
    const sixKey = six ? `${view.code}:${view.pastGames.length}:${view.round}:${view.phase}` : null;
    if (six && (six.canSelect || six.canChooseRow) && sixKey !== state.sixLastActionKey && getTeamSoundEnabled('sixnimmt')) playTurnSound();
    state.sixLastActionKey = sixKey;
    updateTeamTurnSound(view);
    state.lastView = view;
    currentRoomCode = view.code;
    saveRoomCache(view);
    history.replaceState(null, '', `${location.pathname}?room=${view.code}${view.visibility === 'private' ? `&invite=${view.inviteToken}` : ''}`);
    updateLeaveButtons(view);
    const offlineParticipant = view.players.some(p => !p.connected && p.role !== 'spectator');
    $all('.offline-actions').forEach(panel => { panel.hidden = !(view.status === 'playing' && view.canForceEnd && offlineParticipant); });
    $('#btn-toggle-chat').hidden = false;
    renderChat(view);
    $('#btn-toggle-games').hidden = !(view.pastGames && view.pastGames.length);
    if (state.gamesOpen) renderGamesList(view);
    const isTtr = view.gameType === 'ttr';
    if (isTtr) {
      const myTurnNow = (view.phase === 'playing' || view.phase === 'final-round')
        && view.currentPlayerId === view.me?.id;
      if (myTurnNow && state.ttrLastCurrentPlayerId !== view.currentPlayerId) playTtrTurnSound();
      state.ttrLastCurrentPlayerId = view.currentPlayerId;
    }
    if (view.status === 'lobby') {
      clueInputsRound = null;
      tiebreakInputsBuilt = false;
      state.historyOpen = false;
      $('#history-panel').hidden = true;
      showScreen('lobby');
      renderLobby(view);
    } else if (view.status === 'playing' && view.gameType === 'monopoly') {
      showScreen('game-monopoly');
      window.MonopolyUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'railroad') {
      showScreen('game-railroad');
      window.RailroadUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'cryptid') {
      showScreen('game-cryptid');
      window.CryptidUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'sixnimmt') {
      showScreen('game-sixnimmt');
      window.SixNimmtUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'battleship') {
      showScreen('game-battleship');
      window.BattleshipUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'carcassonne') {
      showScreen('game-carcassonne');
      window.CarcassonneUI.render(view, emit);
    } else if (view.status === 'playing' && view.gameType === 'codenames') {
      showScreen('game-codenames');
      window.CodenamesUI.render(view, emit);
    } else if (view.status === 'playing' && isTtr) {
      const freshStart = state.ttrLastStatus !== 'playing';
      showScreen('game-ttr');
      renderTtrGame(view, freshStart);
    } else if (view.status === 'playing' && view.gameType === 'decoder') {
      showScreen('game');
      renderGame(view);
    } else if (view.status === 'playing') {
      showScreen('game-unavailable');
    } else if (view.status === 'finished') {
      showScreen('finished');
      renderFinished(view);
    }
    state.ttrLastStatus = view.status;
  }
  socket.on('room-update', applyRoomUpdate);

  // ---------- ЧАТ ----------
  let chatUnread = 0;
  let chatReplyTo = null; // { id, name, text } — на какое сообщение сейчас отвечаем
  let chatEditingId = null; // id сообщения, которое сейчас редактируем (или null)
  let lastMarkedChatReadId = null; // id последнего сообщения, за которое уже отправили mark-chat-read

  // цвет имени — детерминированный хеш от playerId, не от команды (команды
  // нет в TTR вообще, а тут нужен цвет для любого участника в любой игре)
  const CHAT_COLORS = ['#57c7e3', '#f0a868', '#7ce38b', '#e35766', '#c78be3', '#e3c757', '#66a3e3', '#e386b0'];
  function chatColorFor(playerId) {
    let h = 0;
    for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) >>> 0;
    return CHAT_COLORS[h % CHAT_COLORS.length];
  }

  function chatTimeLabel(ts) {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  // галочки статуса прочтения — SVG, а не символы "✓✓": текстовые галочки
  // в разных шрифтах рисуются с разным расстоянием между собой, приходилось
  // сжимать их отрицательным letter-spacing, и всё равно не похоже на
  // привычный вид "перекрывающихся" галочек из мессенджеров. currentColor —
  // берёт цвет из .chat-msg-receipt/.read в CSS, отдельно красить не нужно
  const CHAT_CHECK_SINGLE_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5L6 12.5L14 3.5"/></svg>';
  const CHAT_CHECK_DOUBLE_SVG = '<svg viewBox="0 0 20 16" width="18" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8.5L5 12.5L13 3.5"/><path d="M7 8.5L11 12.5L19 3.5"/></svg>';

  function updateChatBadge() {
    const badge = $('#chat-unread-badge');
    badge.hidden = chatUnread <= 0;
    badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
  }

  function renderChatReplyPreview() {
    const bar = $('#chat-reply-preview');
    if (!chatReplyTo) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.querySelector('.chat-reply-preview-name').textContent = chatReplyTo.name;
    bar.querySelector('.chat-reply-preview-snippet').textContent = chatReplyTo.text;
  }

  function renderChatEditPreview() {
    $('#chat-edit-preview').hidden = !chatEditingId;
  }

  // "прочитано хоть кем-то, кроме автора" — приблизительно, по последнему
  // разу, когда игрок открывал чат (view.chatRead[playerId]), а не по
  // каждому сообщению отдельно (см. план/сервер markChatRead)
  function chatReadByOthers(view, msg) {
    return Object.entries(view.chatRead || {}).some(([pid, ts]) => pid !== msg.playerId && ts >= msg.ts);
  }

  function renderChat(view) {
    const chat = view.chat || [];
    const list = $('#chat-messages');
    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;

    // подряд идущие сообщения одного автора — показываем имя только у
    // первого в группе (без ограничения по времени: раньше группировка
    // сбрасывалась через 5 минут тишины, из-за чего один и тот же автор
    // иногда получал повторную подпись с именем без смены отправителя —
    // группировка должна ломаться только реальной сменой автора)
    let lastPlayerId = null;
    list.innerHTML = chat.map((m) => {
      const mine = m.playerId === clientId;
      const grouped = m.playerId === lastPlayerId;
      lastPlayerId = m.playerId;
      const replyHtml = m.replyTo
        ? `<div class="chat-reply-quote"><b>${escapeHtml(m.replyTo.name)}</b>: ${escapeHtml(m.replyTo.text)}</div>`
        : '';
      const editedHtml = m.edited ? '<span class="chat-msg-edited">изм.</span>' : '';
      // галочки статуса прочтения — только на своих сообщениях (чужой
      // статус прочтения себе не нужен), теперь в том же блоке, что и
      // время, а не отдельной строкой под пузырём
      const receiptHtml = mine
        ? `<span class="chat-msg-receipt ${chatReadByOthers(view, m) ? 'read' : ''}" title="Кто прочитал">${chatReadByOthers(view, m) ? CHAT_CHECK_DOUBLE_SVG : CHAT_CHECK_SINGLE_SVG}</span>`
        : '';
      const editBtnHtml = mine
        ? '<button type="button" class="chat-msg-edit-btn" title="Редактировать">✎</button>'
        : '';
      // время (+ "изм." + галочки) — float:right внутри пузыря, а не
      // JS-измерения: если на последней строке текста есть место, само
      // подтягивается туда; если нет — само уходит на новую строку и всё
      // равно остаётся справа. Раньше это считалось вручную через
      // getBoundingClientRect, потому что время был ТОГО ЖЕ размера, что
      // и текст, и пиксель-в-пиксель выравнивание было хрупким между
      // браузерами; теперь время сознательно мельче (0.75em, см. CSS),
      // и обычный float даёт нужное поведение без единой строчки JS
      return `
        <div class="chat-msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}" style="--chat-color:${chatColorFor(m.playerId)}" data-id="${m.id}">
          ${!grouped ? `<span class="chat-msg-name">${escapeHtml(m.name)}</span>` : ''}
          <span class="chat-swipe-reply-icon">↩</span>
          <div class="chat-bubble">
            ${editBtnHtml}
            ${replyHtml}
            <span class="chat-msg-text">${escapeHtml(m.text)}</span>
            <span class="chat-msg-time">${chatTimeLabel(m.ts)}${editedHtml}${receiptHtml}</span>
          </div>
        </div>
      `;
    }).join('') || '<p class="hint-text">Пока никто ничего не написал</p>';

    // считаем от серверной метки chatRead[clientId] (переживает перезагрузку
    // страницы), а не от локального счётчика "сколько сообщений уже
    // отрендерили" — тот обнулялся при каждой перезагрузке модуля и на
    // первом рендере принимал всю историю чата за "новые" сообщения
    if (!state.chatOpen) {
      const myReadTs = view.chatRead?.[clientId] || 0;
      chatUnread = chat.filter(m => m.playerId !== clientId && m.ts > myReadTs).length;
      updateChatBadge();
    }

    if (state.chatOpen || wasAtBottom) {
      list.scrollTop = list.scrollHeight;
    }
    maybeMarkChatRead(view);
  }

  // отправляем "прочитано" не чаще одного раза на новый последний id — и
  // при открытии панели (ниже), и при приходе новых сообщений, пока она уже
  // открыта (см. вызов в конце renderChat)
  function maybeMarkChatRead(view) {
    if (!state.chatOpen) return;
    const chat = view?.chat || [];
    if (!chat.length) return;
    const latestId = chat[chat.length - 1].id;
    if (latestId === lastMarkedChatReadId) return;
    lastMarkedChatReadId = latestId;
    emit('mark-chat-read', {});
  }

  $('#btn-toggle-chat').addEventListener('click', () => {
    state.chatOpen = !state.chatOpen;
    $('#chat-panel').hidden = !state.chatOpen;
    if (state.chatOpen) {
      chatUnread = 0;
      updateChatBadge();
      const list = $('#chat-messages');
      list.scrollTop = list.scrollHeight;
      if (state.lastView) maybeMarkChatRead(state.lastView);
    }
  });
  $('#btn-close-chat').addEventListener('click', () => {
    state.chatOpen = false;
    $('#chat-panel').hidden = true;
  });

  function startChatReply(msg) {
    chatReplyTo = { id: msg.id, name: msg.name, text: msg.text.slice(0, 140) };
    // отвечать и редактировать разом нельзя — новое действие гасит старое
    chatEditingId = null;
    renderChatEditPreview();
    renderChatReplyPreview();
    $('#chat-input').focus();
  }

  // ответ вызывается правым кликом по сообщению (десктоп) или свайпом
  // влево (тач, см. pointer-обработчики ниже) — гасим нативное контекстное
  // меню браузера и открываем реплай сами
  $('#chat-messages').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.chat-msg');
    if (!row) return;
    e.preventDefault();
    const msg = (state.lastView?.chat || []).find(m => m.id === row.dataset.id);
    if (!msg) return;
    startChatReply(msg);
  });
  $('#btn-chat-reply-cancel').addEventListener('click', () => {
    chatReplyTo = null;
    renderChatReplyPreview();
  });

  function startChatEdit(msg) {
    chatEditingId = msg.id;
    chatReplyTo = null;
    renderChatReplyPreview();
    renderChatEditPreview();
    $('#chat-edit-preview').querySelector('.chat-reply-preview-snippet').textContent = msg.text.slice(0, 140);
    const input = $('#chat-input');
    input.value = msg.text;
    autoResizeChatInput();
    input.focus();
  }
  $('#btn-chat-edit-cancel').addEventListener('click', () => {
    chatEditingId = null;
    renderChatEditPreview();
    $('#chat-input').value = '';
    autoResizeChatInput();
  });

  // --- свайп влево по сообщению (только тач) — тот же реплай, что и
  // правый клик на десктопе. pointerdown/move/up вместо touchstart/move/end
  // — единообразно с уже существующим драгом карты в TTR (см. выше по файлу)
  let chatSwipe = null; // { row, startX, startY, committed, dx, pointerId }
  let chatSuppressNextClick = false;
  const CHAT_SWIPE_MAX = 80;
  const CHAT_SWIPE_TRIGGER = 60;

  $('#chat-messages').addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const row = e.target.closest('.chat-msg');
    if (!row) return;
    chatSwipe = { row, startX: e.clientX, startY: e.clientY, committed: false, dx: 0, pointerId: e.pointerId };
  });

  $('#chat-messages').addEventListener('pointermove', (e) => {
    if (!chatSwipe || e.pointerId !== chatSwipe.pointerId) return;
    const dx = e.clientX - chatSwipe.startX;
    const dy = e.clientY - chatSwipe.startY;
    if (!chatSwipe.committed) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return; // рано понимать, свайп это или скролл
      if (Math.abs(dx) <= Math.abs(dy)) { chatSwipe = null; return; } // вертикальный скролл — не наше, отдаём браузеру
      chatSwipe.committed = true;
      chatSwipe.row.setPointerCapture(e.pointerId);
      chatSwipe.row.querySelector('.chat-bubble')?.classList.add('chat-swiping');
    }
    const clamped = dx < 0 ? Math.max(dx, -CHAT_SWIPE_MAX) : 0; // отвечаем только на свайп влево
    chatSwipe.dx = clamped;
    const bubble = chatSwipe.row.querySelector('.chat-bubble');
    if (bubble) bubble.style.transform = clamped ? `translateX(${clamped}px)` : '';
    const icon = chatSwipe.row.querySelector('.chat-swipe-reply-icon');
    if (icon) icon.style.opacity = String(Math.min(1, -clamped / CHAT_SWIPE_TRIGGER));
  });

  function endChatSwipe(e) {
    if (!chatSwipe || (e && e.pointerId !== chatSwipe.pointerId)) return;
    const { row, dx, committed } = chatSwipe;
    const bubble = row.querySelector('.chat-bubble');
    bubble?.classList.remove('chat-swiping');
    if (bubble) bubble.style.transform = ''; // .chat-bubble transition сама анимирует возврат
    const icon = row.querySelector('.chat-swipe-reply-icon');
    if (icon) icon.style.opacity = '0';
    if (committed) {
      chatSuppressNextClick = true; // синтетический click после драга не должен открыть редактирование/поповер
      if (dx <= -CHAT_SWIPE_TRIGGER) {
        const msg = (state.lastView?.chat || []).find(m => m.id === row.dataset.id);
        if (msg) startChatReply(msg);
      }
    }
    chatSwipe = null;
  }
  $('#chat-messages').addEventListener('pointerup', endChatSwipe);
  $('#chat-messages').addEventListener('pointercancel', endChatSwipe);

  // --- галочки статуса прочтения — клик открывает список "кто/когда" ---
  function closeChatReadPopover() {
    $('#chat-read-popover')?.remove();
    document.removeEventListener('click', onChatReadPopoverOutsideClick, true);
  }
  function onChatReadPopoverOutsideClick(e) {
    if (e.target.closest('#chat-read-popover') || e.target.closest('.chat-msg-receipt')) return;
    closeChatReadPopover();
  }
  function toggleChatReadPopover(anchorEl, msg) {
    if ($('#chat-read-popover')) { closeChatReadPopover(); return; }
    const others = (state.lastView?.players || []).filter(p => p.id !== clientId);
    const chatRead = state.lastView?.chatRead || {};
    const rows = others.map((p) => {
      const ts = chatRead[p.id];
      const read = ts && ts >= msg.ts;
      return `<div class="chat-read-popover-row${read ? ' read' : ''}"><span>${escapeHtml(p.name)}</span><span>${read ? chatTimeLabel(ts) : 'не прочитано'}</span></div>`;
    }).join('') || '<div class="chat-read-popover-row hint-text">Нет других игроков</div>';
    const popover = document.createElement('div');
    popover.id = 'chat-read-popover';
    popover.className = 'chat-read-popover';
    popover.innerHTML = rows;
    document.body.appendChild(popover);
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 6}px`;
    popover.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popover.offsetWidth - 8))}px`;
    // подписка со сдвигом на следующий тик — иначе этот же клик, всплыв до
    // document, сразу же закрыл бы только что открытый поповер
    setTimeout(() => document.addEventListener('click', onChatReadPopoverOutsideClick, true), 0);
  }

  $('#chat-messages').addEventListener('click', (e) => {
    if (chatSuppressNextClick) { chatSuppressNextClick = false; return; }
    const editBtn = e.target.closest('.chat-msg-edit-btn');
    if (editBtn) {
      const row = editBtn.closest('.chat-msg');
      const msg = (state.lastView?.chat || []).find(m => m.id === row?.dataset.id);
      if (msg) startChatEdit(msg);
      return;
    }
    const receipt = e.target.closest('.chat-msg-receipt');
    if (receipt) {
      const row = receipt.closest('.chat-msg');
      const msg = (state.lastView?.chat || []).find(m => m.id === row?.dataset.id);
      if (msg) toggleChatReadPopover(receipt, msg);
    }
  });

  function autoResizeChatInput() {
    const input = $('#chat-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  $('#chat-input').addEventListener('input', autoResizeChatInput);
  // Enter — отправка, Shift+Enter — перенос строки (обычное поведение мессенджеров)
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  async function sendChatMessage() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (chatEditingId) {
      const id = chatEditingId;
      input.value = '';
      autoResizeChatInput();
      chatEditingId = null;
      renderChatEditPreview();
      const res = await emit('edit-chat', { id, text });
      if (res.error) alert(res.error);
      return;
    }
    input.value = '';
    autoResizeChatInput();
    const replyToId = chatReplyTo?.id || null;
    chatReplyTo = null;
    renderChatReplyPreview();
    const res = await emit('send-chat', { text, replyTo: replyToId });
    if (res.error) alert(res.error);
  }

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChatMessage();
  });

  async function connectSession() {
    try {
      const catalog = await fetch('/api/games').then(response => response.json());
      $('#match-game-select').innerHTML = catalog.map((game, index) => `<label class="match-game-option"><input type="radio" name="match-game" value="${escapeHtml(game.id)}" ${index === 0 ? 'checked' : ''}><span>${escapeHtml(game.label)}</span></label>`).join('');
      const response = await fetch('/api/session', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Не удалось открыть сессию');
      const session = await response.json();
      clientId = session.playerId;
      // Old cached secrets belong to an unverified legacy browser identity.
      try {
        if (localStorage.getItem('decoder_client_id') !== clientId) clearRoomCache();
        localStorage.setItem('decoder_client_id', clientId);
      } catch (e) {}
      if (currentRoomCode) {
        const cached = readCachedView(currentRoomCode);
        if (cached) applyRoomUpdate(cached);
      }
      socket.connect();
    } catch (e) {
      showError(landingError, 'Не удалось подключиться. Проверьте адрес сайта и обновите страницу.');
    }
  }
  socket.on('connect_error', () => showError(landingError, 'Не удалось подключиться. Обновите страницу.'));
  connectSession();

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
})();
