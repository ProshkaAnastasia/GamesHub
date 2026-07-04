(() => {
  const socket = io();

  const state = {
    myId: null,
    lastView: null,
    historyOpen: false,
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
  let storedRoomCode = null;
  try { storedRoomCode = localStorage.getItem('decoder_room_code'); } catch (e) {}
  // текущий известный код комнаты — обновляется на каждый room-update
  // (не застывший снимок), чтобы переподключение сокета после сетевого
  // сбоя всегда пыталось восстановиться именно в АКТУАЛЬНОЙ комнате,
  // а не в той, что была на момент загрузки страницы
  let currentRoomCode = (urlRoomCodeEarly ? urlRoomCodeEarly.toUpperCase() : null) || storedRoomCode;

  socket.on('connect', () => {
    state.myId = socket.id;
    if (currentRoomCode) {
      emit('rejoin-room', { roomCode: currentRoomCode, clientId }).then((res) => {
        if (res.error) {
          currentRoomCode = null;
          clearRoomCache();
          history.replaceState(null, '', location.pathname);
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
      const head = `
        <div class="reveal-head">
          <span class="team-dot"></span>
          <strong>Команда ${key === 'A' ? 'А' : 'Б'}</strong>
          <span class="reveal-code-display mono">${r.code ? r.code.join('-') : (isLoneCard ? '—' : '?-?-?')}</span>
        </div>
      `;

      if (isLoneCard) {
        // соло-команда не загадывает код — единственный итог для неё:
        // удался ли перехват кода соперника
        const otherKey = key === 'A' ? 'B' : 'A';
        const intercepted = byKey[otherKey] ? byKey[otherKey].interceptCorrect : false;
        return `
          <div class="reveal-team team-${key.toLowerCase()}">
            ${head}
            <div class="reveal-line">
              <span class="reveal-line-label">Перехват кода соперника</span>
              <span class="reveal-verdict ${intercepted ? 'tag-ok' : 'tag-fail'}">${intercepted ? '🎯 Удался' : '❌ Не удался'}</span>
            </div>
          </div>
        `;
      }

      const interceptLine = view.loneTeam ? '' : `
        <div class="reveal-line">
          <span class="reveal-line-label">Перехват соперника</span>
          <span class="digit-row">${digitChips(r.interceptGuess, r.interceptCorrect)}</span>
          <span class="reveal-verdict ${r.interceptCorrect ? 'tag-fail' : 'tag-ok'}">${r.interceptCorrect ? 'Удался' : 'Не удался'}</span>
        </div>
      `;

      return `
        <div class="reveal-team team-${key.toLowerCase()}">
          ${head}
          <div class="reveal-line">
            <span class="reveal-line-label">Своя расшифровка</span>
            <span class="digit-row">${digitChips(r.ownGuess, r.ownCorrect)}</span>
            <span class="reveal-verdict ${r.ownCorrect ? 'tag-ok' : 'tag-fail'}">${r.ownCorrect ? 'Верно' : 'Ошибка'}</span>
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

  function renderHistory(view, tv) {
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

    $('#history-content').innerHTML = rounds.map(([roundNum, teams]) => `
      <div class="history-round">
        <div class="h-round-num">Раунд ${roundNum}</div>
        ${[tv.myTeamKey, oppTeamKey].map((key) => {
          const h = teams[key];
          if (!h) return '';
          // interceptCorrect в СВОЕЙ истории команды означает «нас перехватили»;
          // чтобы показать «мы перехватили», берём эту же отметку из истории
          // команды-соперника за тот же раунд (там она означает «эта команда
          // была перехвачена нами»)
          const otherKey = key === 'A' ? 'B' : 'A';
          const weIntercepted = teams[otherKey] ? teams[otherKey].interceptCorrect : false;
          const isLoneTeam = view.loneTeam === key;
          // у команды из двух, если соперник — соло-игрок, перехватывать
          // нечего (у соло нет кода) — эта строка для неё бессмысленна
          const isDuoVsSoloOpponent = view.loneTeam && !isLoneTeam;
          const codeDisplay = h.code ? h.code.join('-') : (isLoneTeam ? '—' : '?-?-?');
          return `
            <div class="h-team-block team-${key.toLowerCase()}">
              <div class="h-team-head">
                <span class="team-dot"></span>
                <span>Команда ${key === 'A' ? 'А' : 'Б'}</span>
                <span class="mono h-code">${codeDisplay}</span>
              </div>
              ${isLoneTeam ? '' : `<div class="h-clues">${(h.clues || []).map(escapeHtml).join(' · ')}</div>`}
              <div class="h-verdicts">
                ${isLoneTeam ? '' : `<span class="${h.ownCorrect ? 'tag-ok' : 'tag-fail'}">${h.ownCorrect ? '✅ своя верна' : '❌ своя ошибочна'}</span>`}
                ${isDuoVsSoloOpponent ? '' : `<span class="${weIntercepted ? 'tag-ok' : 'tag-fail'}">${weIntercepted ? '🎯 перехват удался' : '❌ перехват не удался'}</span>`}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `).join('') || '<p class="hint-text">Пока нет истории</p>';
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

  function renderAssocTables(view, tv) {
    const oppTeamKey = tv.myTeamKey === 'A' ? 'B' : 'A';
    const mineRows = buildAssocRows(tv.history.mine || []);
    const oppRows = buildAssocRows(tv.history.opponent || []);

    const mineSection = view.loneTeam === tv.myTeamKey
      ? '<p class="hint-text">Ваша команда не загадывает слова</p>'
      : renderAssocTable(mineRows);
    const oppSection = view.loneTeam === oppTeamKey
      ? '<p class="hint-text">У соперника нет своих слов</p>'
      : renderAssocTable(oppRows);

    $('#assoc-content').innerHTML = `
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

  $('#btn-toggle-history').addEventListener('click', () => {
    state.historyOpen = !state.historyOpen;
    $('#history-panel').hidden = !state.historyOpen;
  });
  $('#btn-close-history').addEventListener('click', () => {
    state.historyOpen = false;
    $('#history-panel').hidden = true;
  });

  // ---------- ЭКРАН: конец игры ----------
  function renderFinished(view) {
    const won = view.me?.team && view.winner === view.me.team;
    $('#finished-title').textContent = won ? 'Победа! 🎉' : (view.me?.team ? 'Поражение' : 'Игра окончена');
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
    if (view.status === 'lobby') {
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
