// Реестр модулей. Специфичные игровые действия также регистрируются
// делегатами Room, socket-событиями и валидаторами payload.
const decoder = require('./decoder');
const ttr = require('./ttr');
const codenames = require('./codenames');
const carcassonne = require('./carcassonne');
const battleship = require('./battleship');
const sixnimmt = require('./sixnimmt');
const cryptid = require('./cryptid');
const railroad = require('./railroad');
const monopoly = require('./monopoly');

const GAME_MODULES = {
  [decoder.id]: decoder,
  [ttr.id]: ttr,
  [codenames.id]: codenames,
  [carcassonne.id]: carcassonne,
  [battleship.id]: battleship,
  [sixnimmt.id]: sixnimmt,
  [cryptid.id]: cryptid,
  [railroad.id]: railroad,
  [monopoly.id]: monopoly,
};

const DEFAULT_GAME_TYPE = decoder.id;

// краткий список для клиента (переключатель типа игры в лобби) — teamKeys
// и startRequirementText нужны клиенту, чтобы решить, показывать ли блок
// выбора команд, или сразу кнопку «Начать» (см. renderLobby в app.js)
const GAME_LIST = Object.values(GAME_MODULES).map(m => ({
  id: m.id,
  label: m.label,
  teamKeys: m.teamKeys,
  autoAssignTeams: !!m.autoAssignTeams,
  startRequirementText: m.startRequirementText,
}));

module.exports = { GAME_MODULES, GAME_LIST, DEFAULT_GAME_TYPE };
