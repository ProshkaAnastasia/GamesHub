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
      list.innerHTML = '<p class="hint-text">Сейчас нет активных комнат</p>';
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
  $('#btn-copy-link').addEventListener('click', () => {
    const code = state.lastView?.code;
    if (!code) return;
    const url = `${location.origin}${location.pathname}?room=${code}`;
    navigator.clipboard?.writeText(url).catch(() => {});
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
    $('#btn-toggle-chat').hidden = true;
    $('#chat-panel').hidden = true;
    $('#btn-toggle-games').hidden = true;
    $('#games-panel').hidden = true;
    showScreen('landing');
  }
  $('#btn-leave-lobby').addEventListener('click', leaveRoom);
  $('#btn-leave-game').addEventListener('click', leaveRoom);

  function updateLeaveButtons(view) {
    const safe = view.canLeaveSafely?.safe !== false;
    const reason = view.canLeaveSafely?.reason;
    [$('#btn-leave-lobby'), $('#btn-leave-game')].forEach((btn) => {
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

  function renderLobby(view) {
    $('#lobby-room-code').textContent = view.code;

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
    $('#unassigned-wrap').hidden = byTeam.none.length === 0;

    const startBtn = $('#btn-start-game');
    const isHost = view.me?.isHost;
    startBtn.hidden = !isHost;
    startBtn.disabled = !view.canStart;
    $('#lobby-status').textContent = view.canStart
      ? (isHost ? 'Можно начинать!' : 'Хост может начинать игру')
      : 'Нужно от 2 до 4 игроков в каждой команде (либо 2 и 1, если играете втроём)';
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
    const isDraw = view.winner === 'draw';
    const won = !isDraw && view.me?.team && view.winner === view.me.team;
    $('#finished-title').textContent = isDraw
      ? 'Ничья! 🤝'
      : won ? 'Победа! 🎉' : (view.me?.team ? 'Поражение' : 'Игра окончена');
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
    if (view.status === 'lobby') {
      state.historyOpen = false;
      $('#history-panel').hidden = true;
      showScreen('lobby');
      renderLobby(view);
    } else if (view.status === 'playing') {
      showScreen('game');
      renderGame(view);
    } else if (view.status === 'finished') {
      showScreen('finished');
      renderFinished(view);
    }
  }
  socket.on('room-update', applyRoomUpdate);

  // ---------- ЧАТ ----------
  let chatUnread = 0;
  let lastRenderedChatLen = 0;

  function updateChatBadge() {
    const badge = $('#chat-unread-badge');
    badge.hidden = chatUnread <= 0;
    badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
  }

  function renderChat(view) {
    const chat = view.chat || [];
    const list = $('#chat-messages');
    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;

    list.innerHTML = chat.map(m => {
      const mine = m.playerId === clientId;
      const teamClass = m.team ? `team-${m.team.toLowerCase()}` : '';
      return `
        <div class="chat-msg ${mine ? 'mine' : ''} ${teamClass}">
          <span class="chat-msg-name">${escapeHtml(m.name)}</span>
          <span class="chat-msg-text">${escapeHtml(m.text)}</span>
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

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await emit('send-chat', { text });
    if (res.error) alert(res.error);
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
