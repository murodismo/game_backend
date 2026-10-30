// Ofitsiant ishi: profil (faqat ofitsiantlikka tegishli XP), smena, stollardagi buyurtmalar va menejer daromadi.
// Hamma hisob-kitob (vaqt, xatolar, haq, choychaqa, XP) shu yerda, serverda. Klient faqat ko'rsatadi.

// ---------- Sozlamalar ----------

const XP_MULT = Number(process.env.WAITER_XP_MULT) || 1; // sinash uchun: WAITER_XP_MULT=10 bilan tez ko'tariladi
const MAX_LEVEL = 5;
// Darajaga yetish uchun jami XP: 2 — 100, 3 — 300, 4 — 600, 5 — 1000
export const xpFor = (level) => 50 * (level - 1) * level;
export const levelOf = (xp) => {
  let l = 1;
  while (l < MAX_LEVEL && xp >= xpFor(l + 1)) l++;
  return l;
};

// Har daraja — yangi unvon. tables — zalda nechta stolga xizmat qiladi, tip — choychaqa koeffitsienti,
// items — bitta buyurtmada nechta taom (min, max), dishes — oshxona peshtaxtasida nechta xil taom
const RANKS = [
  { level: 1, slug: 'new', name: 'Yangi ofitsiant', tables: 1, tip: 1, items: [1, 2], dishes: 8, note: '1 ta stol, oddiy buyurtmalar' },
  { level: 2, slug: 'skilled', name: 'Tajribali ofitsiant', tables: 2, tip: 1.25, items: [2, 3], dishes: 10, note: "2 ta stol, yodlash vaqti +20%" },
  { level: 3, slug: 'head', name: 'Bosh ofitsiant', tables: 3, tip: 1.5, items: [2, 4], dishes: 12, note: "3 ta stol, katta buyurtmalar, choychaqa ×1.5" },
  { level: 4, slug: 'admin', name: 'Administrator', tables: 4, tip: 1.75, items: [3, 5], dishes: 14, note: '4 ta stol, bloknotga 1 marta bepul qarash' },
  { level: 5, slug: 'manager', name: 'Restoran menejeri', tables: 4, tip: 2, items: [3, 5], dishes: 14, note: 'Choychaqa ×2 va soatiga 15 tanga passiv daromad' },
];
const rankOf = (level) => RANKS[Math.min(level, MAX_LEVEL) - 1];

// Restoran menyusi (oshxona peshtaxtasidagi taomlar)
const MENU = [
  { id: 1, slug: 'osh', name: 'Osh', icon: '🍛' },
  { id: 2, slug: 'lagmon', name: "Lag'mon", icon: '🍜' },
  { id: 3, slug: 'manti', name: 'Manti', icon: '🥟' },
  { id: 4, slug: 'shashlik', name: 'Shashlik', icon: '🍢' },
  { id: 5, slug: 'somsa', name: 'Somsa', icon: '🥐' },
  { id: 6, slug: 'shorva', name: "Sho'rva", icon: '🍲' },
  { id: 7, slug: 'salat', name: 'Salat', icon: '🥗' },
  { id: 8, slug: 'non', name: 'Non', icon: '🍞' },
  { id: 9, slug: 'choy', name: "Ko'k choy", icon: '🍵' },
  { id: 10, slug: 'kompot', name: 'Kompot', icon: '🧃' },
  { id: 11, slug: 'qahva', name: 'Qahva', icon: '☕' },
  { id: 12, slug: 'tort', name: 'Tort', icon: '🍰' },
  { id: 13, slug: 'muzqaymoq', name: 'Muzqaymoq', icon: '🍨' },
  { id: 14, slug: 'limonad', name: 'Limonad', icon: '🍋' },
];

const GUESTS = ['Aziza opa', 'Bekzod', 'Dilnoza', 'Jasur aka', 'Malika', 'Otabek', 'Nodira', 'Sherzod', 'Kamola', 'Ulugbek', 'Feruza', 'Rustam aka'];
const OFFER_TTL = 10 * 60 * 1000; // mehmon 10 daqiqa kutadi, keyin ketadi
const EAT_MS = [3000, 5000]; // mehmon taomni 3–5 soniya yeydi, keyin turib ketadi
const ARRIVE_MS = [10000, 15000]; // mehmon ketgach bo'sh stolga yangisi 10–15 soniyada keladi
const PASSIVE_PER_H = 15; // menejerning soatlik daromadi
const PASSIVE_CAP_H = 8;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round1 = (x) => Math.round(x * 10) / 10;

export default function waiterRoutes(app, { db, requireAuth, coins }) {
  // ---------- Jadvallar ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS waiter_profile (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER NOT NULL DEFAULT 0,
      on_shift INTEGER NOT NULL DEFAULT 0,
      orders_done INTEGER NOT NULL DEFAULT 0,
      stars_sum INTEGER NOT NULL DEFAULT 0,
      earned INTEGER NOT NULL DEFAULT 0,
      tips INTEGER NOT NULL DEFAULT 0,
      passive_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  // Buyurtmalar. status: offer — mehmon stolda kutyapti, active — Sardor xizmat qilyapti, done — yopildi, cancelled.
  // phase (active uchun): take — buyurtmani eshityapti (yodlaydi), kitchen — oshxonada taom yig'yapti,
  // serve — patnis bilan stolga olib boryapti. data — JSON: stol, mehmon, taomlar.
  // mistakes — noto'g'ri patnis, noto'g'ri stol va bloknotga qarashlar soni (hammasi serverda sanaladi)
  db.exec(`
    CREATE TABLE IF NOT EXISTS waiter_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      phase TEXT,
      tbl INTEGER NOT NULL,
      data TEXT NOT NULL,
      reward INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      memo_ms INTEGER,
      time_limit INTEGER,
      accepted_at INTEGER,
      kitchen_at INTEGER,
      picked_at INTEGER,
      done_at INTEGER,
      mistakes INTEGER NOT NULL DEFAULT 0,
      peeks INTEGER NOT NULL DEFAULT 0,
      stars INTEGER,
      paid INTEGER,
      tip INTEGER,
      gained_xp INTEGER
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_waiter_orders_user ON waiter_orders(user_id, status)');

  const getProfile = db.prepare('SELECT * FROM waiter_profile WHERE user_id = ?');
  const addCoins = (userId, n) => {
    coins(userId);
    db.prepare('UPDATE user_wallet SET coins = coins + ? WHERE user_id = ?').run(n, userId);
  };
  function profile(userId) {
    const p = getProfile.get(userId);
    return p ? { ...p, level: levelOf(p.xp) } : null;
  }
  const payMult = (p) => 1 + 0.1 * (p.level - 1);
  const freePeeks = (p) => (p.level >= 4 ? 1 : 0);
  // buyurtmani yodlash uchun vaqt (ms): taom ko'p bo'lsa ko'proq, 2-darajadan +20%
  const memoFor = (p, items) => Math.round((2500 + 1500 * items) * (p.level >= 2 ? 1.2 : 1));

  function passive(p) {
    if (p.level < 5 || !p.passive_at) return 0;
    const h = Math.min(PASSIVE_CAP_H, (Date.now() - p.passive_at) / 3600000);
    return Math.floor(h * PASSIVE_PER_H);
  }

  // ---------- Mehmonlar (takliflar) ----------
  // delay — mehmon necha ms dan keyin keladi (created_at — kelish vaqti, undan oldin u ko'rinmaydi)
  function makeOffer(userId, p, tbl, delay) {
    const r = rankOf(p.level);
    const target = Math.floor(rnd(r.items[0], r.items[1] + 1));
    const lines = [];
    while (lines.reduce((n, l) => n + l.qty, 0) < target) {
      const d = pick(MENU);
      const l = lines.find((x) => x.dish === d.id);
      if (l) l.qty++; else lines.push({ dish: d.id, qty: 1 });
    }
    const items = target;
    const d = { guest: pick(GUESTS), lines, items, mood: pick(['😊', '🙂', '😋', '🤔']) };
    const reward = Math.round(5 + items * 3 + lines.length * 2);
    const xp = Math.max(4, Math.round(3 + items * 2 + lines.length));
    const at = Date.now() + delay;
    db.prepare('INSERT INTO waiter_orders (user_id, status, tbl, data, reward, xp, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(userId, 'offer', tbl, JSON.stringify(d), reward, xp, at, at + OFFER_TTL + Math.floor(Math.random() * 60000));
  }

  // stoldagi oxirgi mehmon qachon ovqatini yeb bo'ladi (ms)
  function eatUntil(userId, tbl) {
    const r = db.prepare("SELECT data, done_at FROM waiter_orders WHERE user_id = ? AND tbl = ? AND status = 'done' ORDER BY id DESC LIMIT 1").get(userId, tbl);
    return r ? JSON.parse(r.data).eatUntil || r.done_at : 0;
  }

  // bo'sh stollarga yangi mehmon o'tiradi: oldingi mehmon yeb, turib ketgach 10–15 soniyada (smena boshida — darhol).
  // Uzoq kutgan mehmon ketadi
  function refill(userId, p, instant = false) {
    db.prepare("DELETE FROM waiter_orders WHERE user_id = ? AND status = 'offer' AND (expires_at < ? OR tbl > ?)").run(userId, Date.now(), rankOf(p.level).tables);
    const busy = new Set(db.prepare("SELECT tbl FROM waiter_orders WHERE user_id = ? AND status IN ('offer', 'active')").all(userId).map((x) => x.tbl));
    for (let t = 1; t <= rankOf(p.level).tables; t++) if (!busy.has(t)) {
      const wait = instant ? 0 : Math.max(0, eatUntil(userId, t) - Date.now()) + Math.round(rnd(ARRIVE_MS[0], ARRIVE_MS[1]));
      makeOffer(userId, p, t, wait);
    }
  }

  // ---------- Holat ----------
  function orderRow(r, p) {
    const d = JSON.parse(r.data);
    return {
      id: r.id, status: r.status, phase: r.phase, table: r.tbl, ...d, arrivesAt: r.created_at,
      reward: Math.round(r.reward * payMult(p)), xp: r.xp, expiresAt: r.expires_at,
      memoMs: r.memo_ms, timeLimit: r.time_limit,
      acceptedAt: r.accepted_at, kitchenAt: r.kitchen_at, pickedAt: r.picked_at, doneAt: r.done_at,
      mistakes: r.mistakes, peeks: r.peeks, stars: r.stars, paid: r.paid, tip: r.tip, gainedXp: r.gained_xp,
    };
  }

  function state(userId) {
    const p = profile(userId);
    const wallet = coins(userId);
    if (!p) return { hired: false, coins: wallet, now: Date.now(), menu: MENU, ranks: RANKS };
    if (p.on_shift) refill(userId, p);
    const rows = db.prepare("SELECT * FROM waiter_orders WHERE user_id = ? AND status IN ('offer', 'active', 'done') ORDER BY id DESC LIMIT 20").all(userId);
    const now = Date.now();
    const list = rows.map((r) => orderRow(r, p));
    const rank = rankOf(p.level);
    return {
      hired: true, now: Date.now(), coins: wallet, xpMult: XP_MULT, menu: MENU,
      profile: {
        xp: p.xp, level: p.level, maxLevel: MAX_LEVEL,
        levelXp: xpFor(p.level), nextXp: p.level < MAX_LEVEL ? xpFor(p.level + 1) : null,
        rank, nextRank: RANKS[p.level] || null, tables: rank.tables, freePeeks: freePeeks(p),
        onShift: Boolean(p.on_shift),
        ordersDone: p.orders_done, avgStars: p.orders_done ? round1(p.stars_sum / p.orders_done) : null,
        earned: p.earned, tips: p.tips, payMult: Math.round(payMult(p) * 100) / 100,
      },
      ranks: RANKS.map((r) => ({ ...r, open: p.level >= r.level, xp: xpFor(r.level) })),
      offers: p.on_shift ? list.filter((o) => o.status === 'offer' && o.arrivesAt <= now).sort((a, b) => a.table - b.table) : [],
      // keyingi mehmon qachon keladi (klient shu vaqtda holatni qayta oladi)
      nextGuestAt: p.on_shift ? list.filter((o) => o.status === 'offer' && o.arrivesAt > now).reduce((m, o) => Math.min(m, o.arrivesAt), Infinity) : null,
      // hozir ovqat yeyayotgan mehmonlar (stolda o'tirib turadi)
      eating: p.on_shift ? list.filter((o) => o.status === 'done' && o.eatUntil > now).map((o) => ({ id: o.id, table: o.table, guest: o.guest, eatUntil: o.eatUntil })) : [],
      active: list.find((o) => o.status === 'active') || null,
      manager: p.level >= 5 ? { passive: passive(p), cap: PASSIVE_PER_H * PASSIVE_CAP_H, perHour: PASSIVE_PER_H } : null,
      history: list.filter((o) => o.status === 'done').slice(0, 5),
    };
  }

  // ---------- Yordamchilar ----------
  const fail = (res, code, error) => res.status(code).json({ error });
  function need(req, res) {
    const p = profile(req.user.id);
    if (!p) { fail(res, 400, "Avval ofitsiant bo'lib ishga kiring"); return null; }
    return p;
  }
  const getOrder = (userId, id) => db.prepare('SELECT * FROM waiter_orders WHERE id = ? AND user_id = ?').get(Number(id), userId);
  const active = (userId, id) => {
    const o = getOrder(userId, id);
    return o && o.status === 'active' ? o : null;
  };
  const addMistake = (id) => db.prepare('UPDATE waiter_orders SET mistakes = mistakes + 1 WHERE id = ?').run(id);
  function gainXp(userId, n) {
    const x = Math.round(n * XP_MULT);
    db.prepare('UPDATE waiter_profile SET xp = xp + ? WHERE user_id = ?').run(x, userId);
    return x;
  }
  const courierOnShift = (userId) => {
    try { return Boolean(db.prepare('SELECT on_shift FROM courier_profile WHERE user_id = ?').get(userId)?.on_shift); } catch { return false; }
  };

  // ---------- Routelar ----------
  app.get('/api/waiter', requireAuth, (req, res) => res.json(state(req.user.id)));

  app.post('/api/waiter/hire', requireAuth, (req, res) => {
    if (!getProfile.get(req.user.id)) {
      db.prepare('INSERT INTO waiter_profile (user_id, created_at) VALUES (?, ?)').run(req.user.id, Date.now());
    }
    res.json(state(req.user.id));
  });

  // Smena: faqat smenada telefonda Ofitsiant ilovasi ko'rinadi va mehmonlar keladi
  app.post('/api/waiter/shift', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const on = req.body?.on === true;
    if (on && courierOnShift(req.user.id)) return fail(res, 400, 'Avval kuryer smenasini yakunlang');
    if (!on && db.prepare("SELECT 1 FROM waiter_orders WHERE user_id = ? AND status = 'active'").get(req.user.id)) {
      return fail(res, 400, 'Avval buyurtmani stolga olib boring yoki bekor qiling');
    }
    db.prepare('UPDATE waiter_profile SET on_shift = ? WHERE user_id = ?').run(on ? 1 : 0, req.user.id);
    if (on) refill(req.user.id, profile(req.user.id), true); // smena boshida birinchi mehmonlar kutib turadi
    res.json(state(req.user.id));
  });

  // Mehmonlarni almashtirish (hamma kutayotgan mehmon ketadi, yangilari keladi)
  app.post('/api/waiter/offers/refresh', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    db.prepare("DELETE FROM waiter_orders WHERE user_id = ? AND status = 'offer'").run(req.user.id);
    res.json(state(req.user.id));
  });

  // Stolga borish: mehmon buyurtma aytadi (take). Muddat shu yerda hisoblanadi
  app.post('/api/waiter/orders/:id/accept', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    if (!p.on_shift) return fail(res, 400, 'Avval smenani boshlang');
    const o = getOrder(req.user.id, req.params.id);
    if (!o || o.status !== 'offer' || o.expires_at < Date.now() || o.created_at > Date.now()) return fail(res, 404, 'Mehmon topilmadi yoki ketib qolgan');
    if (db.prepare("SELECT 1 FROM waiter_orders WHERE user_id = ? AND status = 'active'").get(req.user.id)) {
      return fail(res, 400, 'Avval hozirgi buyurtmani tugating');
    }
    const d = JSON.parse(o.data);
    const memo = memoFor(p, d.items);
    const limit = Math.ceil(memo / 1000 + 14 + 5 * d.items + 2 * rankOf(p.level).tables);
    db.prepare("UPDATE waiter_orders SET status = 'active', phase = 'take', memo_ms = ?, time_limit = ?, accepted_at = ? WHERE id = ?")
      .run(memo, limit, Date.now(), o.id);
    res.json(state(req.user.id));
  });

  // Buyurtma yodlandi: oshxonaga ketadi. Yodlash vaqti tugamasdan ham borish mumkin
  app.post('/api/waiter/orders/:id/kitchen', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'take') return fail(res, 400, 'Buyurtma hali olinmagan');
    if (Date.now() < o.accepted_at + 1000) return fail(res, 400, 'Mehmon hali gapiryapti');
    db.prepare("UPDATE waiter_orders SET phase = 'kitchen', kitchen_at = ? WHERE id = ?").run(Date.now(), o.id);
    res.json(state(req.user.id));
  });

  // Bloknotga qarash (oshxonada): buyurtma ro'yxati qisqa vaqt ko'rinadi. 4-darajadan 1 marta bepul, keyin — xato
  app.post('/api/waiter/orders/:id/peek', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'kitchen') return fail(res, 400, 'Siz oshxonada emassiz');
    const free = o.peeks < freePeeks(p);
    db.prepare(`UPDATE waiter_orders SET peeks = peeks + 1, mistakes = mistakes + ${free ? 0 : 1} WHERE id = ?`).run(o.id);
    res.json({ ...state(req.user.id), peek: { free } });
  });

  // Patnis tayyor: taomlar buyurtma bilan aynan bir xil bo'lishi kerak. Noto'g'ri bo'lsa — xato (+1), qayta urinish
  app.post('/api/waiter/orders/:id/pickup', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'kitchen') return fail(res, 400, 'Siz oshxonada emassiz');
    if (Date.now() < o.kitchen_at + 1000) return fail(res, 400, 'Oshxonaga hali yetib kelmadingiz');
    const d = JSON.parse(o.data);
    const tray = Array.isArray(req.body?.tray) ? req.body.tray : [];
    const want = new Map(d.lines.map((l) => [l.dish, l.qty]));
    const got = new Map();
    for (const x of tray) if (Number.isInteger(x?.dish) && Number.isInteger(x?.qty) && x.qty > 0) got.set(x.dish, (got.get(x.dish) || 0) + x.qty);
    const wrong = [...new Set([...want.keys(), ...got.keys()])].reduce((n, k) => n + Math.abs((want.get(k) || 0) - (got.get(k) || 0)), 0);
    if (wrong) {
      addMistake(o.id);
      return fail(res, 400, `Patnisda ${wrong} ta xato bor. Buyurtmani eslang!`);
    }
    db.prepare("UPDATE waiter_orders SET phase = 'serve', picked_at = ? WHERE id = ?").run(Date.now(), o.id);
    res.json(state(req.user.id));
  });

  // Taomni stolga qo'yish: to'g'ri stol bo'lishi kerak. Yulduz, haq, choychaqa va XP shu yerda hisoblanadi
  app.post('/api/waiter/orders/:id/serve', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'serve') return fail(res, 400, 'Patnis hali tayyor emas');
    const now = Date.now();
    if (now < o.picked_at + 800) return fail(res, 400, 'Hali stolga yetib kelmadingiz');
    if (Number(req.body?.table) !== o.tbl) {
      addMistake(o.id);
      return fail(res, 400, `${Number(req.body?.table) || '?'}-stol bu taomni buyurtma qilmagan!`);
    }
    const ratio = (now - o.accepted_at) / 1000 / o.time_limit;
    let stars = ratio <= 0.6 ? 5 : ratio <= 0.8 ? 4 : ratio <= 1 ? 3 : ratio <= 1.4 ? 2 : 1;
    stars -= (o.mistakes >= 1 ? 1 : 0) + (o.mistakes >= 3 ? 1 : 0);
    stars = Math.max(1, stars);
    const base = o.reward * payMult(p) * (ratio > 1 ? 0.8 : 1);
    const tip = Math.round(base * (stars === 5 ? 0.3 : stars === 4 ? 0.15 : stars === 3 ? 0.05 : 0) * rankOf(p.level).tip);
    const paid = Math.round(base) + tip;
    const before = p.level;
    const gained = gainXp(req.user.id, o.xp * (0.5 + stars / 10));
    addCoins(req.user.id, paid);
    // mehmon 3–5 soniya ovqat yeydi (stolda o'tirib turadi), keyin ketadi
    const data = { ...JSON.parse(o.data), eatUntil: now + Math.round(rnd(EAT_MS[0], EAT_MS[1])) };
    db.prepare("UPDATE waiter_orders SET status = 'done', phase = NULL, done_at = ?, stars = ?, paid = ?, tip = ?, gained_xp = ?, data = ? WHERE id = ?")
      .run(now, stars, paid, tip, gained, JSON.stringify(data), o.id);
    db.prepare('UPDATE waiter_profile SET orders_done = orders_done + 1, stars_sum = stars_sum + ?, earned = earned + ?, tips = tips + ? WHERE user_id = ?')
      .run(stars, paid, tip, req.user.id);
    const after = levelOf(getProfile.get(req.user.id).xp);
    if (after >= 5) db.prepare('UPDATE waiter_profile SET passive_at = COALESCE(passive_at, ?) WHERE user_id = ?').run(now, req.user.id);
    res.json({
      ...state(req.user.id),
      result: {
        stars, paid, tip, xp: gained, late: ratio > 1, mistakes: o.mistakes, table: o.tbl, guest: JSON.parse(o.data).guest,
        levelUp: after > before ? { level: after, rank: rankOf(after) } : null,
      },
    });
  });

  app.post('/api/waiter/orders/:id/cancel', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o) return fail(res, 404, 'Buyurtma topilmadi');
    db.prepare("UPDATE waiter_orders SET status = 'cancelled', phase = NULL WHERE id = ?").run(o.id);
    res.json(state(req.user.id));
  });

  // Restoran menejeri: soatlik passiv daromadni olish
  app.post('/api/waiter/manager/claim', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    if (p.level < 5) return fail(res, 400, '5-daraja (Restoran menejeri) kerak');
    const total = passive(p);
    if (!total) return fail(res, 400, "Hozircha yig'adigan daromad yo'q");
    addCoins(req.user.id, total);
    db.prepare('UPDATE waiter_profile SET passive_at = ?, earned = earned + ? WHERE user_id = ?').run(Date.now(), total, req.user.id);
    res.json({ ...state(req.user.id), claimed: total });
  });
}
