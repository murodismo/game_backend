// Energiya va kasallik. Hamma hisob-kitob serverda, klient faqat ko'rsatadi.
//
// - Energiya faqat foydalanuvchi online va uyg'oq bo'lganda kamayadi (ochlik kabi heartbeat orqali).
// - Energiya 20% ga tushsa — "Uxlash kerak" ogohlantirishi. Shundan keyin yana 2 soat uxlamasdan
//   o'ynasa Sardor kasal bo'ladi (1-bosqich). Dorixonada davolanmasa har 2 soatda kasallik og'irlashadi
//   (2-, 3-bosqich), 3-bosqichdan keyin yana 2 soat o'tsa Sardor o'ladi.
// - Uxlash (uydagi karavot) energiyani tiklaydi; uxlab turgan vaqt kasallik soatiga qo'shilmaydi,
//   kasal bo'lmagan bo'lsa "uxlamasdan o'ynash" soati nolga tushadi.
// - Dorixonada davolanish kasallikni to'liq yo'qotadi (tanga to'lanadi).
import db from './db.js';

const ENERGY_MS = Number(process.env.ENERGY_MS) || 4 * 60 * 60 * 1000; // 100% → 0% shuncha online vaqtda
const SLEEP_MS = Number(process.env.SLEEP_MS) || 30 * 60 * 1000; // uxlaganda 0% → 100% shuncha vaqtda
const SICK_STEP_MS = Number(process.env.SICK_STEP_MS) || 2 * 60 * 60 * 1000; // har bosqich orasidagi vaqt
const ONLINE_GAP_MS = 90 * 1000; // so'rovlar orasidagi bundan uzun tanaffus — offline (index.js dagi bilan bir xil)
export const WARN_AT = 20; // shu foizda "Uxlash kerak" ogohlantirishi
export const MAX_STAGE = 3; // 3-bosqichdan keyingi qadam — o'lim
// Dorixonada davolanish narxi (tanga), kasallik bosqichiga qarab
const CURE_PRICE = { 1: 10, 2: 20, 3: 35 };

// energy — 0..100; stage — 0 sog', 1..3 kasallik bosqichi; dead — 1 bo'lsa Sardor o'lgan.
// clock_ms — hozirgi bosqich soati: sog' bo'lsa energiya 20% dan past bo'lgan online vaqt,
// kasal bo'lsa kasallik shu bosqichda qancha davom etgani. last_seen — oxirgi so'rov vaqti (ms).
db.exec(`
  CREATE TABLE IF NOT EXISTS user_vitals (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    energy REAL NOT NULL DEFAULT 100 CHECK (energy >= 0 AND energy <= 100),
    stage INTEGER NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 3),
    clock_ms REAL NOT NULL DEFAULT 0,
    dead INTEGER NOT NULL DEFAULT 0 CHECK (dead IN (0, 1)),
    died_at INTEGER,
    last_seen INTEGER
  )
`);

const getRow = (userId) => db.prepare('SELECT * FROM user_vitals WHERE user_id = ?').get(userId);
const isSleeping = (userId) => Boolean(db.prepare('SELECT sleeping FROM user_state WHERE user_id = ?').get(userId)?.sleeping);

// Oxirgi so'rovdan beri o'tgan vaqtni hisoblaydi. Har qanday so'rovda chaqiriladi (requireAuth).
// Uxlash holati o'zgarishidan oldin chaqirilgani uchun o'tgan vaqt eski holat bo'yicha hisoblanadi.
export function touchVitals(userId) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO user_vitals (user_id, last_seen) VALUES (?, ?)').run(userId, now);
  const v = getRow(userId);
  if (v.dead) return;
  const gap = v.last_seen == null ? -1 : now - v.last_seen;
  let { energy, stage, clock_ms: clock } = v;
  let dead = 0;
  if (gap > 0) {
    if (isSleeping(userId)) {
      // uxlash: offline bo'lsa ham dam oladi (karavotda yotib o'yinni yopsa ham)
      energy = Math.min(100, energy + gap * 100 / SLEEP_MS);
      if (stage === 0) clock = 0; // vaqtida uxlagan — kasallik soati nolga tushadi
    } else if (gap <= ONLINE_GAP_MS) {
      const before = energy;
      energy = Math.max(0, before - gap * 100 / ENERGY_MS);
      if (stage > 0) {
        clock += gap;
      } else if (energy <= WARN_AT) {
        // faqat 20% dan pastda o'tgan qismi hisoblanadi
        clock += Math.min(gap, (WARN_AT - (before - gap * 100 / ENERGY_MS)) * ENERGY_MS / 100);
      } else {
        clock = 0;
      }
      while (clock >= SICK_STEP_MS) {
        clock -= SICK_STEP_MS;
        if (stage >= MAX_STAGE) { dead = 1; clock = 0; break; }
        stage++;
      }
    }
  }
  db.prepare('UPDATE user_vitals SET energy = ?, stage = ?, clock_ms = ?, dead = ?, died_at = ?, last_seen = ? WHERE user_id = ?')
    .run(energy, stage, clock, dead, dead ? now : null, now, userId);
}

export function isDead(userId) {
  return Boolean(getRow(userId)?.dead);
}

// Klientga yuboriladigan holat. nextInMs — keyingi bosqichgacha qolgan online vaqt
// (sog' va energiya 20% dan yuqori bo'lsa null)
export function vitalsState(userId) {
  const v = getRow(userId) || { energy: 100, stage: 0, clock_ms: 0, dead: 0 };
  const sleeping = isSleeping(userId);
  const warn = !v.dead && v.energy <= WARN_AT;
  return {
    energy: Math.round(v.energy * 10) / 10,
    stage: v.stage,
    dead: Boolean(v.dead),
    diedAt: v.died_at ?? null,
    sleeping,
    warn, // "Uxlash kerak"
    nextInMs: v.dead || (!warn && v.stage === 0) ? null : Math.max(0, Math.round(SICK_STEP_MS - v.clock_ms)),
    curePrice: CURE_PRICE[v.stage] ?? null,
    energyMs: ENERGY_MS,
    sleepMs: SLEEP_MS,
    stepMs: SICK_STEP_MS,
    warnAt: WARN_AT,
  };
}

// O'lgan foydalanuvchi faqat ma'lumot o'qiy oladi (GET) va heartbeat yubora oladi.
// TODO: o'yinga qayta kirish (respawn) tartibi keyin qo'shiladi.
export function deadGuard(req, res) {
  if (!isDead(req.user.id)) return false;
  if (req.method === 'GET' || req.path === '/api/me/heartbeat') return false;
  res.status(403).json({ error: "Sardor vafot etgan", code: 'DEAD', vitals: vitalsState(req.user.id) });
  return true;
}

export default function vitalsRoutes(app, { requireAuth, coins }) {
  app.get('/api/me/vitals', requireAuth, (req, res) => {
    res.json({ vitals: vitalsState(req.user.id) });
  });

  // Dorixona: kasallikni davolash. Bosqichga qarab tanga to'lanadi, kasallik to'liq yo'qoladi.
  // Energiya tiklanmaydi — baribir uxlash kerak (aks holda 2 soatdan keyin yana kasal bo'ladi).
  app.post('/api/pharmacy/cure', requireAuth, (req, res) => {
    const v = getRow(req.user.id);
    if (!v || v.stage === 0) return res.status(400).json({ error: 'Sardor sog\', dori kerak emas', vitals: vitalsState(req.user.id) });
    const price = CURE_PRICE[v.stage];
    if (coins(req.user.id) < price) return res.status(400).json({ error: `Tanga yetmaydi: dori ${price} tanga`, vitals: vitalsState(req.user.id) });
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE user_wallet SET coins = coins - ? WHERE user_id = ?').run(price, req.user.id);
      db.prepare('UPDATE user_vitals SET stage = 0, clock_ms = 0 WHERE user_id = ?').run(req.user.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(err);
      return res.status(500).json({ error: 'Server xatosi' });
    }
    res.json({ vitals: vitalsState(req.user.id), coins: coins(req.user.id), paid: price });
  });
}
