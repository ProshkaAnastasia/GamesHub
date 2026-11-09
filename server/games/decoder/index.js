// Модуль игры «Декодер» — самодостаточный: всё, что специфично для правил
// именно этой игры (команды, коды, подсказки, тай-брейк), живёт здесь.
// Room (см. ../../game.js) знает только про общий контракт модуля:
//   id, label, teamKeys, canStart(teamOrder), startRequirementText,
//   create(players, teamOrder, usedWords), fromData(data, players, teamOrder, usedWords)
// и про интерфейс самого экземпляра игры: submitClues/updateGuessDraft/
// lockGuess/updateTiebreakGuess/lockTiebreakGuess/nextRound/
// canPlayerLeaveSafely/viewFor/toJSON/getArchiveSummary/finished/winner/winReason.
const { drawTeamWords, WORDS, shuffle } = require('./words');

const TEAMS = ['A', 'B'];
const OTHER = { A: 'B', B: 'A' };
const CLUE_TIME_MS = 90 * 1000;
const REVEAL_TIME_MS = 10000;
const NORMAL_ROUND_LIMIT = 8; // если за это число раундов никто не проиграл — ничья
const SOLO_ROUND_LIMIT = 5; // на троих: перехватчику даётся ровно столько раундов

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

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function labelTeam(t) {
  return t === 'A' ? 'А' : 'Б';
}

function freshTeamState() {
  return {
    words: [],
    encryptorIndex: -1,
    interceptions: 0,
    miscommunications: 0,
    history: [], // {round, code, clues, ownGuess, ownCorrect, interceptGuess, interceptCorrect}
    current: null, // {code, clues, ownGuess(draft), ownLocked, interceptGuess(draft-by-other-team), interceptLocked}
  };
}

// В лобби общий игрок занимает отдельный слот AB, в партии входит в обе команды.
function isSharedSetup(teamOrder) {
  return ['A', 'B', 'AB'].every(t => (teamOrder[t] || []).length === 1)
    && new Set(['A', 'B', 'AB'].flatMap(t => teamOrder[t])).size === 3;
}

class DecoderGame {
  constructor(players, teamOrder, usedWords) {
    // players и teamOrder — общие с Room ссылки (не копии): состав команд и
    // подключённость игроков читаем напрямую оттуда, ничего не дублируем
    this.players = players;
    this.teamOrder = teamOrder;
    this.usedWords = usedWords;
    this.teams = { A: freshTeamState(), B: freshTeamState() };
    this.round = 0;
    this.phase = null; // clue-giving | guessing | reveal | tiebreak
    this.clueDeadline = null;
    this.revealDeadline = null;
    this.tiebreak = null;
    this.winner = null;
    this.winReason = null;
    this.loneTeam = null; // только для восстановления старого режима 2 против 1
    this.sharedPlayerId = null;
    this.finished = false;
  }

  static canStart(teamOrder, players) {
    const count = [...(players?.values() || [])].filter(p => p.connected).length;
    return count >= 3 && count <= 8;
  }

  static assignTeams(players) {
    const ids = shuffle([...players.values()].filter(p => p.connected).map(p => p.id));
    const order = ids.length === 3
      ? { A: [ids[0]], B: [ids[1]], AB: [ids[2]] }
      : { A: ids.slice(0, Math.ceil(ids.length / 2)), B: ids.slice(Math.ceil(ids.length / 2)) };
    for (const player of players.values()) {
      player.team = Object.keys(order).find(t => order[t].includes(player.id)) || null;
      player.role = player.team ? 'player' : 'spectator';
    }
    return order;
  }

  static create(players, teamOrder, usedWords) {
    const game = new DecoderGame(players, teamOrder, usedWords);
    game.sharedPlayerId = isSharedSetup(teamOrder) ? teamOrder.AB[0] : null;
    if (usedWords.size + 8 > WORDS.length) usedWords.clear();
    const { teamA, teamB } = drawTeamWords(4, usedWords);
    [...teamA, ...teamB].forEach(w => usedWords.add(w));
    game.teams.A.words = teamA;
    game.teams.B.words = teamB;

    game.startRound();
    return game;
  }

  static fromData(data, players, teamOrder, usedWords) {
    const game = new DecoderGame(players, teamOrder, usedWords);
    game.teams = data.teams;
    game.round = data.round;
    game.phase = data.phase;
    game.clueDeadline = data.clueDeadline;
    game.revealDeadline = data.revealDeadline;
    game.tiebreak = data.tiebreak || null;
    game.winner = data.winner;
    game.winReason = data.winReason;
    game.loneTeam = data.loneTeam || null;
    game.sharedPlayerId = data.sharedPlayerId || null;
    game.finished = !!data.finished;
    return game;
  }

  toJSON() {
    return {
      teams: this.teams,
      round: this.round,
      phase: this.phase,
      clueDeadline: this.clueDeadline,
      revealDeadline: this.revealDeadline,
      tiebreak: this.tiebreak,
      winner: this.winner,
      winReason: this.winReason,
      loneTeam: this.loneTeam,
      sharedPlayerId: this.sharedPlayerId,
      finished: this.finished,
    };
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
      const order = this.teamOrder[t] || [];
      team.encryptorIndex = order.length ? (team.encryptorIndex + 1) % order.length : -1;
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

  getTeamOrder(team) {
    const order = this.teamOrder[team] || [];
    return this.sharedPlayerId ? [...order, this.sharedPlayerId] : order;
  }

  getPlayerTeam(playerId) {
    if (playerId !== this.sharedPlayerId) return this.players.get(playerId)?.team;
    const encryptingTeam = this.round % 2 ? 'A' : 'B';
    return this.phase === 'clue-giving' ? encryptingTeam : OTHER[encryptingTeam];
  }

  getEncryptorId(team) {
    if (this.sharedPlayerId) {
      const sharedEncrypts = team === (this.round % 2 ? 'A' : 'B');
      return sharedEncrypts ? this.sharedPlayerId : this.teamOrder[team][0];
    }
    const order = this.teamOrder[team] || [];
    const idx = this.teams[team].encryptorIndex;
    if (idx < 0 || !order.length) return null;
    return order[idx % order.length];
  }

  // может ли команда сейчас продолжать раунд без вернувшегося игрока:
  // - на подсказках критично только отключение самого шифровальщика (пока он не сдал подсказки)
  // - на отгадывании критично, если в команде осталось меньше 2 онлайн-игроков
  //   (шифровальщик не может разгадывать свой же код, так что одного оставшегося недостаточно)
  teamBlockedInfo(teamKey) {
    const order = this.getTeamOrder(teamKey);
    const members = order.map(pid => this.players.get(pid)).filter(Boolean);
    const encryptorId = this.getEncryptorId(teamKey);
    const team = this.teams[teamKey];

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
  // на фазе результата (между раундами) и на фазе подсказок — если он не
  // шифровальщик; небезопасно, если он шифровальщик, ещё не сдавший
  // подсказки, или если без него в команде на отгадывании останется
  // меньше 2 игроков онлайн
  canPlayerLeaveSafely(playerId) {
    const player = this.players.get(playerId);
    if (!player || !player.team) return { safe: true, reason: null };

    const playerTeam = this.getPlayerTeam(playerId);
    const team = this.teams[playerTeam];
    const encryptorId = this.getEncryptorId(playerTeam);
    const order = this.getTeamOrder(playerTeam);

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
      const connectedCount = order.filter(pid => this.players.get(pid)?.connected).length;
      if (connectedCount <= minNeeded) {
        return { safe: false, reason: 'Без вас в команде некому будет закончить раунд — дождитесь конца раунда' };
      }
    }

    return { safe: true, reason: null };
  }

  submitClues(playerId, clues) {
    const storedPlayer = this.players.get(playerId);
    const player = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
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
    const storedPlayer = this.players.get(playerId);
    const player = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'guessing') return { error: 'Сейчас не время догадок' };
    if (kind === 'intercept' && playerId === this.sharedPlayerId) return { error: 'Общий игрок не участвует в перехватах' };
    if (kind === 'own' && playerId === this.getEncryptorId(player.team)) {
      return { error: 'Шифровальщик не разгадывает свой же код' };
    }
    const myTeam = this.teams[player.team];
    if (!Array.isArray(guess) || guess.length !== 3) return { error: 'Нужно 3 цифры' };
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
    const storedPlayer = this.players.get(playerId);
    const player = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (this.phase !== 'guessing') return { error: 'Сейчас не время догадок' };
    if (kind === 'intercept' && playerId === this.sharedPlayerId) return { error: 'Общий игрок не участвует в перехватах' };
    if (kind === 'own' && playerId === this.getEncryptorId(player.team)) {
      return { error: 'Шифровальщик не подтверждает разгадку своего же кода' };
    }
    const myTeam = this.teams[player.team];
    if (!['own', 'intercept'].includes(kind)) return { error: 'Неверный тип ответа' };
    const guessArr = kind === 'own' ? myTeam.current.ownGuess : myTeam.current.interceptGuess;
    if (guessArr.some(v => !Number.isInteger(v) || v < 1 || v > 4) || new Set(guessArr).size !== 3) {
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
      this.finished = true;
      this.winner = this.loneTeam;
      this.winReason = `Перехватчик набрал 2 очка перехвата к раунду ${this.round}`;
    } else if (this.round >= SOLO_ROUND_LIMIT) {
      this.finished = true;
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
          this.finished = true;
          this.winner = OTHER[t];
          this.winReason = `Команда ${labelTeam(t)} дважды не смогла расшифровать свой же код`;
        } else if (flags[t].win) {
          this.finished = true;
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
      this.finished = true;
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
    const storedPlayer = this.players.get(playerId);
    const player = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (playerId === this.sharedPlayerId) return { error: 'Общий игрок знает слова обеих команд и не участвует в тай-брейке' };
    if (this.phase !== 'tiebreak') return { error: 'Сейчас не тай-брейк' };
    if (this.tiebreak.locked[player.team]) return { error: 'Ответ вашей команды уже подтверждён' };
    if (!Array.isArray(words) || words.length !== 4) return { error: 'Нужно 4 слова' };
    this.tiebreak.guesses[player.team] = words.map(w => (w || '').trim().slice(0, 30));
    return { ok: true };
  }

  lockTiebreakGuess(playerId) {
    const storedPlayer = this.players.get(playerId);
    const player = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
    if (!player || !player.team) return { error: 'Вы не в команде' };
    if (playerId === this.sharedPlayerId) return { error: 'Общий игрок знает слова обеих команд и не участвует в тай-брейке' };
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

    this.finished = true;
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
    if (this.phase !== 'reveal' || this.finished) return { error: 'Рано' };
    this.startRound();
    return { ok: true };
  }

  // моментальный снимок для архива «прошлых игр» — вызывается один раз,
  // прямо перед тем как Room создаст новый экземпляр игры (playAgain)
  getArchiveSummary() {
    return {
      loneTeam: this.loneTeam,
      sharedPlayerId: this.sharedPlayerId,
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
    };
  }

  // строит игровую часть персонального представления для конкретного
  // игрока — Room примешивает это к общим полям комнаты (код, статус, чат…)
  viewFor(playerId) {
    const storedPlayer = this.players.get(playerId);
    const me = storedPlayer && { ...storedPlayer, team: this.getPlayerTeam(playerId) };
    const base = {
      round: this.round,
      phase: this.phase,
      clueDeadline: this.phase === 'clue-giving' ? this.clueDeadline : null,
      revealDeadline: this.phase === 'reveal' ? this.revealDeadline : null,
      loneTeam: this.loneTeam,
      sharedPlayerId: this.sharedPlayerId,
      winner: this.winner,
      winReason: this.winReason,
      scoreboard: {
        A: { interceptions: this.teams.A.interceptions, miscommunications: this.teams.A.miscommunications },
        B: { interceptions: this.teams.B.interceptions, miscommunications: this.teams.B.miscommunications },
      },
    };

    if (!me || !me.team) return { ...base, teamView: null };

    const myTeam = this.teams[me.team];
    const oppTeamKey = OTHER[me.team];
    const oppTeam = this.teams[oppTeamKey];
    const isEncryptor = this.getEncryptorId(me.team) === playerId;

    const teamView = {
      myTeamKey: me.team,
      isSharedPlayer: playerId === this.sharedPlayerId,
      partnerGuesses: playerId === this.sharedPlayerId && this.phase === 'guessing'
        ? ['A', 'B'].map(team => {
          const partnerId = this.teamOrder[team][0];
          const current = this.teams[team].current;
          return {
            team, name: this.players.get(partnerId)?.name || '',
            ownGuess: partnerId !== this.getEncryptorId(team) ? current.ownGuess : null,
            ownLocked: current.ownLocked,
            interceptGuess: current.interceptGuess,
            interceptLocked: current.interceptLocked,
          };
        }) : null,
      myWords: myTeam.words,
      // слова соперника — секрет, пока игра не окончена; на финальном
      // экране прятать их больше не от кого
      oppWords: this.finished ? oppTeam.words : null,
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
      interceptGuess: playerId !== this.sharedPlayerId && myTeam.current ? myTeam.current.interceptGuess : null,
      interceptLocked: myTeam.current ? myTeam.current.interceptLocked : false,
      oppSubmittedClues: !!(oppTeam.current && oppTeam.current.clues),
      mySubmittedClues: !!(myTeam.current && myTeam.current.clues),
      oppOwnLocked: oppTeam.current ? oppTeam.current.ownLocked : false,
      oppInterceptLocked: oppTeam.current ? oppTeam.current.interceptLocked : false,
      // После завершения раунда обе команды видят настоящий код.
      history: {
        mine: myTeam.history,
        opponent: oppTeam.history,
      },
      lastReveal: this.phase === 'reveal' ? {
        mine: myTeam.history[myTeam.history.length - 1],
        opponent: oppTeam.history[oppTeam.history.length - 1],
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
}

module.exports = {
  minPlayers: 3,
  maxPlayers: 8,
  id: 'decoder',
  label: 'Декодер',
  teamKeys: TEAMS,
  sharedTeamKey: 'AB',
  autoAssignTeams: true,
  assignTeams: DecoderGame.assignTeams,
  startRequirementText: 'Нужно от 3 до 8 игроков онлайн. Команды и общий игрок выбираются случайно при старте',
  REVEAL_TIME_MS,
  canStart: DecoderGame.canStart,
  create: DecoderGame.create,
  fromData: DecoderGame.fromData,
};
