import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db from './db.js';
import courierRoutes from './courier.js';
import waiterRoutes from './waiter.js';
import vitalsRoutes, { touchVitals, vitalsState, deadGuard } from './vitals.js';

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-ozgartiring';
const ACCESS_TTL = process.env.ACCESS_TTL || '15m'; // access token qisqa muddatli
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS) || 7; // refresh token uzoq muddatli
const REFRESH_COOKIE = 'refresh_token';

const app = express();
app.use(cors());
app.use(express.json());

function validate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') {
    return 'Username va parol kiritilishi shart';
  }
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return "Username 3-30 belgi bo'lishi kerak (harf, raqam, _)";
  }
  if (password.length < 6) {
    return "Parol kamida 6 belgidan iborat bo'lishi kerak";
  }
  return null;
}

// ---------- Tokenlar ----------

function makeAccessToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Refresh token: tasodifiy satr, bazaga hashi yoziladi
function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
    .run(userId, hashToken(token), expiresAt);
  return { token, expiresAt };
}

// Refresh token httpOnly cookie'da turadi, JavaScript uni o'qiy olmaydi
function setRefreshCookie(res, { token, expiresAt }) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/api',
    expires: new Date(expiresAt),
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api' });
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function issueTokens(res, user) {
  setRefreshCookie(res, createRefreshToken(user.id));
  return makeAccessToken(user);
}

// ---------- Middleware ----------

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Avtorizatsiyadan o'tilmagan" });
  try {
    const { id, username } = jwt.verify(token, JWT_SECRET);
    req.user = { id, username };
    touchHunger(id); // har qanday so'rov — foydalanuvchi online
    touchVitals(id); // energiya va kasallik ham shu vaqt bo'yicha hisoblanadi
    if (deadGuard(req, res)) return; // o'lgan Sardor hech narsa qila olmaydi
    next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    res.status(401).json({
      error: expired ? 'Token muddati tugagan' : "Token noto'g'ri",
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }
}

// ---------- Routelar ----------

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  const error = validate(username, password);
  if (error) return res.status(400).json({ error });

  const hash = await bcrypt.hash(password, 10);
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, hash);
    const user = { id: Number(info.lastInsertRowid), username };
    res.status(201).json({ user, accessToken: issueTokens(res, user) });
  } catch (err) {
    if (err.errcode === 2067 || /UNIQUE constraint failed/.test(err.message)) {
      return res.status(409).json({ error: 'Bu username band, boshqasini tanlang' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username va parol kiritilishi shart' });
  }
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) return res.status(401).json({ error: "Username yoki parol noto'g'ri" });

  const user = { id: row.id, username: row.username };
  res.json({ user, accessToken: issueTokens(res, user) });
});

// Yangi access token olish. Rotation: eski refresh token bekor qilinib, yangisi beriladi
app.post('/api/refresh', (req, res) => {
  const token = readCookie(req, REFRESH_COOKIE);
  if (!token) return res.status(401).json({ error: "Refresh token yo'q" });

  const row = db
    .prepare(`
      SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked, u.username
      FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ?
    `)
    .get(hashToken(token));

  if (!row) {
    clearRefreshCookie(res);
    return res.status(401).json({ error: "Refresh token noto'g'ri" });
  }
  if (row.revoked) {
    // Bekor qilingan token qayta ishlatildi: o'g'irlangan bo'lishi mumkin, barcha sessiyalarni yopamiz
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(row.user_id);
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Sessiya bekor qilingan, qayta kiring' });
  }
  if (row.expires_at < Date.now()) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Sessiya muddati tugagan, qayta kiring' });
  }

  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
  const user = { id: row.user_id, username: row.username };
  res.json({ user, accessToken: issueTokens(res, user) });
});

app.post('/api/logout', (req, res) => {
  const token = readCookie(req, REFRESH_COOKIE);
  if (token) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hashToken(token));
  }
  clearRefreshCookie(res);
  res.json({ ok: true });
});

// Server tirikligini tekshirish: frontend sahifa ochilganda shu yerga ping yuboradi (Render uyg'onishi)
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ---------- Kiyimlar ----------

const clothRow = (r) => ({ id: r.id, type: r.type, name: r.name, colors: JSON.parse(r.colors) });

app.get('/api/clothes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM clothes ORDER BY id').all();
  res.json({ clothes: rows.map(clothRow) });
});

// Foydalanuvchi hali kiyim saqlamagan bo'lsa, har turdagi birinchi kiyim beriladi
function defaultOutfit() {
  const first = (type) => db.prepare('SELECT id FROM clothes WHERE type = ? ORDER BY id LIMIT 1').get(type).id;
  return { shirt: first('shirt'), pants: first('pants'), shoes: first('shoes') };
}

app.get('/api/me/outfit', requireAuth, (req, res) => {
  const row = db.prepare('SELECT shirt_id, pants_id, shoes_id FROM user_outfits WHERE user_id = ?').get(req.user.id);
  const outfit = row ? { shirt: row.shirt_id, pants: row.pants_id, shoes: row.shoes_id } : defaultOutfit();
  res.json({ outfit });
});

app.put('/api/me/outfit', requireAuth, (req, res) => {
  const { shirt, pants, shoes } = req.body || {};
  // har bir id mavjud va to'g'ri turdagi kiyim bo'lishi kerak
  const check = db.prepare('SELECT 1 FROM clothes WHERE id = ? AND type = ?');
  for (const [id, type] of [[shirt, 'shirt'], [pants, 'pants'], [shoes, 'shoes']]) {
    if (!Number.isInteger(id) || !check.get(id, type)) {
      return res.status(400).json({ error: `Noto'g'ri kiyim: ${type}` });
    }
  }
  db.prepare(`
    INSERT INTO user_outfits (user_id, shirt_id, pants_id, shoes_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      shirt_id = excluded.shirt_id, pants_id = excluded.pants_id, shoes_id = excluded.shoes_id,
      updated_at = datetime('now')
  `).run(req.user.id, shirt, pants, shoes);
  res.json({ outfit: { shirt, pants, shoes } });
});

// ---------- Qahramon holati ----------

app.get('/api/me/state', requireAuth, (req, res) => {
  const row = db.prepare('SELECT sleeping FROM user_state WHERE user_id = ?').get(req.user.id);
  res.json({ state: { sleeping: Boolean(row?.sleeping) } });
});

app.put('/api/me/state', requireAuth, (req, res) => {
  const { sleeping } = req.body || {};
  if (typeof sleeping !== 'boolean') {
    return res.status(400).json({ error: "sleeping true yoki false bo'lishi kerak" });
  }
  // smena paytida uxlab bo'lmaydi (uyda emas)
  if (sleeping) {
    for (const t of ['courier_profile', 'waiter_profile']) {
      if (db.prepare(`SELECT on_shift FROM ${t} WHERE user_id = ?`).get(req.user.id)?.on_shift) {
        return res.status(400).json({ error: "Smena paytida uxlab bo'lmaydi" });
      }
    }
  }
  db.prepare(`
    INSERT INTO user_state (user_id, sleeping) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET sleeping = excluded.sleeping, updated_at = datetime('now')
  `).run(req.user.id, sleeping ? 1 : 0);
  res.json({ state: { sleeping }, vitals: vitalsState(req.user.id) });
});

// ---------- Muzlatgich ----------

// Muzlatgich tuzilishi (klientdagi client/src/fridgeSlots.js bilan bir xil bo'lishi kerak):
// 4 ta javon qatori, har qatorda 3 ta joy; eshikda 3 ta javon, har birida 3 ta joy.
// Eshikning yuqori javoni bankalar uchun, pastki ikkitasi butilkalar uchun.
const FRIDGE_ROWS = 4;
const FRIDGE_COLS = 3;
const FRIDGE_DOOR = ['can', 'bottle', 'bottle'];
const DOOR_SLOTS = 3;

const SPOIL_MS = Number(process.env.SPOIL_MS) || 60 * 60 * 1000; // muzlatgichdan tashqarida 1 soat turgan ovqat aynib qoladi
const START_COINS = 100; // yangi foydalanuvchining boshlang'ich tangalari
const SPOILED_ID = db.prepare("SELECT id FROM foods WHERE slug = 'spoiled'").get().id;

const foodRow = (r) => ({ id: r.id, kind: r.kind, subtype: r.subtype, name: r.name, art: JSON.parse(r.art), price: r.price });

app.get('/api/foods', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM foods ORDER BY id').all();
  res.json({ foods: rows.map(foodRow) });
});

// Joylashuv to'g'rimi: katta ovqat bo'sh qatorni to'liq oladi, kichik ovqat bitta joyni,
// ichimlik esa faqat o'z turidagi eshik javoniga qo'yiladi. Xato bo'lsa matn qaytaradi.
function checkFridge(items) {
  const getFood = db.prepare('SELECT kind, subtype FROM foods WHERE id = ?');
  const taken = new Set();
  const bigRows = new Set();
  const smallRows = new Set();
  for (const { slot, food } of items) {
    const f = getFood.get(food);
    if (!f) return `Noto'g'ri ovqat: ${food}`;
    if (food === SPOILED_ID) return "Aynigan ovqatni muzlatgichga solib bo'lmaydi";
    if (typeof slot !== 'string' || taken.has(slot)) return `Bu joy band: ${slot}`;
    taken.add(slot);
    let m;
    if ((m = /^r(\d)c(\d)$/.exec(slot))) {
      const row = Number(m[1]), col = Number(m[2]);
      if (row >= FRIDGE_ROWS || col >= FRIDGE_COLS) return `Noto'g'ri joy: ${slot}`;
      if (f.kind === 'drink') return 'Ichimliklar eshik javonida turadi';
      if (f.kind === 'big') {
        if (col !== 0 || bigRows.has(row) || smallRows.has(row)) return `Qator band: ${row + 1}`;
        bigRows.add(row);
      } else {
        if (bigRows.has(row)) return `Qator band: ${row + 1}`;
        smallRows.add(row);
      }
    } else if ((m = /^d(\d)s(\d)$/.exec(slot))) {
      const shelf = Number(m[1]), pos = Number(m[2]);
      if (shelf >= FRIDGE_DOOR.length || pos >= DOOR_SLOTS) return `Noto'g'ri joy: ${slot}`;
      if (f.kind !== 'drink' || f.subtype !== FRIDGE_DOOR[shelf]) return `Bu javonga faqat ${FRIDGE_DOOR[shelf] === 'can' ? 'banka' : 'butilka'} qo'yiladi`;
    } else {
      return `Noto'g'ri joy: ${slot}`;
    }
  }
  return null;
}

// Muzlatgichdan tashqarida 1 soatdan ko'p turgan ovqatlar "Aynigan ovqat"ga aylanadi.
// Alohida taymer yo'q: har so'rovda vaqt bo'yicha hisoblanadi.
function spoil(userId) {
  db.prepare('UPDATE user_items SET food_id = ? WHERE user_id = ? AND slot IS NULL AND food_id != ? AND out_since <= ?')
    .run(SPOILED_ID, userId, SPOILED_ID, Date.now() - SPOIL_MS);
}

function coins(userId) {
  db.prepare('INSERT OR IGNORE INTO user_wallet (user_id, coins) VALUES (?, ?)').run(userId, START_COINS);
  return db.prepare('SELECT coins FROM user_wallet WHERE user_id = ?').get(userId).coins;
}

// Foydalanuvchining hamma narsasi: tangalar va sotib olingan ovqatlar (muzlatgichdagilar ham)
function itemsState(userId) {
  spoil(userId);
  const rows = db.prepare('SELECT id, food_id, slot, out_since FROM user_items WHERE user_id = ? ORDER BY id').all(userId);
  return {
    coins: coins(userId),
    now: Date.now(),
    spoilMs: SPOIL_MS,
    items: rows.map((r) => ({
      id: r.id, food: r.food_id, slot: r.slot,
      // muzlatgichdan tashqaridagi ovqat qachon aynib qoladi (ms)
      spoilsAt: r.slot == null && r.food_id !== SPOILED_ID ? r.out_since + SPOIL_MS : null,
    })),
  };
}

app.get('/api/me/items', requireAuth, (req, res) => {
  res.json(itemsState(req.user.id));
});

// Eats ilovasi: bitta ovqat sotib olish. Ovqat muzlatgichdan tashqarida paydo bo'ladi.
app.post('/api/shop/buy', requireAuth, (req, res) => {
  const { food } = req.body || {};
  const f = Number.isInteger(food) ? db.prepare('SELECT price FROM foods WHERE id = ?').get(food) : null;
  if (!f || f.price == null) return res.status(400).json({ error: 'Bu ovqat sotilmaydi' });
  const have = coins(req.user.id);
  if (have < f.price) return res.status(400).json({ error: 'Tanga yetmaydi' });
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE user_wallet SET coins = coins - ? WHERE user_id = ?').run(f.price, req.user.id);
    db.prepare('INSERT INTO user_items (user_id, food_id, slot, out_since, bought_at) VALUES (?, ?, NULL, ?, ?)').run(req.user.id, food, now, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server xatosi' });
  }
  res.json(itemsState(req.user.id));
});

// Ovqatni muzlatgichga qo'yish ({ slot: "r0c1" }) yoki undan olish ({ slot: null }).
// Olingan ovqatning 1 soatlik vaqti qaytadan boshlanadi.
app.put('/api/me/items/:id', requireAuth, (req, res) => {
  const { slot } = req.body || {};
  spoil(req.user.id);
  const item = db.prepare('SELECT * FROM user_items WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!item) return res.status(404).json({ error: 'Ovqat topilmadi' });
  if (slot === null) {
    if (item.slot != null) db.prepare('UPDATE user_items SET slot = NULL, out_since = ? WHERE id = ?').run(Date.now(), item.id);
    return res.json(itemsState(req.user.id));
  }
  const others = db.prepare('SELECT slot, food_id AS food FROM user_items WHERE user_id = ? AND slot IS NOT NULL AND id != ?').all(req.user.id, item.id);
  const error = checkFridge([...others, { slot, food: item.food_id }]);
  if (error) return res.status(400).json({ error });
  db.prepare('UPDATE user_items SET slot = ? WHERE id = ?').run(slot, item.id);
  res.json(itemsState(req.user.id));
});

// ---------- Ochlik ----------

// To'qlik 100% dan 0% gacha 1 soat online vaqtda kamayadi. Hammasi serverda hisoblanadi:
// klient faqat ko'rsatadi, foizni o'zi yubora olmaydi.
const HUNGER_MS = Number(process.env.HUNGER_MS) || 60 * 60 * 1000;
const ONLINE_GAP_MS = 90 * 1000; // so'rovlar orasidagi bundan uzun tanaffus — offline, hisoblanmaydi
// Bitta ovqat qancha to'yg'izadi (%): katta — to'liq, 2 ta kichik + 1 ta ichimlik ham to'liq
const FILL = { big: 100, small: 35, drink: 30 };

// Oxirgi so'rovdan beri o'tgan online vaqt uchun to'qlikni kamaytiradi
function touchHunger(userId) {
  const now = Date.now();
  db.prepare('INSERT OR IGNORE INTO user_hunger (user_id, satiety, last_seen) VALUES (?, 100, ?)').run(userId, now);
  db.prepare(`
    UPDATE user_hunger SET
      satiety = CASE WHEN last_seen IS NOT NULL AND ? - last_seen BETWEEN 0 AND ?
        THEN max(0, satiety - (? - last_seen) * 100.0 / ?) ELSE satiety END,
      last_seen = ?
    WHERE user_id = ?
  `).run(now, ONLINE_GAP_MS, now, HUNGER_MS, now, userId);
}

function hungerState(userId) {
  const row = db.prepare('SELECT satiety FROM user_hunger WHERE user_id = ?').get(userId);
  return { satiety: Math.round((row?.satiety ?? 100) * 10) / 10, fullMs: HUNGER_MS, onlineGapMs: ONLINE_GAP_MS };
}

// Klient har 30 soniyada yuboradi (online ekanini bildiradi); javobda hozirgi to'qlik
app.post('/api/me/heartbeat', requireAuth, (req, res) => {
  res.json({ hunger: hungerState(req.user.id), vitals: vitalsState(req.user.id) });
});

app.get('/api/me/hunger', requireAuth, (req, res) => {
  res.json({ hunger: hungerState(req.user.id) });
});

// Muzlatgichdagi ovqatni yeyish: ovqat o'chiriladi, to'qlik oshadi (100% dan oshmaydi)
app.post('/api/me/items/:id/eat', requireAuth, (req, res) => {
  spoil(req.user.id);
  const item = db.prepare(`
    SELECT i.id, i.slot, i.food_id, f.kind FROM user_items i JOIN foods f ON f.id = i.food_id
    WHERE i.id = ? AND i.user_id = ?
  `).get(Number(req.params.id), req.user.id);
  if (!item) return res.status(404).json({ error: 'Ovqat topilmadi' });
  if (item.slot == null) return res.status(400).json({ error: 'Faqat muzlatgichdagi ovqatni yeyish mumkin' });
  if (item.food_id === SPOILED_ID) return res.status(400).json({ error: "Aynigan ovqatni yeb bo'lmaydi" });
  if (hungerState(req.user.id).satiety >= 100) return res.status(400).json({ error: "Qorin to'q" });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM user_items WHERE id = ?').run(item.id);
    db.prepare('UPDATE user_hunger SET satiety = min(100, satiety + ?) WHERE user_id = ?').run(FILL[item.kind] ?? 0, req.user.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Server xatosi' });
  }
  res.json({ ...itemsState(req.user.id), hunger: hungerState(req.user.id) });
});

// Faqat aynigan ovqatni tashlab yuborish mumkin (ovqat yeyish keyin qo'shiladi)
app.delete('/api/me/items/:id', requireAuth, (req, res) => {
  spoil(req.user.id);
  const info = db.prepare('DELETE FROM user_items WHERE id = ? AND user_id = ? AND food_id = ? AND slot IS NULL')
    .run(Number(req.params.id), req.user.id, SPOILED_ID);
  if (!info.changes) return res.status(400).json({ error: 'Faqat aynigan ovqatni tashlash mumkin' });
  res.json(itemsState(req.user.id));
});

// ---------- Avtobus bekati ----------

app.get('/api/destinations', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, slug, name, icon FROM destinations ORDER BY sort, id').all();
  res.json({ destinations: rows });
});

// Yo'nalish ichidagi joylar (bo'sh ro'yxat — hali joy yo'q)
app.get('/api/destinations/:slug/locations', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, slug, name, icon FROM locations WHERE destination = ? ORDER BY sort, id').all(req.params.slug);
  res.json({ locations: rows });
});

// ---------- Ishlar ----------

// Ishlar ro'yxati va foydalanuvchi har bir ishning transportini olganmi
function jobsState(userId) {
  const rows = db.prepare(`
    SELECT j.id, j.slug, j.name, j.icon, j.vehicle, uj.vehicle_at
    FROM jobs j LEFT JOIN user_jobs uj ON uj.job_id = j.id AND uj.user_id = ?
    ORDER BY j.sort, j.id
  `).all(userId);
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, icon: r.icon, vehicle: r.vehicle, hasVehicle: r.vehicle_at != null }));
}

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json({ jobs: jobsState(req.user.id) });
});

// Ish transportini olish (kuryer — skuter). Qayta olinsa birinchi olingan vaqt saqlanib qoladi
app.post('/api/jobs/:slug/vehicle', requireAuth, (req, res) => {
  const job = db.prepare('SELECT id, vehicle FROM jobs WHERE slug = ?').get(req.params.slug);
  if (!job) return res.status(404).json({ error: 'Ish topilmadi' });
  if (!job.vehicle) return res.status(400).json({ error: 'Bu ishga transport kerak emas' });
  db.prepare(`
    INSERT INTO user_jobs (user_id, job_id, vehicle_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, job_id) DO UPDATE SET vehicle_at = COALESCE(user_jobs.vehicle_at, excluded.vehicle_at)
  `).run(req.user.id, job.id, Date.now());
  res.json({ jobs: jobsState(req.user.id) });
});

// ---------- Kuryer ishi (server/courier.js) ----------

courierRoutes(app, { db, requireAuth, coins });

// ---------- Ofitsiant ishi (server/waiter.js) ----------

waiterRoutes(app, { db, requireAuth, coins });

// ---------- Energiya va kasallik (server/vitals.js) ----------

vitalsRoutes(app, { requireAuth, coins });

// Eskirgan tokenlarni vaqti-vaqti bilan tozalash
setInterval(() => {
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
