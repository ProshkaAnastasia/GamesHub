// Файловое хранилище комнат — переживает перезапуск процесса/контейнера.
// Ничего внешнего (БД) не подключаем: масштаб игры небольшой, обычный
// JSON-файл на комнату вполне справляется.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'rooms');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function roomFilePath(code) {
  return path.join(DATA_DIR, `${code}.json`);
}

function saveRoom(room) {
  try {
    ensureDir();
    const target = roomFilePath(room.code);
    const tmp = `${target}.tmp`;
    // пишем во временный файл и переименовываем — чтобы падение процесса
    // посреди записи не оставило комнату с битым JSON
    fs.writeFileSync(tmp, JSON.stringify(room));
    fs.renameSync(tmp, target);
  } catch (e) {
    console.error('Не удалось сохранить комнату', room.code, e);
  }
}

function deleteRoom(code) {
  try {
    fs.unlinkSync(roomFilePath(code));
  } catch (e) {
    // файла могло и не быть — не критично
  }
}

function loadAllRoomData() {
  ensureDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const result = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
      result.push(JSON.parse(raw));
    } catch (e) {
      console.error('Не удалось прочитать сохранённую комнату', file, e);
    }
  }
  return result;
}

module.exports = { saveRoom, deleteRoom, loadAllRoomData };
