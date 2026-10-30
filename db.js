import { DatabaseSync } from 'node:sqlite';

// Node.js ichidagi SQLite (22.5+), native build kerak emas
const db = new DatabaseSync('auth.db');
db.exec('PRAGMA foreign_keys = ON');

// username UNIQUE: bir xil username bilan ikki marta ro'yxatdan o'tib bo'lmaydi
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Refresh tokenlar: bazada tokenning o'zi emas, faqat SHA-256 hashi saqlanadi
db.exec(`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id)');

// Kiyimlar ro'yxati: har bir kiyimning turi va ranglari (colors — JSON matn)
db.exec(`
  CREATE TABLE IF NOT EXISTS clothes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('shirt', 'pants', 'shoes')),
    name TEXT NOT NULL,
    colors TEXT NOT NULL
  )
`);

// Har bir foydalanuvchi qahramonining hozirgi kiyimi
db.exec(`
  CREATE TABLE IF NOT EXISTS user_outfits (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    shirt_id INTEGER NOT NULL REFERENCES clothes(id),
    pants_id INTEGER NOT NULL REFERENCES clothes(id),
    shoes_id INTEGER NOT NULL REFERENCES clothes(id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Qahramon holati (hozircha: uxlayaptimi). Har bir foydalanuvchi uchun bitta qator.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_state (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sleeping INTEGER NOT NULL DEFAULT 0 CHECK (sleeping IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Muzlatgichdagi ovqat va ichimliklar katalogi.
// kind: big — javonning bitta qatorini to'liq egallaydi, small — qatorning 1/3 qismini,
// drink — faqat eshik javonlarida turadi (subtype: bottle — butilka, can — banka).
// art — rasm uchun shakl va ranglar (JSON matn), price — Eats ilovasidagi narxi (tanga), NULL — sotilmaydi
db.exec(`
  CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('big', 'small', 'drink')),
    subtype TEXT CHECK (subtype IN ('bottle', 'can')),
    name TEXT NOT NULL,
    art TEXT NOT NULL,
    price INTEGER,
    CHECK ((kind = 'drink') = (subtype IS NOT NULL))
  )
`);

// Foydalanuvchi sotib olgan ovqatlar (Eats ilovasidan). slot NULL — muzlatgichdan tashqarida,
// aks holda muzlatgichdagi joy: javon qatori "r{qator}c{ustun}", eshik javoni "d{javon}s{joy}".
// Katta ovqat qatorning birinchi ustunida (c0) saqlanadi va butun qatorni band qiladi.
// out_since — muzlatgichdan tashqarida qachondan beri turibdi (ms); 1 soatdan oshsa aynib qoladi.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_id INTEGER NOT NULL REFERENCES foods(id),
    slot TEXT,
    out_since INTEGER NOT NULL,
    bought_at INTEGER NOT NULL
  )
`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_items_slot ON user_items(user_id, slot) WHERE slot IS NOT NULL');

// To'qlik (0..100%). Faqat foydalanuvchi online bo'lgan vaqtda kamayadi:
// last_seen — oxirgi so'rov vaqti (ms); so'rovlar orasidagi uzoq tanaffus (offline) hisoblanmaydi.
db.exec(`
  CREATE TABLE IF NOT EXISTS user_hunger (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    satiety REAL NOT NULL DEFAULT 100 CHECK (satiety >= 0 AND satiety <= 100),
    last_seen INTEGER
  )
`);

// Tangalar: har bir foydalanuvchida bitta hamyon
db.exec(`
  CREATE TABLE IF NOT EXISTS user_wallet (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coins INTEGER NOT NULL CHECK (coins >= 0)
  )
`);

// Boshlang'ich kiyimlar: 3 ta futbolka, 3 ta shim, 3 juft oyoq kiyim.
// Har turdagi birinchisi — standart kiyim (Sardorning asl kiyimi).
const SEED = [
  ['shirt-blue', 'shirt', "Ko'k futbolka", { shirt: '#3e62b8', pattern: 'plain' }],
  ['shirt-red-stripes', 'shirt', 'Qizil chiziqli futbolka', { shirt: '#d9534f', pattern: 'stripes', accent: '#f6efe2' }],
  ['shirt-green-star', 'shirt', 'Yashil yulduzli futbolka', { shirt: '#2f9e6b', pattern: 'star', accent: '#f3d36b' }],
  ['pants-gray', 'pants', 'Kulrang shim', { pants: '#77848b' }],
  ['pants-jeans', 'pants', 'Jinsi shim', { pants: '#3d5a8a' }],
  ['pants-brown', 'pants', 'Jigarrang shim', { pants: '#8b5d47' }],
  ['shoes-blue', 'shoes', "Ko'k krossovka", { shoe: '#2d4a8e', sole: '#f3efe2', laces: true }],
  ['shoes-red', 'shoes', 'Qizil krossovka', { shoe: '#c0392b', sole: '#f5f1e6', laces: true }],
  ['shoes-black', 'shoes', 'Qora botinka', { shoe: '#2f2b2b', sole: '#6b5a4a', laces: false }],
  // qo'shimcha kiyimlar (javonning keyingi sahifalari)
  ['shirt-yellow', 'shirt', 'Sariq futbolka', { shirt: '#f0b429', pattern: 'plain' }],
  ['shirt-purple', 'shirt', 'Binafsha futbolka', { shirt: '#7a5cc4', pattern: 'plain' }],
  ['shirt-orange-stripes', 'shirt', "To'q sariq chiziqli futbolka", { shirt: '#e8833a', pattern: 'stripes', accent: '#fff3dc' }],
  ['shirt-navy-star', 'shirt', "To'q ko'k yulduzli futbolka", { shirt: '#2b3a67', pattern: 'star', accent: '#f3d36b' }],
  ['shirt-pink', 'shirt', 'Pushti futbolka', { shirt: '#e37aa6', pattern: 'plain' }],
  ['shirt-teal-stripes', 'shirt', 'Feruza chiziqli futbolka', { shirt: '#1f9aa0', pattern: 'stripes', accent: '#e8fbfb' }],
  ['shirt-white-star', 'shirt', 'Oq yulduzli futbolka', { shirt: '#f2f0ea', pattern: 'star', accent: '#d9534f' }],
  ['shirt-black', 'shirt', 'Qora futbolka', { shirt: '#2f2f35', pattern: 'plain' }],
  ['shirt-lime', 'shirt', 'Och yashil futbolka', { shirt: '#8cc63f', pattern: 'plain' }],
  ['shirt-blue-stripes', 'shirt', "Ko'k chiziqli futbolka", { shirt: '#4f86c6', pattern: 'stripes', accent: '#ffffff' }],
  ['shirt-red-star', 'shirt', 'Qizil yulduzli futbolka', { shirt: '#c0392b', pattern: 'star', accent: '#ffd34d' }],
  ['shirt-gray', 'shirt', 'Kulrang futbolka', { shirt: '#9aa3ad', pattern: 'plain' }],
  ['pants-black', 'pants', 'Qora shim', { pants: '#2f3036' }],
  ['pants-beige', 'pants', 'Bej shim', { pants: '#c9b48a' }],
  ['pants-olive', 'pants', 'Zaytunrang shim', { pants: '#6b7a3a' }],
  ['pants-navy', 'pants', "To'q ko'k shim", { pants: '#253256' }],
  ['pants-light-jeans', 'pants', "Och ko'k jinsi", { pants: '#6f93c4' }],
  ['pants-red', 'pants', 'Qizil shim', { pants: '#a8323a' }],
  ['pants-white', 'pants', 'Oq shim', { pants: '#e9e5da' }],
  ['pants-purple', 'pants', 'Binafsha shim', { pants: '#574a8a' }],
  ['pants-green', 'pants', 'Yashil shim', { pants: '#2f7a55' }],
  ['pants-mustard', 'pants', 'Xantal rang shim', { pants: '#d6a73a' }],
  ['pants-terracotta', 'pants', 'Terrakota shim', { pants: '#b35d3c' }],
  ['pants-charcoal', 'pants', "To'q kulrang shim", { pants: '#4b525a' }],
  ['shoes-white', 'shoes', 'Oq krossovka', { shoe: '#f2f0ea', sole: '#cfc8b8', laces: true }],
  ['shoes-green', 'shoes', 'Yashil krossovka', { shoe: '#2f9e6b', sole: '#f5f1e6', laces: true }],
  ['shoes-yellow', 'shoes', 'Sariq krossovka', { shoe: '#f0b429', sole: '#ffffff', laces: true }],
  ['shoes-black-sneaker', 'shoes', 'Qora krossovka', { shoe: '#2f2b2b', sole: '#f5f1e6', laces: true }],
  ['shoes-brown-boot', 'shoes', 'Jigarrang botinka', { shoe: '#7a4b2c', sole: '#3d2a1c', laces: false }],
  ['shoes-pink', 'shoes', 'Pushti krossovka', { shoe: '#e37aa6', sole: '#ffffff', laces: true }],
  ['shoes-purple', 'shoes', 'Binafsha krossovka', { shoe: '#7a5cc4', sole: '#f5f1e6', laces: true }],
  ['shoes-gray', 'shoes', 'Kulrang krossovka', { shoe: '#8a929b', sole: '#f5f1e6', laces: true }],
  ['shoes-olive-boot', 'shoes', 'Zaytunrang etik', { shoe: '#5f6b34', sole: '#3a2e22', laces: false }],
  ['shoes-navy-boot', 'shoes', "To'q ko'k botinka", { shoe: '#253256', sole: '#6b5a4a', laces: false }],
  ['shoes-red-boot', 'shoes', 'Qizil botinka', { shoe: '#a8323a', sole: '#3d2a1c', laces: false }],
  ['shoes-teal', 'shoes', 'Feruza krossovka', { shoe: '#1f9aa0', sole: '#ffffff', laces: true }],
];
const insertCloth = db.prepare('INSERT OR IGNORE INTO clothes (slug, type, name, colors) VALUES (?, ?, ?, ?)');
for (const [slug, type, name, colors] of SEED) insertCloth.run(slug, type, name, JSON.stringify(colors));

// Eski bazalarda narx ustuni yo'q bo'lishi mumkin
if (!db.prepare('PRAGMA table_info(foods)').all().some((c) => c.name === 'price')) {
  db.exec('ALTER TABLE foods ADD COLUMN price INTEGER');
}

// Ovqatlar va ichimliklar. Oxirgi ustun — narxi (tanga).
// "Aynigan ovqat" sotilmaydi: muzlatgichga solinmagan har qanday ovqat 1 soatdan keyin shunga aylanadi.
const FOODS = [
  ['cake', 'big', null, 'Tort', { shape: 'cake', base: '#f3c6d3', cream: '#fff7f0', berry: '#d9534f' }, 25],
  ['watermelon', 'big', null, 'Tarvuz', { shape: 'watermelon', rind: '#3f8f3a', stripe: '#2c6b2a' }, 20],
  ['plov', 'big', null, 'Qozonda palov', { shape: 'pot', pot: '#4a4f57', food: '#e9b44c', bits: '#e8743a' }, 30],
  ['fish', 'big', null, 'Baliq', { shape: 'fish', body: '#8fb3c9', fin: '#5f87a3' }, 22],
  ['apple', 'small', null, 'Olma', { shape: 'apple', body: '#d9473f' }, 4],
  ['tomato', 'small', null, 'Pomidor', { shape: 'tomato', body: '#e5533a' }, 3],
  ['cheese', 'small', null, 'Pishloq', { shape: 'cheese', body: '#f3c623' }, 6],
  ['yogurt', 'small', null, 'Qatiq', { shape: 'cup', body: '#f7f4ec', lid: '#4f86c6' }, 5],
  ['eggs', 'small', null, 'Tuxum', { shape: 'eggs', box: '#b9a27e', egg: '#fbf3e4' }, 6],
  ['carrot', 'small', null, 'Sabzi', { shape: 'carrot', body: '#ef8a2c' }, 3],
  ['water-bottle', 'drink', 'bottle', 'Suv', { liquid: '#bfe3f7', cap: '#3e62b8', label: '#ffffff' }, 3],
  ['milk', 'drink', 'bottle', 'Sut', { liquid: '#fbfbf6', cap: '#4f86c6', label: '#d6e6f7' }, 5],
  ['apple-juice', 'drink', 'bottle', 'Olma sharbati', { liquid: '#f0b429', cap: '#2f9e6b', label: '#d9473f' }, 6],
  ['cola-bottle', 'drink', 'bottle', 'Kola', { liquid: '#4a2a1d', cap: '#d9534f', label: '#d9534f' }, 7],
  ['cola-can', 'drink', 'can', 'Kola', { body: '#d9473f', band: '#ffffff' }, 4],
  ['lemonade-can', 'drink', 'can', 'Limonad', { body: '#8cc63f', band: '#f3d36b' }, 4],
  ['orange-can', 'drink', 'can', 'Apelsin sharbati', { body: '#ef8a2c', band: '#fff3dc' }, 5],
  ['soda-can', 'drink', 'can', 'Mineral suv', { body: '#4f86c6', band: '#e8fbfb' }, 3],
  ['spoiled', 'small', null, 'Aynigan ovqat', { shape: 'spoiled', body: '#8a9a5b', fly: '#2f2f35' }, null],
];
const insertFood = db.prepare('INSERT OR IGNORE INTO foods (slug, kind, subtype, name, art, price) VALUES (?, ?, ?, ?, ?, ?)');
const updateFood = db.prepare('UPDATE foods SET name = ?, art = ?, price = ? WHERE slug = ?');
for (const [slug, kind, subtype, name, art, price] of FOODS) {
  insertFood.run(slug, kind, subtype, name, JSON.stringify(art), price);
  updateFood.run(name, JSON.stringify(art), price, slug);
}

// Oldingi versiyadagi muzlatgich (user_fridge) ichidagilar yangi jadvalga ko'chiriladi
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_fridge'").get()) {
  const now = Date.now();
  db.prepare('INSERT INTO user_items (user_id, food_id, slot, out_since, bought_at) SELECT user_id, food_id, slot, ?, ? FROM user_fridge').run(now, now);
  db.exec('DROP TABLE user_fridge');
}

// Avtobus bekatidagi yo'nalishlar (ko'cha sahifasidagi menyu). icon — emoji, sort — tartib.
// Boshlang'ich yo'nalishlar har ishga tushganda yangilanadi (nomi o'zgarsa bazaga ham yoziladi)
db.exec(`
  CREATE TABLE IF NOT EXISTS destinations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  )
`);
const DESTINATIONS = [
  ['work', 'Ish', '💼', 10],
  ['home', 'Uy', '🏠', 20],
  ['gov', 'Davlat', '🏛️', 30],
  ['fun', "Ko'ngilochar", '🎡', 40],
  ['other', 'Boshqa', '🧭', 50],
];
const insertDest = db.prepare(`
  INSERT INTO destinations (slug, name, icon, sort) VALUES (?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET name = excluded.name, icon = excluded.icon, sort = excluded.sort
`);
for (const d of DESTINATIONS) insertDest.run(...d);

// Yo'nalish ichidagi joylar (masalan "Davlat" → "Shifoxona"). destination — destinations.slug
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    destination TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0
  )
`);
const LOCATIONS = [
  ['hospital', 'gov', 'Shifoxona', '🏥', 10],
];
const insertLoc = db.prepare(`
  INSERT INTO locations (slug, destination, name, icon, sort) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET destination = excluded.destination, name = excluded.name, icon = excluded.icon, sort = excluded.sort
`);
for (const l of LOCATIONS) insertLoc.run(...l);

// Ishlar ro'yxati (bekatdagi "Ish" yo'nalishi ichida). vehicle — ishga beriladigan transport (NULL — kerak emas).
// Boshlang'ich ishlar har ishga tushganda yangilanadi
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '',
    vehicle TEXT,
    sort INTEGER NOT NULL DEFAULT 0
  )
`);
const JOBS = [
  ['courier', 'Kuryer', '🛵', 'scooter', 10],
  ['waiter', 'Ofitsiant', '🍽️', null, 20],
];
const insertJob = db.prepare(`
  INSERT INTO jobs (slug, name, icon, vehicle, sort) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET name = excluded.name, icon = excluded.icon, vehicle = excluded.vehicle, sort = excluded.sort
`);
for (const j of JOBS) insertJob.run(...j);

// Foydalanuvchining ishlari: vehicle_at — ish transportini (masalan skuterni) qachon olgan (ms), NULL — hali olmagan
db.exec(`
  CREATE TABLE IF NOT EXISTS user_jobs (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    vehicle_at INTEGER,
    PRIMARY KEY (user_id, job_id)
  )
`);

export default db;
