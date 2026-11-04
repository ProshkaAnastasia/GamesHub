// Реестр доступных типов игр — чтобы добавить новую игру, достаточно
// написать самодостаточный модуль (по образцу ./decoder) и добавить его
// сюда одной строкой; ни Room, ни server.js трогать для этого не нужно.
const decoder = require('./decoder');
const ttr = require('./ttr');
const codenames = require('./codenames');
const carcassonne = require('./carcassonne');
const battleship = require('./battleship');

const GAME_MODULES = {
  [decoder.id]: decoder,
  [ttr.id]: ttr,
  [codenames.id]: codenames,
  [carcassonne.id]: carcassonne,
  [battleship.id]: battleship,
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
