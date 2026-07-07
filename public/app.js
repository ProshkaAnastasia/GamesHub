(() => {
  const socket = io();

  const state = {
    myId: null,
    lastView: null,
    historyOpen: false,
    chatOpen: false,
    gamesOpen: false,
  };

  // ---------- утилиты ----------
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  function showScreen(name) {
    $all('.screen').forEach(s => s.classList.remove('active'));
    $(`#screen-${name}`).classList.add('active');
  }

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => resolve(res || {}));
    });
  }

  function showError(el, message) {
    el.textContent = message;
    el.hidden = !message;
  }

  // ---------- персистентная личность и кэш комнаты ----------
  // clientId переживает перезагрузку страницы (в отличие от socket.id),
  // это позволяет узнать вернувшегося игрока и восстановить его в комнате
  function getClientId() {
    let id = null;
    try { id = localStorage.getItem('decoder_client_id'); } catch (e) {}
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try { localStorage.setItem('decoder_client_id', id); } catch (e) {}
    }
    return id;
  }
  const clientId = getClientId();

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
    state.myId = socket.id;
    if (currentRoomCode) {
      emit('rejoin-room', { roomCode: currentRoomCode, clientId }).then((res) => {
        if (res.error) {
          currentRoomCode = null;
          clearRoomCache();
          history.replaceState(null, '', location.pathname);
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

    const res = await emit('join-room', { name, roomCode, clientId });
    if (res.error) return showError(landingError, res.error);
  });

  // ---------- список активных комнат (доступен только до входа в свою) ----------
  const STATUS_LABELS = { lobby: 'лобби', playing: 'игра идёт', finished: 'завершена' };

  function renderRoomsList(rooms) {
    const list = $('#rooms-list');
    if (!rooms.length) {
      list.innerHTML = '<p class="hint-text">Комнат пока нет</p>';
      return;
    }
    list.innerHTML = rooms.map(r => `
      <button class="room-item" data-code="${r.code}">
        <span class="room-item-code mono">${r.code}</span>
        <span class="room-item-meta">${r.playerCount} игрок(ов)${r.hostName ? ' · хост ' + escapeHtml(r.hostName) : ''}${r.status === 'playing' ? ' · раунд ' + r.round : ''}</span>
        <span class="room-item-status">${STATUS_LABELS[r.status] || r.status}</span>
      </button>
    `).join('');
    $all('.room-item').forEach(btn => {
      btn.addEventListener('click', () => {
        roomCodeInput.value = btn.dataset.code;
        $('#rooms-panel').hidden = true;
        $('#btn-join').click();
      });
    });
  }

  $('#btn-list-rooms').addEventListener('click', async () => {
    const res = await emit('list-rooms', {});
    renderRoomsList(res.rooms || []);
    $('#rooms-panel').hidden = false;
  });
  $('#btn-close-rooms').addEventListener('click', () => {
    $('#rooms-panel').hidden = true;
  });

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
    const url = `${location.origin}${location.pathname}?room=${code}`;
    const btn = $('#btn-copy-link');
    const ok = await copyTextToClipboard(url);
    const prevText = btn.textContent;
    btn.textContent = ok ? '✓' : '✕';
    setTimeout(() => { btn.textContent = prevText; }, 1200);
  });

  async function leaveRoom() {
    if (state.lastView?.status === 'playing') {
      if (!confirm('Выйти из комнаты? Игра продолжится без вас.')) return;
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
  }
  $('#btn-leave-lobby').addEventListener('click', leaveRoom);
  $('#btn-leave-game').addEventListener('click', leaveRoom);
  $('#btn-leave-game-ttr').addEventListener('click', leaveRoom);

  async function forceEndGame() {
    if (!confirm('Завершить текущую игру для всех? Победитель не будет определён.')) return;
    const res = await emit('force-end-game', {});
    if (res.error) alert(res.error);
  }
  $('#btn-force-end-game').addEventListener('click', forceEndGame);
  $('#btn-force-end-game-ttr').addEventListener('click', forceEndGame);

  function updateLeaveButtons(view) {
    const safe = view.canLeaveSafely?.safe !== false;
    const reason = view.canLeaveSafely?.reason;
    [$('#btn-leave-lobby'), $('#btn-leave-game'), $('#btn-leave-game-ttr')].forEach((btn) => {
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
    const types = view.availableGameTypes || [];
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
    const gameChosen = !!view.gameType;
    const pendingHint = $('#game-type-pending-hint');
    const currentModule = (view.availableGameTypes || []).find(t => t.id === view.gameType);
    const hasTeams = !!(currentModule?.teamKeys?.length);
    $('#teams-section').hidden = !gameChosen;
    pendingHint.hidden = gameChosen;
    if (!gameChosen) {
      pendingHint.textContent = isHost ? 'Выберите игру, чтобы продолжить' : 'Хост выбирает игру…';
      $('#btn-start-game').hidden = true;
      $('#lobby-status').hidden = true;
      return;
    }
    $('#lobby-status').hidden = false;
    // игры без команд (teamKeys: []), например Ticket to Ride — прячем
    // блок выбора А/Б, но список игроков всё равно нужен, поэтому
    // переиспользуем unassigned-list как общий ростер (team у всех так и
    // остаётся null, никто его в таких играх не выставляет)
    $('.teams-grid').hidden = !hasTeams;

    const byTeam = { A: [], B: [], none: [] };
    view.players.forEach(p => {
      if (p.team === 'A') byTeam.A.push(p);
      else if (p.team === 'B') byTeam.B.push(p);
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
    startBtn.hidden = !isHost;
    startBtn.disabled = !view.canStart;
    $('#lobby-status').textContent = view.canStart
      ? (isHost ? 'Можно начинать!' : 'Хост может начинать игру')
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
    $('#roster-row').innerHTML = view.players.map(p => `
      <span class="roster-chip team-${(p.team || '').toLowerCase()} ${p.connected ? '' : 'offline'}">
        <span class="dot"></span>${escapeHtml(p.name)}${p.connected ? '' : ' (офлайн)'}
      </span>
    `).join('');
  }

  function renderGame(view) {
    $('#btn-force-end-game').hidden = !view.me?.isHost;
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
      $('#word-slots').innerHTML = '<div class="hint-text">Вы не участвуете в текущей игре.</div>';
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
    $('#guess-board-intercept').hidden = oppIsLone;

    ownGuessDraft = tv.ownGuess ? [...tv.ownGuess] : [null, null, null];
    interceptGuessDraft = tv.interceptGuess ? [...tv.interceptGuess] : [null, null, null];

    if (!isLoneMe) renderPicker('picker-own', ownGuessDraft, tv.ownLocked || tv.isEncryptor, 'own');
    if (!oppIsLone) renderPicker('picker-intercept', interceptGuessDraft, tv.interceptLocked, 'intercept');

    $('#own-board-hint').textContent = tv.isEncryptor
      ? '(отгадывают товарищи по команде)'
      : '(расшифруйте свои подсказки)';

    const lockOwnBtn = $('#lock-own');
    const lockInterceptBtn = $('#lock-intercept');
    lockOwnBtn.disabled = tv.ownLocked || tv.isEncryptor;
    lockOwnBtn.textContent = tv.ownLocked ? 'Подтверждено ✓' : (tv.isEncryptor ? 'Не для вас' : 'Подтвердить');
    lockInterceptBtn.disabled = tv.interceptLocked;
    lockInterceptBtn.textContent = tv.interceptLocked ? 'Подтверждено ✓' : 'Подтвердить';
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
    return guess.map(g => `<span class="digit-chip ${allCorrect ? 'match' : 'miss'}">${g}</span>`).join('');
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

    if (tb.myLocked) {
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
              ${isLoneTeam ? '' : `
                <div class="h-line">
                  <span class="h-line-label">Своя расшифровка</span>
                  <span class="digit-row">${digitChips(h.ownGuess, h.ownCorrect)}</span>
                </div>
              `}
              ${isDuoVsSoloOpponent ? '' : `
                <div class="h-line">
                  <span class="h-line-label">Перехват соперника</span>
                  <span class="digit-row">${interceptGuess ? digitChips(interceptGuess, weIntercepted) : '<span class="assoc-empty">—</span>'}</span>
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
      // код мог быть скрыт (никто его не подтвердил в этом раунде) —
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
      const title = isDraw ? 'Ничья' : `Победа команды ${g.winner === 'A' ? 'А' : 'Б'}`;
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
    const perspectiveTeam = (view.me && view.me.team) || 'A';
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
    const isTtr = view.gameType === 'ttr';
    const isDraw = view.winner === 'draw';
    const won = isTtr ? (view.winner === view.me?.id) : (!isDraw && view.me?.team && view.winner === view.me.team);
    $('#finished-title').textContent = isDraw
      ? 'Ничья! 🤝'
      : won ? 'Победа! 🎉' : (isTtr || !view.me?.team ? 'Игра окончена' : 'Поражение');
    $('#finished-reason').textContent = view.winReason || '';
    const isHost = view.me?.isHost;
    $('#btn-play-again').hidden = !isHost;
    $('#finished-wait-hint').hidden = !!isHost;
    if (!isHost) {
      const host = view.players.find(p => p.isHost);
      $('#finished-wait-hint').textContent = (host && !host.connected)
        ? `Ждём хоста (${host.name}) — потерял соединение…`
        : 'Ждём хоста…';
    }

    if (isTtr) {
      $('#finished-report').hidden = true;
      $('#btn-toggle-history-finished').hidden = true;
      $('#ttr-finished-report').hidden = false;
      renderTtrFinishedScores(view);
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
  const TTR_CARD_LABELS = {
    pink: 'Розовый', white: 'Белый', blue: 'Синий', yellow: 'Жёлтый',
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
  let ttrTicketPickerKey = null; // "from-to|from-to..." текущего показанного набора билетов
  let ttrTicketPickerSelected = new Set();
  let ttrSuggestedPath = null; // { idx, from, to, routeIds: Set<routeId> } — подсказка пути по клику на билет

  // кратчайший (по сумме length) путь между городами билета через маршруты,
  // не занятые соперником — свои уже построенные маршруты считаются
  // "бесплатными" (вес 0), т.к. их не нужно строить заново. Возвращает
  // список routeId или null, если соперники перекрыли все варианты.
  function ttrFindBestPath(view, fromCity, toCity) {
    const routeOwner = view.routeOwner || {};
    const myId = view.me?.id;
    // маршруты, разблокированные МОИМИ станциями — считаются бесплатными
    // (уже подключены), как и собственные построенные
    const myLinkedRoutes = new Set((view.stationMarkers || []).filter(m => m.playerId === myId).map(m => m.routeId));
    const adj = new Map(); // city -> [{to, routeId, weight}]
    Object.values(ttrAssets.routesById).forEach((r) => {
      const owner = routeOwner[r.id];
      const isMineOrLinked = owner === myId || myLinkedRoutes.has(r.id);
      if (owner && !isMineOrLinked) return; // занято соперником и станции тут нет — недоступно
      const weight = isMineOrLinked ? 0 : r.length;
      if (!adj.has(r.from)) adj.set(r.from, []);
      if (!adj.has(r.to)) adj.set(r.to, []);
      adj.get(r.from).push({ to: r.to, routeId: r.id, weight });
      adj.get(r.to).push({ to: r.from, routeId: r.id, weight });
    });

    if (fromCity === toCity) return [];
    const dist = new Map([[fromCity, 0]]);
    const cameFrom = new Map(); // city -> { prevCity, routeId }
    const visited = new Set();
    // городов мало (47) — обычный перебор без кучи вполне достаточен
    while (true) {
      let cur = null;
      let curDist = Infinity;
      for (const [city, d] of dist) {
        if (!visited.has(city) && d < curDist) { cur = city; curDist = d; }
      }
      if (cur === null) break;
      if (cur === toCity) {
        const path = [];
        let node = toCity;
        while (node !== fromCity) {
          const step = cameFrom.get(node);
          path.push(step.routeId);
          node = step.prevCity;
        }
        return path;
      }
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
    return null; // соперники перекрыли все варианты — билет больше не выполнить
  }

  function loadTtrAssets() {
    if (!ttrAssetsPromise) {
      ttrAssetsPromise = Promise.all([
        fetch('/api/ttr/map').then(r => r.json()),
        fetch('/ttr/ttr-map.svg').then(r => r.text()),
      ]).then(([mapData, svgText]) => {
        const citiesById = {};
        mapData.cities.forEach(c => { citiesById[c.id] = c; });
        const routesById = {};
        mapData.routes.forEach(r => { routesById[r.id] = r; });
        ttrAssets = { citiesById, routesById, trainColors: mapData.trainColors, svgText };
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

  let ttrZoom = 1;
  const TTR_ZOOM_MIN = 1;
  const TTR_ZOOM_MAX = 3;
  const TTR_ZOOM_STEP = 0.25;

  function applyTtrZoom() {
    const svg = $('#ttr-map-container svg');
    if (svg) svg.style.width = `${ttrZoom * 100}%`;
  }

  function mountTtrMap() {
    const container = $('#ttr-map-container');
    container.innerHTML = ttrAssets.svgText;
    const svg = container.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      buildTtrOwnerGradients(svg);
    }
    ttrZoom = 1;
    applyTtrZoom();
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
    });
  }

  function renderTtrRoster(view) {
    $('#btn-force-end-game-ttr').hidden = !view.me?.isHost;
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
          <span class="ttr-roster-stats">🚃<b style="color:${hex}">${p.trainsLeft}</b> · 🚉${p.stationsLeft} · 🏆${p.score}</span>
        </span>
      `;
    }).join('');

    const turnPlayer = players.find(p => p.id === view.currentPlayerId);
    const indicator = $('#ttr-turn-indicator');
    if (view.pendingTunnel) {
      indicator.textContent = (view.pendingTunnel.playerId === view.me?.id) ? 'Решите судьбу туннеля' : 'Соперник решает судьбу туннеля';
    } else if (view.myPendingTickets) {
      indicator.textContent = 'Выберите билеты';
    } else if (turnPlayer) {
      indicator.textContent = (turnPlayer.id === view.me?.id) ? 'Ваш ход' : `Ход: ${turnPlayer.name}`;
    } else {
      indicator.textContent = '';
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
      el.classList.remove('ttr-claimable', 'ttr-selected', 'ttr-suggested');
      if (ttrSuggestedPath && ttrSuggestedPath.routeIds.has(routeId)) el.classList.add('ttr-suggested');
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
      const midX = (from.x + to.x) / 2;
      const midY = (from.y + to.y) / 2;
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
    $('#ttr-discard-count').textContent = view.discardCount;
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
    const pending = view.pendingTunnel;
    if (!pending) { panel.hidden = true; ttrTunnelRouteId = null; return; }
    panel.hidden = false;
    if (ttrTunnelRouteId !== pending.routeId) {
      ttrTunnelRouteId = pending.routeId;
      ttrTunnelDraft = {};
    }

    const revealedHtml = pending.revealed.map(c => ttrCardTile(c)).join('');
    $('#ttr-tunnel-text').innerHTML = `Вскрыты карты: ${revealedHtml}<br>Нужно доплатить ${pending.extraNeeded} карт(ы) цвета <b>${TTR_CARD_LABELS[pending.colorUsed] || pending.colorUsed}</b> (или локомотивами), либо отказаться от маршрута.`;

    const hand = view.myHand || {};
    const total = Object.values(ttrTunnelDraft).reduce((a, b) => a + b, 0);
    const locoCount = ttrTunnelDraft.locomotive || 0;

    const tiles = [];
    if (pending.colorUsed !== 'locomotive') {
      const colorCount = ttrTunnelDraft[pending.colorUsed] || 0;
      const colorHave = hand[pending.colorUsed] || 0;
      tiles.push(ttrPaymentTile(pending.colorUsed, colorCount, colorHave, Math.min(colorHave, pending.extraNeeded - (total - colorCount))));
    }
    const locoHave = hand.locomotive || 0;
    tiles.push(ttrPaymentTile('locomotive', locoCount, locoHave, Math.min(locoHave, pending.extraNeeded - (total - locoCount))));
    $('#ttr-tunnel-cards').innerHTML = tiles.join('');

    $('#btn-ttr-tunnel-pay').disabled = total !== pending.extraNeeded;
  }

  function ttrTicketRow(t, idx) {
    const from = ttrAssets.citiesById[t.from]?.name || t.from;
    const to = ttrAssets.citiesById[t.to]?.name || t.to;
    const isActive = ttrSuggestedPath && ttrSuggestedPath.idx === idx;
    const cls = `ttr-ticket-row${t.fulfilled ? ' ttr-ticket-fulfilled' : ''}${isActive ? ' ttr-ticket-active' : ''}`;
    return `<div class="${cls}" data-idx="${idx}" data-from="${t.from}" data-to="${t.to}"><span>${escapeHtml(from)} → ${escapeHtml(to)}</span><b>${t.points}</b></div>`;
  }

  function renderTtrTickets(view) {
    const tickets = view.myTickets || [];
    $('#ttr-tickets-list').innerHTML = tickets.length
      ? tickets.map((t, idx) => ttrTicketRow(t, idx)).join('')
      : '<p class="hint-text">Пока нет билетов</p>';
    $('#btn-ttr-draw-tickets').disabled = !ttrCanAct(view);
  }

  function renderTtrTicketPicker(view) {
    const overlay = $('#ttr-ticket-picker');
    const heading = overlay.querySelector('h3');
    const confirmBtn = $('#btn-ttr-confirm-tickets');
    const pending = view.myPendingTickets;

    if (pending) {
      overlay.hidden = false;
      heading.textContent = 'Выберите билеты';
      confirmBtn.hidden = false;
      const key = pending.map(t => `${t.from}-${t.to}`).join('|');
      if (ttrTicketPickerKey !== key) {
        ttrTicketPickerKey = key;
        // по умолчанию оставляем все — игрок сам снимает лишние выше минимума
        ttrTicketPickerSelected = new Set(pending.map((_, i) => i));
      }
      const minKeep = view.myPendingTicketsMinKeep || 1;
      $('#ttr-ticket-picker-hint').textContent = `Оставьте минимум ${minKeep} из ${pending.length}`;
      $('#ttr-ticket-picker-list').innerHTML = pending.map((t, i) => {
        const from = ttrAssets.citiesById[t.from]?.name || t.from;
        const to = ttrAssets.citiesById[t.to]?.name || t.to;
        const selected = ttrTicketPickerSelected.has(i);
        return `
          <button type="button" class="ttr-ticket-pick ${selected ? 'selected' : ''}" data-idx="${i}">
            <span>${escapeHtml(from)} → ${escapeHtml(to)}</span><b>${t.points}</b>
          </button>
        `;
      }).join('');
      confirmBtn.disabled = ttrTicketPickerSelected.size < minKeep;
      return;
    }

    ttrTicketPickerKey = null;
    // фаза initial-tickets общая на всех — пока хоть кто-то не выбрал,
    // партия не переходит в 'playing'; сам я мог уже выбрать и жду других,
    // показываем это явно, а не тихо распахиваем игровое поле
    if (view.phase !== 'initial-tickets') { overlay.hidden = true; return; }

    overlay.hidden = false;
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
  }

  // --- обработчики (делегирование на статичные контейнеры — переживает
  // перерисовку innerHTML динамических списков внутри них) ---
  $('#ttr-map-container').addEventListener('click', (e) => {
    const routeEl = e.target.closest('[id^="route_"]');
    if (!routeEl) return;
    onTtrRouteClick(routeEl.id);
  });

  // клик на карточку билета (в списке "Мои билеты") подсвечивает на карте
  // два города, которые этот билет требует связать — держится до снятия
  // подсказки, наведение курсора тут больше ни при чём
  function ttrHighlightCities(fromId, toId, on) {
    const container = $('#ttr-map-container');
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
    if (ttrSuggestedPath && ttrSuggestedPath.idx === idx) {
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
      ttrSuggestedPath = { idx, from: row.dataset.from, to: row.dataset.to, routeIds: new Set(path) };
      ttrHighlightCities(row.dataset.from, row.dataset.to, true);
    }
    paintTtrRoutes(state.lastView);
    renderTtrTickets(state.lastView);
  });

  $('#ttr-zoom-in').addEventListener('click', () => {
    ttrZoom = Math.min(TTR_ZOOM_MAX, ttrZoom + TTR_ZOOM_STEP);
    applyTtrZoom();
  });
  $('#ttr-zoom-out').addEventListener('click', () => {
    ttrZoom = Math.max(TTR_ZOOM_MIN, ttrZoom - TTR_ZOOM_STEP);
    applyTtrZoom();
  });
  $('#ttr-zoom-reset').addEventListener('click', () => {
    ttrZoom = 1;
    applyTtrZoom();
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
    const btn = e.target.closest('.ttr-ticket-pick');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (ttrTicketPickerSelected.has(idx)) ttrTicketPickerSelected.delete(idx);
    else ttrTicketPickerSelected.add(idx);
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
    const event = ttrPaymentState.kind === 'station' ? 'build-station' : 'claim-route';
    const res = await emit(event, { routeId: ttrPaymentState.routeId, payment: ttrPaymentState.payment });
    if (res.error) { alert(res.error); return; }
    closeTtrPayment();
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
    if (res.error) alert(res.error);
  });

  $('#btn-ttr-tunnel-pay').addEventListener('click', async () => {
    const res = await emit('resolve-tunnel', { decision: { extraPayment: ttrTunnelDraft } });
    if (res.error) alert(res.error);
  });

  // ---------- маршрутизация состояния ----------
  function applyRoomUpdate(view) {
    state.lastView = view;
    currentRoomCode = view.code;
    saveRoomCache(view);
    history.replaceState(null, '', `${location.pathname}?room=${view.code}`);
    updateLeaveButtons(view);
    $('#btn-toggle-chat').hidden = false;
    renderChat(view);
    $('#btn-toggle-games').hidden = !(view.pastGames && view.pastGames.length);
    if (state.gamesOpen) renderGamesList(view);
    const isTtr = view.gameType === 'ttr';
    if (view.status === 'lobby') {
      state.historyOpen = false;
      $('#history-panel').hidden = true;
      showScreen('lobby');
      renderLobby(view);
    } else if (view.status === 'playing' && isTtr) {
      const freshStart = state.ttrLastStatus !== 'playing';
      showScreen('game-ttr');
      renderTtrGame(view, freshStart);
    } else if (view.status === 'playing') {
      showScreen('game');
      renderGame(view);
    } else if (view.status === 'finished') {
      showScreen('finished');
      renderFinished(view);
    }
    state.ttrLastStatus = view.status;
  }
  socket.on('room-update', applyRoomUpdate);

  // ---------- ЧАТ ----------
  let chatUnread = 0;
  let lastRenderedChatLen = 0;
  let chatReplyTo = null; // { id, name, text } — на какое сообщение сейчас отвечаем

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

  function renderChat(view) {
    const chat = view.chat || [];
    const list = $('#chat-messages');
    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;

    // подряд идущие сообщения одного автора (в пределах 5 минут) —
    // показываем имя только у первого в группе
    let lastPlayerId = null;
    let lastTs = 0;
    list.innerHTML = chat.map((m) => {
      const mine = m.playerId === clientId;
      const grouped = m.playerId === lastPlayerId && (m.ts - lastTs) < 5 * 60 * 1000;
      lastPlayerId = m.playerId;
      lastTs = m.ts;
      const replyHtml = m.replyTo
        ? `<div class="chat-reply-quote"><b>${escapeHtml(m.replyTo.name)}</b>: ${escapeHtml(m.replyTo.text)}</div>`
        : '';
      return `
        <div class="chat-msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}" style="--chat-color:${chatColorFor(m.playerId)}">
          ${!grouped ? `<span class="chat-msg-name">${escapeHtml(m.name)}</span>` : ''}
          <div class="chat-bubble">
            ${replyHtml}
            <span class="chat-msg-text">${escapeHtml(m.text)}</span>
            <span class="chat-msg-time">${chatTimeLabel(m.ts)}</span>
          </div>
          <button type="button" class="chat-reply-btn" data-id="${m.id}">↩ Ответить</button>
        </div>
      `;
    }).join('') || '<p class="hint-text">Пока никто ничего не написал</p>';

    if (chat.length > lastRenderedChatLen) {
      const newMessages = chat.slice(lastRenderedChatLen);
      const incomingCount = newMessages.filter(m => m.playerId !== clientId).length;
      if (incomingCount && !state.chatOpen) {
        chatUnread += incomingCount;
        updateChatBadge();
      }
    }
    lastRenderedChatLen = chat.length;

    if (state.chatOpen || wasAtBottom) {
      list.scrollTop = list.scrollHeight;
    }
  }

  $('#btn-toggle-chat').addEventListener('click', () => {
    state.chatOpen = !state.chatOpen;
    $('#chat-panel').hidden = !state.chatOpen;
    if (state.chatOpen) {
      chatUnread = 0;
      updateChatBadge();
      const list = $('#chat-messages');
      list.scrollTop = list.scrollHeight;
    }
  });
  $('#btn-close-chat').addEventListener('click', () => {
    state.chatOpen = false;
    $('#chat-panel').hidden = true;
  });

  $('#chat-messages').addEventListener('click', (e) => {
    const btn = e.target.closest('.chat-reply-btn');
    if (!btn) return;
    const msg = (state.lastView?.chat || []).find(m => m.id === btn.dataset.id);
    if (!msg) return;
    chatReplyTo = { id: msg.id, name: msg.name, text: msg.text.slice(0, 140) };
    renderChatReplyPreview();
    $('#chat-input').focus();
  });
  $('#btn-chat-reply-cancel').addEventListener('click', () => {
    chatReplyTo = null;
    renderChatReplyPreview();
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

  // отрисовать закэшированный вид комнаты сразу, не дожидаясь ответа сервера
  // (чтобы при перезагрузке страницы не было пустого экрана) — обязательно
  // в самом конце скрипта, когда все let/const-переменные рендер-пайплайна
  // (clueTimerInterval, ownGuessDraft и т.д.) уже инициализированы, иначе
  // обращение к ним до объявления кидает ReferenceError и обрывает весь
  // остальной скрипт, включая регистрацию обработчиков кнопок и socket-событий
  if (currentRoomCode) {
    const cached = readCachedView(currentRoomCode);
    if (cached) applyRoomUpdate(cached);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
