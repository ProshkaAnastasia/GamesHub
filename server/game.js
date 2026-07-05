const { drawTeamWords, WORDS, shuffle } = require('./words');
const store = require('./store');

const TEAMS = ['A', 'B'];
const OTHER = { A: 'B', B: 'A' };
const CLUE_TIME_MS = 90 * 1000;
const REVEAL_TIME_MS = 10000;
const NORMAL_ROUND_LIMIT = 8; // если за это число раундов никто не проиграл — ничья
const SOLO_ROUND_LIMIT = 5; // на троих: перехватчику даётся ровно столько раундов

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов
  let code = '';
  for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function randomCode(history) {
  // код — 3 различные цифры из {1,2,3,4} в случайном порядке,
  // не повторяющие точь-в-точь уже использованный код этой команды
  const used = new Set(history.map(h => h.code.join('')));
  let attempt;
  let guard = 0;
  do {
    attempt = shuffle([1, 2, 3, 4]).slice(0, 3);
    guard++;
  } while (used.has(attempt.join('')) && guard < 50);
  return attempt;
}

class Room {
  constructor(code) {
    this.code = code;
    this.createdAt = Date.now();
    this.hostId = null;
    this.players = new Map(); // id -> {id, name, team, connected}
    this.status = 'lobby'; // lobby | playing | finished
    this.round = 0;
    this.phase = null; // clue-giving | guessing | reveal | tiebreak
    this.clueDeadline = null;
    this.revealDeadline = null;
    // финальный тай-брейк (ничья даже по счёту) — каждая команда пытается
    // угадать все 4 слова соперника; { guesses: {A,B}, locked: {A,B}, result }
    this.tiebreak = null;
    this.teams = {
      A: this.freshTeamState(),
      B: this.freshTeamState(),
    };
    this.winner = null;
    this.winReason = null;
    this.usedWords = new Set(); // слова, уже сыгранные в этой комнате — не повторяем, пока не закончатся все
    this.loneTeam = null; // при игре втроём: команда из одного игрока, который только перехватывает
    this.chat = []; // {id, playerId, name, team, text, ts} — общий чат комнаты, живёт дольше одной игры
    // архив завершённых игр в этой комнате — заполняется в playAgain(),
    // прежде чем состояние команд сбрасывается для новой партии; секретов
    // тут уже нет (игра окончена), поэтому храним данные как есть, без редактирования
    this.pastGames = [];
  }

  freshTeamState() {
    return {
      words: [],
      order: [], // player id order for encryptor rotation
      encryptorIndex: -1,
      interceptions: 0,
      miscommunications: 0,
      history: [], // {round, code, clues, ownGuess, ownCorrect, interceptGuess, interceptCorrect}
      current: null, // {code, clues, ownGuess(draft), ownLocked, interceptGuess(draft-by-other-team), interceptLocked}
    };
  }

  addPlayer(id, name) {
    const player = { id, name: name.slice(0, 20), team: null, connected: true };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id;
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    // если игра ещё в лобби — удаляем совсем
    if (this.status === 'lobby') {
      this.players.delete(id);
      TEAMS.forEach(t => {
        this.teams[t].order = this.teams[t].order.filter(pid => pid !== id);
      });
    }
    // хост, который не вернулся за grace-период, передаёт права следующему
    // онлайн-игроку — иначе комната зависла бы навсегда без возможности
    // нажать «начать игру» / «следующий раунд» / «играть ещё раз»
    if (this.hostId === id) {
      const others = [...this.players.values()].filter(p => p.id !== id);
      const online = others.find(p => p.connected);
      this.hostId = (online || others[0] || null)?.id ?? null;
    }
  }

  isEmpty() {
    return [...this.players.values()].every(p => !p.connected);
  }

  setConnected(id, connected) {
    const player = this.players.get(id);
    if (player) player.connected = connected;
  }

  // чат работает в любой момент жизни комнаты (лобби/игра/финал), не
  // привязан к конкретной партии — переживает «играть ещё раз»
  sendMessage(playerId, text) {
    const player = this.players.get(playerId);
    if (!player) return { error: 'Игрок не найден' };
    const trimmed = (text || '').trim().slice(0, 300);
    if (!trimmed) return { error: 'Пустое сообщение' };
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      playerId,
      name: player.name,
      team: player.team,
      text: trimmed,
      ts: Date.now(),
    };
    this.chat.push(message);
    // ограничиваем историю, чтобы комната не росла бесконечно
    if (this.chat.length > 200) this.chat = this.chat.slice(-200);
    return { ok: true, message };
  }

  setTeam(id, team) {
    if (this.status !== 'lobby') return { error: 'Игра уже началась' };
    if (!TEAMS.includes(team)) return { error: 'Неверная команда' };
    const player = this.players.get(id);
    if (!player) return { error: 'Игрок не найден' };
    // убрать из старой команды
    TEAMS.forEach(t => {
      this.teams[t].order = this.teams[t].order.filter(pid => pid !== id);
    });
    player.team = team;
    this.teams[team].order.push(id);
    return { ok: true };
  }

  // особый случай на троих: у одной команды 2 игрока (играют как обычно),
  // у другой — 1 (только перехватывает, свой код не загадывает)
  isDuoVsSoloSizes(sizes) {
    return sizes.includes(2) && sizes.includes(1);
  }

  canStart() {
    const sizes = TEAMS.map(t => this.teams[t].order.length);
    const normal = sizes.every(s => s >= 2 && s <= 4);
    return normal || this.isDuoVsSoloSizes(sizes);
  }

  startGame() {
    if (!this.canStart()) return { error: 'Нужно от 2 до 4 игроков в каждой команде (либо 2 и 1 — втроём)' };

    this.loneTeam = TEAMS.find(t => this.teams[t].order.length === 1 && this.teams[OTHER[t]].order.length === 2) || null;

    const neededWords = this.loneTeam ? 4 : 8;
    if (this.usedWords.size + neededWords > WORDS.length) this.usedWords.clear();
    if (this.loneTeam) {
      const wordTeam = OTHER[this.loneTeam];
      const { teamA } = drawTeamWords(4, this.usedWords);
      teamA.forEach(w => this.usedWords.add(w));
      this.teams[wordTeam].words = teamA;
      this.teams[this.loneTeam].words = [];
    } else {
      const { teamA, teamB } = drawTeamWords(4, this.usedWords);
      [...teamA, ...teamB].forEach(w => this.usedWords.add(w));
      this.teams.A.words = teamA;
      this.teams.B.words = teamB;
    }

    this.teams.A.interceptions = 0;
    this.teams.B.interceptions = 0;
    this.teams.A.miscommunications = 0;
    this.teams.B.miscommunications = 0;
    this.teams.A.history = [];
    this.teams.B.history = [];
    this.status = 'playing';
    this.round = 0;
    this.startRound();
    return { ok: true };
  }

  startRound() {
    this.round += 1;
    this.phase = 'clue-giving';
    this.clueDeadline = Date.now() + CLUE_TIME_MS;
    TEAMS.forEach(t => {
      const team = this.teams[t];
      if (t === this.loneTeam) {
        // соло-команда ничего не шифрует — у неё нет своего кода/подсказок,
        // decoding для несуществующего кода тоже не нужен (сразу «выполнен»);
        // единственная её задача — перехватить код команды из двух игроков
        team.encryptorIndex = -1;
        team.current = {
          code: null,
          clues: null,
          ownGuess: [null, null, null],
          ownLocked: true,
          interceptGuess: [null, null, null],
          interceptLocked: false,
        };
        return;
      }
      team.encryptorIndex = team.order.length ? (team.encryptorIndex + 1) % team.order.length : -1;
      // если соперник — соло-команда без своего кода, перехватывать нечего,
      // считаем это сразу выполненным
      const nothingToIntercept = this.loneTeam !== null && t === OTHER[this.loneTeam];
      team.current = {
        code: randomCode(team.history),
        clues: null,
        ownGuess: [null, null, null],
        ownLocked: false,
        interceptGuess: [null, null, null],
        interceptLocked: nothingToIntercept,
      };
    });
  }

  getEncryptorId(team) {
    const t = this.teams[team];
    if (t.encryptorIndex < 0 || !t.order.length) return null;
    return t.order[t.encryptorIndex % t.order.length];
  }

  // может ли команда сейчас продолжать раунд без вернувшегося игрока:
  // - на подсказках критично только отключение самого шифровальщика (пока он не сдал подсказки)
  // - на отгадывании критично, если в команде осталось меньше 2 онлайн-игроков
  //   (шифровальщик не может разгадывать свой же код, так что одного оставшегося недостаточно)
  teamBlockedInfo(teamKey) {
    const team = this.teams[teamKey];
    const members = team.order.map(pid => this.players.get(pid)).filter(Boolean);
    const encryptorId = this.getEncryptorId(teamKey);

    if (this.phase === 'clue-giving' && team.current && !team.current.clues) {
      const encryptor = this.players.get(encryptorId);
      if (encryptor && !encryptor.connected) {
        return { blocked: true, offlineName: encryptor.name };
      }
      return { blocked: false, offlineName: null };
    }

    if (this.phase === 'guessing') {
      // у соло-команды (играем втроём) по конструкции всегда только 1
      // игрок — этого достаточно, порог в 2 применим только к обычным командам
      const minNeeded = teamKey === this.loneTeam ? 1 : 2;
      const connectedCount = members.filter(p => p.connected).length;
      if (connectedCount < minNeeded) {
        const offline = members.find(p => !p.connected);
        return { blocked: true, offlineName: offline?.name || null };
      }
    }

    return { blocked: false, offlineName: null };
  }

  // можно ли игроку выйти прямо сейчас, не ломая текущий раунд для команды:
  // безопасно в лобби/по завершении игры, на фазе результата (между раундами),
  // и на фазе подсказок — если он не шифровальщик; небезопасно, если он
  // шифровальщик, ещё не сдавший подсказки, или если без него в команде
  // на отгадывании останется меньше 2 игроков онлайн
  canPlayerLeaveSafely(playerId) {
    if (this.status !== 'playing') return { safe: true, reason: null };
    const player = this.players.get(playerId);
    if (!player || !player.team) return { safe: true, reason: null };

    const team = this.teams[player.team];
    const encryptorId = this.getEncryptorId(player.team);

    if (this.phase === 'clue-giving' && team.current && !team.current.clues) {
      if (playerId === encryptorId) {
        return { safe: false, reason: 'Вы шифровальщик в этом раунде — дождитесь, пока передадите подсказки' };
      }
      return { safe: true, reason: null };
    }

    if (this.phase === 'guessing') {
      // соло-команда (играем втроём) состоит из одного игрока — ему вообще
      // некому передать эстафету, поэтому выходить небезопасно всегда
      const minNeeded = player.team === this.loneTeam ? 1 : 2;
      const connectedCount = team.order.filter(pid => this.players.get(pid)?.connected).length;
      if (connectedCount <= minNeeded) {
        return { safe: false, reason: 'Без вас в команде некому будет закончить раунд — дождитесь конца раунда' };
      }
    }

    return { safe: true, reason: null };
  }

  submitClues(playerId, clues) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'clue-giving') return { error: 'Сейчас не время подсказок' };
    const team = this.teams[player.team];
    if (this.getEncryptorId(player.team) !== playerId) return { error: 'Вы не шифровальщик в этом раунде' };
    if (!Array.isArray(clues) || clues.length !== 3 || clues.some(c => !c || !c.trim())) {
      return { error: 'Нужно ровно 3 подсказки' };
    }
    team.current.clues = clues.map(c => c.trim().slice(0, 60));
    this.maybeAdvanceToGuessing();
    return { ok: true };
  }

  maybeAdvanceToGuessing() {
    const ready = TEAMS.every(t => t === this.loneTeam || this.teams[t].current.clues);
    if (this.phase === 'clue-giving' && ready) {
      this.phase = 'guessing';
    }
  }

  updateGuessDraft(playerId, kind, guess) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'guessing') return { error: 'Сейчас не время догадок' };
    if (kind === 'own' && playerId === this.getEncryptorId(player.team)) {
      return { error: 'Шифровальщик не разгадывает свой же код' };
    }
    const myTeam = this.teams[player.team];
    const oppTeam = this.teams[OTHER[player.team]];
    const cleaned = [0, 1, 2].map(i => {
      const v = guess[i];
      return (v === null || v === undefined || v === '') ? null : Number(v);
    });
    if (kind === 'own') {
      if (myTeam.current.ownLocked) return { error: 'Ответ вашей команды уже подтверждён' };
      myTeam.current.ownGuess = cleaned;
    } else if (kind === 'intercept') {
      if (myTeam.current.interceptLocked) return { error: 'Ответ уже подтверждён' };
      myTeam.current.interceptGuess = cleaned;
    } else {
      return { error: 'Неверный тип ответа' };
    }
    return { ok: true };
  }

  lockGuess(playerId, kind) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'guessing') return { error: 'Сейчас не время догадок' };
    if (kind === 'own' && playerId === this.getEncryptorId(player.team)) {
      return { error: 'Шифровальщик не подтверждает разгадку своего же кода' };
    }
    const myTeam = this.teams[player.team];
    const guessArr = kind === 'own' ? myTeam.current.ownGuess : myTeam.current.interceptGuess;
    if (guessArr.some(v => v === null) || new Set(guessArr).size !== 3) {
      return { error: 'Выберите 3 разные цифры от 1 до 4' };
    }
    if (kind === 'own') myTeam.current.ownLocked = true;
    else if (kind === 'intercept') myTeam.current.interceptLocked = true;
    else return { error: 'Неверный тип ответа' };

    this.maybeReveal();
    return { ok: true };
  }

  maybeReveal() {
    if (this.phase !== 'guessing') return;
    const allLocked = TEAMS.every(t => this.teams[t].current.ownLocked && this.teams[t].current.interceptLocked);
    if (!allLocked) return;
    this.phase = 'reveal';

    TEAMS.forEach(t => {
      const team = this.teams[t];
      const opp = this.teams[OTHER[t]];
      const cur = team.current;
      // у соло-команды нет своего кода — расшифровывать её нечего
      const isLone = t === this.loneTeam;
      const ownCorrect = isLone ? null : arraysEqual(cur.ownGuess, cur.code);
      // opponent tried to intercept THIS team's code, stored on opp.current.interceptGuess
      const interceptCorrect = isLone ? null : arraysEqual(opp.current.interceptGuess, cur.code);

      if (!isLone) {
        if (this.loneTeam) {
          // на троих оба типа ошибок — по официальным правилам сольного
          // варианта — прямые очки перехватчику; собственного счёта у
          // команды из двух в этом режиме не бывает
          const loneTeamObj = this.teams[this.loneTeam];
          if (interceptCorrect) loneTeamObj.interceptions += 1;
          if (!ownCorrect) loneTeamObj.interceptions += 1;
        } else {
          if (!ownCorrect) team.miscommunications += 1;
          if (interceptCorrect) team.interceptions += 1; // перехвачена соперником
        }
      }

      team.history.push({
        round: this.round,
        code: cur.code,
        clues: cur.clues,
        ownGuess: cur.ownGuess,
        ownCorrect,
        interceptGuess: opp.current.interceptGuess,
        interceptCorrect,
      });
    });

    if (this.loneTeam) this.checkSoloEnd();
    else this.checkNormalEnd();

    // следующий раунд начинается автоматически через паузу — никто не жмёт
    // кнопку; если игра только что закончилась (или ушла в тай-брейк),
    // продолжать в обычном смысле некуда
    this.revealDeadline = this.phase === 'reveal' ? Date.now() + REVEAL_TIME_MS : null;
  }

  // на троих официальной ничьей не предусмотрено: либо перехватчик успевает
  // набрать 2 очка за отведённые раунды, либо по истечении лимита
  // автоматически побеждает команда
  checkSoloEnd() {
    const loneTeamObj = this.teams[this.loneTeam];
    const duoKey = OTHER[this.loneTeam];
    if (loneTeamObj.interceptions >= 2) {
      this.status = 'finished';
      this.winner = this.loneTeam;
      this.winReason = `Перехватчик набрал 2 очка перехвата к раунду ${this.round}`;
    } else if (this.round >= SOLO_ROUND_LIMIT) {
      this.status = 'finished';
      this.winner = duoKey;
      this.winReason = `Команда продержалась ${SOLO_ROUND_LIMIT} раундов — перехватчик не успел набрать 2 очка`;
    }
  }

  // обычный режим — если несколько условий выполняются одновременно (или
  // истёк лимит раундов) — это официальная ничья со своим каскадом разрешения
  checkNormalEnd() {
    const flags = {};
    for (const t of TEAMS) {
      flags[t] = {
        win: this.teams[OTHER[t]].interceptions >= 2, // T дважды перехватил соперника
        lose: this.teams[t].miscommunications >= 2, // T дважды не расшифровал свой код
      };
    }

    const selfConflicted = TEAMS.some(t => flags[t].win && flags[t].lose);
    const bothQualify = TEAMS.every(t => flags[t].win || flags[t].lose);
    const anyoneQualifies = TEAMS.some(t => flags[t].win || flags[t].lose);

    if (selfConflicted || bothQualify) {
      this.resolveTie(false);
    } else if (anyoneQualifies) {
      for (const t of TEAMS) {
        if (flags[t].lose) {
          this.status = 'finished';
          this.winner = OTHER[t];
          this.winReason = `Команда ${labelTeam(t)} дважды не смогла расшифровать свой же код`;
        } else if (flags[t].win) {
          this.status = 'finished';
          this.winner = t;
          this.winReason = `Команда ${labelTeam(t)} дважды перехватила код команды ${labelTeam(OTHER[t])}`;
        }
      }
    } else if (this.round >= NORMAL_ROUND_LIMIT) {
      this.resolveTie(true);
    }
  }

  // каскад разрешения ничьей: сперва по итоговому счёту (сделанные
  // перехваты минус свои недопонимания); если и он равный — финальный
  // тай-брейк: обе команды пытаются угадать все 4 слова соперника
  resolveTie(dueToRoundLimit) {
    const score = {};
    for (const t of TEAMS) {
      score[t] = this.teams[OTHER[t]].interceptions - this.teams[t].miscommunications;
    }
    if (score.A !== score.B) {
      this.status = 'finished';
      this.winner = score.A > score.B ? 'A' : 'B';
      this.winReason = `Ничья по основным условиям — победа по итоговому счёту (${score[this.winner]} против ${score[OTHER[this.winner]]})`;
      return;
    }
    this.startTiebreak(dueToRoundLimit);
  }

  // счёт тоже равный — переходим в специальную фазу: каждая команда вслепую
  // пытается угадать все 4 слова соперника (не порядок, а сами слова)
  startTiebreak(dueToRoundLimit) {
    this.phase = 'tiebreak';
    this.tiebreak = {
      dueToRoundLimit,
      guesses: { A: [null, null, null, null], B: [null, null, null, null] },
      locked: { A: false, B: false },
      result: null,
    };
  }

  updateTiebreakGuess(playerId, words) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'tiebreak') return { error: 'Сейчас не тай-брейк' };
    if (this.tiebreak.locked[player.team]) return { error: 'Ответ вашей команды уже подтверждён' };
    if (!Array.isArray(words) || words.length !== 4) return { error: 'Нужно 4 слова' };
    this.tiebreak.guesses[player.team] = words.map(w => (w || '').trim().slice(0, 30));
    return { ok: true };
  }

  lockTiebreakGuess(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'tiebreak') return { error: 'Сейчас не тай-брейк' };
    if (this.tiebreak.locked[player.team]) return { error: 'Ответ уже подтверждён' };
    const guess = this.tiebreak.guesses[player.team];
    if (guess.some(w => !w)) return { error: 'Заполните все 4 слова' };
    this.tiebreak.locked[player.team] = true;
    this.maybeResolveTiebreak();
    return { ok: true };
  }

  maybeResolveTiebreak() {
    if (!TEAMS.every(t => this.tiebreak.locked[t])) return;

    // сколько слов из угадывающего списка реально встречаются в списке
    // соперника (без учёта порядка, без повторного зачёта одного слова дважды)
    const countMatches = (guessArr, actualWords) => {
      const pool = actualWords.map(w => w.toLowerCase());
      let count = 0;
      for (const g of guessArr) {
        const idx = pool.indexOf((g || '').toLowerCase());
        if (idx !== -1) { count++; pool.splice(idx, 1); }
      }
      return count;
    };

    const scoreA = countMatches(this.tiebreak.guesses.A, this.teams.B.words);
    const scoreB = countMatches(this.tiebreak.guesses.B, this.teams.A.words);
    this.tiebreak.result = { A: scoreA, B: scoreB };

    this.status = 'finished';
    if (scoreA > scoreB) {
      this.winner = 'A';
      this.winReason = `Ничья по счёту — в тай-брейке команда А угадала ${scoreA} из 4 слов соперника, Б — ${scoreB} из 4`;
    } else if (scoreB > scoreA) {
      this.winner = 'B';
      this.winReason = `Ничья по счёту — в тай-брейке команда Б угадала ${scoreB} из 4 слов соперника, А — ${scoreA} из 4`;
    } else {
      this.winner = 'draw';
      this.winReason = `Ничья даже в тай-брейке (обе команды угадали по ${scoreA} из 4) — победа разделена`;
    }
  }

  nextRound() {
    if (this.phase !== 'reveal' || this.status === 'finished') return { error: 'Рано' };
    this.startRound();
    return { ok: true };
  }

  playAgain() {
    if (this.status !== 'finished') return { error: 'Игра ещё не окончена' };
    // архивируем только что законченную партию, прежде чем стереть её —
    // чтобы к ней можно было вернуться позже через «Прошлые игры»
    this.pastGames.push({
      gameNumber: this.pastGames.length + 1,
      finishedAt: Date.now(),
      winner: this.winner,
      winReason: this.winReason,
      loneTeam: this.loneTeam,
      teams: {
        A: {
          words: this.teams.A.words,
          history: this.teams.A.history,
          interceptions: this.teams.A.interceptions,
          miscommunications: this.teams.A.miscommunications,
        },
        B: {
          words: this.teams.B.words,
          history: this.teams.B.history,
          interceptions: this.teams.B.interceptions,
          miscommunications: this.teams.B.miscommunications,
        },
      },
      tiebreak: this.tiebreak,
    });
    TEAMS.forEach(t => {
      const order = this.teams[t].order;
      this.teams[t] = this.freshTeamState();
      this.teams[t].order = order;
    });
    this.status = 'lobby';
    this.round = 0;
    this.phase = null;
    this.clueDeadline = null;
    this.revealDeadline = null;
    this.tiebreak = null;
    this.winner = null;
    this.winReason = null;
    this.loneTeam = null;
    return { ok: true };
  }

  // строит персональное представление состояния для конкретного игрока
  viewFor(playerId) {
    const me = this.players.get(playerId);
    const playersList = [...this.players.values()].map(p => ({
      id: p.id, name: p.name, team: p.team, connected: p.connected, isHost: p.id === this.hostId,
    }));

    const base = {
      code: this.code,
      status: this.status,
      round: this.round,
      phase: this.phase,
      clueDeadline: this.phase === 'clue-giving' ? this.clueDeadline : null,
      revealDeadline: this.phase === 'reveal' ? this.revealDeadline : null,
      loneTeam: this.loneTeam,
      chat: this.chat,
      pastGames: this.pastGames,
      players: playersList,
      hostId: this.hostId,
      me: me ? { id: me.id, name: me.name, team: me.team, isHost: me.id === this.hostId } : null,
      canStart: this.status === 'lobby' ? this.canStart() : false,
      canLeaveSafely: this.canPlayerLeaveSafely(playerId),
      winner: this.winner,
      winReason: this.winReason,
      scoreboard: this.status === 'lobby' ? null : {
        A: { interceptions: this.teams.A.interceptions, miscommunications: this.teams.A.miscommunications },
        B: { interceptions: this.teams.B.interceptions, miscommunications: this.teams.B.miscommunications },
      },
    };

    if (this.status === 'lobby' || !me || !me.team) return { ...base, teamView: null };

    const myTeam = this.teams[me.team];
    const oppTeamKey = OTHER[me.team];
    const oppTeam = this.teams[oppTeamKey];
    const isEncryptor = this.getEncryptorId(me.team) === playerId;

    const teamView = {
      myTeamKey: me.team,
      myWords: myTeam.words,
      // слова соперника — секрет, пока игра не окончена; на финальном
      // экране прятать их больше не от кого
      oppWords: this.status === 'finished' ? oppTeam.words : null,
      isEncryptor,
      encryptorName: this.players.get(this.getEncryptorId(me.team))?.name || null,
      encryptorConnected: this.players.get(this.getEncryptorId(me.team))?.connected ?? true,
      oppEncryptorName: this.players.get(this.getEncryptorId(oppTeamKey))?.name || null,
      oppEncryptorConnected: this.players.get(this.getEncryptorId(oppTeamKey))?.connected ?? true,
      myTeamBlocked: this.teamBlockedInfo(me.team),
      oppTeamBlocked: this.teamBlockedInfo(oppTeamKey),
      myCode: (isEncryptor && myTeam.current) ? myTeam.current.code : null,
      clues: myTeam.current && oppTeam.current ? {
        mine: myTeam.current.clues,
        opponent: oppTeam.current.clues,
      } : null,
      ownGuess: myTeam.current ? myTeam.current.ownGuess : null,
      ownLocked: myTeam.current ? myTeam.current.ownLocked : false,
      interceptGuess: myTeam.current ? myTeam.current.interceptGuess : null,
      interceptLocked: myTeam.current ? myTeam.current.interceptLocked : false,
      oppSubmittedClues: !!(oppTeam.current && oppTeam.current.clues),
      mySubmittedClues: !!(myTeam.current && myTeam.current.clues),
      oppOwnLocked: oppTeam.current ? oppTeam.current.ownLocked : false,
      oppInterceptLocked: oppTeam.current ? oppTeam.current.interceptLocked : false,
      // игра окончена — прятать больше нечего и незачем, отдаём полную
      // историю соперника как есть (реальные коды каждого раунда)
      history: {
        mine: myTeam.history,
        opponent: this.status === 'finished' ? oppTeam.history : oppTeam.history.map(redactCodeIfUnknown),
      },
      lastReveal: this.phase === 'reveal' ? {
        mine: myTeam.history[myTeam.history.length - 1],
        opponent: redactCodeIfUnknown(oppTeam.history[oppTeam.history.length - 1]),
      } : null,
      // тай-брейк: до подтверждения обеих команд слова соперника не видны —
      // отдаём только черновик СВОЕЙ команды и статус блокировки соперника
      tiebreak: this.tiebreak ? {
        dueToRoundLimit: this.tiebreak.dueToRoundLimit,
        myGuess: this.tiebreak.guesses[me.team],
        // чужая догадка (и слова, по которым её можно проверить) раскрываются
        // только после того, как обе команды подтвердили ответ
        oppGuess: this.tiebreak.result ? this.tiebreak.guesses[oppTeamKey] : null,
        myLocked: this.tiebreak.locked[me.team],
        oppLocked: this.tiebreak.locked[oppTeamKey],
        result: this.tiebreak.result,
        oppWords: this.tiebreak.result ? oppTeam.words : null,
      } : null,
    };

    return { ...base, teamView };
  }

  // сериализация для сохранения на диск (JSON.stringify сам вызовет этот
  // метод) — players и usedWords переводим в обычные массивы
  toJSON() {
    return {
      code: this.code,
      createdAt: this.createdAt,
      hostId: this.hostId,
      players: [...this.players.values()],
      status: this.status,
      round: this.round,
      phase: this.phase,
      clueDeadline: this.clueDeadline,
      revealDeadline: this.revealDeadline,
      tiebreak: this.tiebreak,
      teams: this.teams,
      winner: this.winner,
      winReason: this.winReason,
      usedWords: [...this.usedWords],
      loneTeam: this.loneTeam,
      chat: this.chat,
      pastGames: this.pastGames,
    };
  }

  // восстановление комнаты из сохранённых данных (после перезапуска сервера)
  static fromData(data) {
    const room = new Room(data.code);
    room.createdAt = data.createdAt;
    room.hostId = data.hostId;
    // после перезапуска ни у кого ещё нет живого сокета — все офлайн,
    // пока не переподключатся (клиент делает это автоматически по clientId)
    room.players = new Map((data.players || []).map(p => [p.id, { ...p, connected: false }]));
    room.status = data.status;
    room.round = data.round;
    room.phase = data.phase;
    room.clueDeadline = data.clueDeadline;
    room.revealDeadline = data.revealDeadline;
    room.tiebreak = data.tiebreak || null;
    room.teams = data.teams;
    room.winner = data.winner;
    room.winReason = data.winReason;
    room.usedWords = new Set(data.usedWords || []);
    room.loneTeam = data.loneTeam || null;
    room.chat = data.chat || [];
    room.pastGames = data.pastGames || [];
    return room;
  }
}

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// если команда сама не расшифровала свой код И соперник её не перехватил —
// никто не подтвердил верную последовательность, поэтому сопернику код не
// показываем, только то, что попытка перехвата не удалась
function redactCodeIfUnknown(entry) {
  if (!entry) return entry;
  const codeConfirmed = entry.ownCorrect || entry.interceptCorrect;
  return codeConfirmed ? entry : { ...entry, code: null };
}

function labelTeam(t) {
  return t === 'A' ? 'А' : 'Б';
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    for (const data of store.loadAllRoomData()) {
      try {
        const room = Room.fromData(data);
        this.rooms.set(room.code, room);
      } catch (e) {
        console.error('Не удалось восстановить комнату', data && data.code, e);
      }
    }
  }

  createRoom() {
    let code;
    do { code = makeRoomCode(); } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  save(room) {
    store.saveRoom(room);
  }

  cleanup() {
    for (const [code, room] of this.rooms) {
      const age = Date.now() - room.createdAt;
      if (room.isEmpty() && age > 1000 * 60 * 30) {
        this.rooms.delete(code);
        store.deleteRoom(code);
      }
    }
  }

  // краткая сводка по всем «живым» комнатам (хотя бы один игрок онлайн) —
  // для окна со списком комнат на экране входа
  listSummaries() {
    return [...this.rooms.values()]
      .filter(room => !room.isEmpty())
      .map(room => ({
        code: room.code,
        status: room.status,
        round: room.round,
        playerCount: room.players.size,
        hostName: room.players.get(room.hostId)?.name || null,
        createdAt: room.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

module.exports = { Room, RoomManager, TEAMS, REVEAL_TIME_MS };
