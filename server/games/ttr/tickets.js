// Полный официальный набор билетов-заданий Ticket to Ride Europe — 46 штук:
// 6 длинных (long: true, синяя рубашка в оригинале) + 40 обычных.
//
// Правило раздачи (важно соблюсти в движке, сейчас в index.js это ещё не
// разделено): длинные билеты — отдельная колода, тасуется отдельно, каждому
// игроку в начале сдаётся ровно 1 (можно вернуть, если не хочет оставлять).
// Все длинные билеты, не розданные при старте, окончательно убираются из
// игры и никогда не появляются позже. Колода для действия "взять билеты"
// в течение партии — это только обычные (short) билеты, длинные туда не
// возвращаются и не подмешиваются.
//
// Города сверены с id из map.js (Lisboa -> lisbon, Erzurum -> erzurim,
// Sevestopol — опечатка в источнике, исправлено на sevastopol).
const TICKETS = [
  // --- длинные (6) ---
  { from: 'brest', to: 'petrograd', points: 20, long: true },
  { from: 'cadiz', to: 'stockholm', points: 21, long: true },
  { from: 'edinburgh', to: 'athina', points: 21, long: true },
  { from: 'kobenhavn', to: 'erzurim', points: 21, long: true },
  { from: 'lisbon', to: 'danzig', points: 20, long: true },
  { from: 'palermo', to: 'moskva', points: 20, long: true },

  // --- обычные (40) ---
  { from: 'amsterdam', to: 'pamplona', points: 7, long: false },
  { from: 'amsterdam', to: 'wilno', points: 12, long: false },
  { from: 'angora', to: 'kharkov', points: 10, long: false },
  { from: 'athina', to: 'angora', points: 5, long: false },
  { from: 'athina', to: 'wilno', points: 11, long: false },
  { from: 'barcelona', to: 'bruxelles', points: 8, long: false },
  { from: 'barcelona', to: 'munchen', points: 8, long: false },
  { from: 'berlin', to: 'bucuresti', points: 8, long: false },
  { from: 'berlin', to: 'moskva', points: 12, long: false },
  { from: 'berlin', to: 'roma', points: 9, long: false },
  { from: 'brest', to: 'marseille', points: 7, long: false },
  { from: 'brest', to: 'venezia', points: 8, long: false },
  { from: 'bruxelles', to: 'danzig', points: 9, long: false },
  { from: 'budapest', to: 'sofia', points: 5, long: false },
  { from: 'edinburgh', to: 'paris', points: 7, long: false },
  { from: 'essen', to: 'kyiv', points: 10, long: false },
  { from: 'frankfurt', to: 'kobenhavn', points: 5, long: false },
  { from: 'frankfurt', to: 'smolensk', points: 13, long: false },
  { from: 'kyiv', to: 'petrograd', points: 6, long: false },
  { from: 'kyiv', to: 'sochi', points: 8, long: false },
  { from: 'london', to: 'berlin', points: 7, long: false },
  { from: 'london', to: 'wien', points: 10, long: false },
  { from: 'madrid', to: 'dieppe', points: 8, long: false },
  { from: 'madrid', to: 'zurich', points: 8, long: false },
  { from: 'marseille', to: 'essen', points: 8, long: false },
  { from: 'palermo', to: 'constantinople', points: 8, long: false },
  { from: 'paris', to: 'wien', points: 8, long: false },
  { from: 'paris', to: 'zagrab', points: 7, long: false },
  { from: 'riga', to: 'bucuresti', points: 10, long: false },
  { from: 'roma', to: 'smyrna', points: 8, long: false },
  { from: 'rostov', to: 'erzurim', points: 5, long: false },
  { from: 'sarajevo', to: 'sevastopol', points: 8, long: false },
  { from: 'smolensk', to: 'rostov', points: 8, long: false },
  { from: 'sofia', to: 'smyrna', points: 5, long: false },
  { from: 'stockholm', to: 'wien', points: 11, long: false },
  { from: 'venezia', to: 'constantinople', points: 10, long: false },
  { from: 'warszawa', to: 'smolensk', points: 6, long: false },
  { from: 'zagrab', to: 'brindisi', points: 6, long: false },
  { from: 'zurich', to: 'brindisi', points: 6, long: false },
  { from: 'zurich', to: 'budapest', points: 6, long: false },
];

module.exports = { TICKETS };