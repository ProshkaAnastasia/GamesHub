// Реестр доступных типов игр — чтобы добавить новую игру, достаточно
// написать самодостаточный модуль (по образцу ./decoder) и добавить его
// сюда одной строкой; ни Room, ни server.js трогать для этого не нужно.
const decoder = require('./decoder');

const GAME_MODULES = {
  [decoder.id]: decoder,
};

const DEFAULT_GAME_TYPE = decoder.id;

// краткий список для клиента (переключатель типа игры в лобби)
const GAME_LIST = Object.values(GAME_MODULES).map(m => ({ id: m.id, label: m.label }));

module.exports = { GAME_MODULES, GAME_LIST, DEFAULT_GAME_TYPE };
