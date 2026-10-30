// Kuryer ishi: profil (faqat kuryerlikka tegishli XP), smena, buyurtmalar, transport, skillar va dispetcherlik.
// Hamma hisob-kitob (vaqt, haq, XP) shu yerda, serverda. Klient faqat ko'rsatadi.

// ---------- Sozlamalar ----------

const XP_MULT = Number(process.env.COURIER_XP_MULT) || 1; // sinash uchun: COURIER_XP_MULT=10 bilan tez ko'tariladi
const MAX_LEVEL = 10;
const XP_SLOW = 6; // buyurtma XP si shuncha baravar kam beriladi (foydalanuvchi so'rovi)
// Darajaga yetish uchun jami XP: 2 — 100, 3 — 300, 4 — 600, 5 — 1000 ...
export const xpFor = (level) => 50 * (level - 1) * level;
export const levelOf = (xp) => {
  let l = 1;
  while (l < MAX_LEVEL && xp >= xpFor(l + 1)) l++;
  return l;
};

// Unvonlar: darajaga qarab
const RANKS = [
  { level: 1, slug: 'foot', name: 'Piyoda kuryer', note: 'Yaqin manzillar' },
  { level: 2, slug: 'scooter', name: 'Skuter kuryer', note: "Tezroq, ko'proq buyurtma" },
  { level: 4, slug: 'moped', name: 'Moped kuryer', note: 'Uzoq manzillar' },
  { level: 6, slug: 'car', name: 'Mashinali kuryer', note: 'Katta buyurtmalar' },
  { level: 8, slug: 'dispatcher', name: 'Katta kuryer', note: 'Buyurtma taqsimlaydi, passiv daromad' },
];
const rankOf = (level) => [...RANKS].reverse().find((r) => level >= r.level);

// Transport: secPerKm — 1 km necha soniya, maxKm — eng uzoq manzil, maxItems — bitta buyurtmada nechta mahsulot
const VEHICLES = [
  { slug: 'foot', name: 'Piyoda', icon: '🚶', level: 1, price: 0, secPerKm: 9, maxKm: 1.5, maxItems: 4, big: false },
  { slug: 'scooter', name: 'Skuter', icon: '🛵', level: 2, price: 0, secPerKm: 4.5, maxKm: 3.5, maxItems: 6, big: false },
  { slug: 'moped', name: 'Elektromoped', icon: '⚡', level: 4, price: 120, secPerKm: 3.5, maxKm: 7, maxItems: 7, big: false },
  { slug: 'car', name: 'Mashina', icon: '🚗', level: 6, price: 350, secPerKm: 3, maxKm: 8, maxItems: 12, big: true },
];
const vehicleBy = (slug) => VEHICLES.find((v) => v.slug === slug);

// Skillar: har daraja 1 ochko beradi. need — avval ochilishi kerak bo'lgan skill
const SKILLS = [
  { slug: 'fast', name: 'Tezkor', icon: '💨', level: 2, need: null, text: "Yo'lda 15% tezroq" },
  { slug: 'memory', name: 'Yaxshi xotira', icon: '🧠', level: 3, need: null, text: "Do'konda kerakli mahsulotlar yorishib turadi" },
  { slug: 'navigator', name: 'Navigator', icon: '🧭', level: 3, need: 'fast', text: "Buyurtma vaqti 20% ko'proq" },
  { slug: 'polite', name: 'Xushmuomala', icon: '😊', level: 4, need: null, text: 'Choychaqa 2 baravar' },
  { slug: 'bag', name: 'Katta sumka', icon: '🎒', level: 5, need: null, text: "Har transportga +3 mahsulot sig'adi" },
  { slug: 'pro', name: 'Tajriba', icon: '⭐', level: 6, need: 'polite', text: "Har buyurtma haqi +15%" },
  { slug: 'dispatcher', name: 'Dispetcher', icon: '📡', level: 8, need: null, text: 'Buyurtmalarni boshqa kuryerlarga taqsimlaysiz: 25% ulush va soatiga 12 tanga' },
  { slug: 'team', name: 'Jamoa', icon: '👥', level: 9, need: 'dispatcher', text: "4 ta kuryerga taqsimlash, ulush 35%" },
];

const SHOPS = ['Baraka market', "Yashil do'kon", 'Mevazor', 'Oqshom supermarket', 'Shirin non', 'Doim ochiq'];
const CUSTOMERS = ['Aziza opa', 'Bekzod', 'Dilnoza', 'Jasur aka', 'Malika', 'Otabek', 'Nodira', 'Sherzod', 'Kamola', 'Ulugbek'];
const STREETS = ["Navro'z", 'Bodomzor', 'Chilonzor', 'Yunusobod', 'Mustaqillik', 'Olmazor', 'Bunyodkor', 'Sebzor'];
const NPCS = ['Ali', 'Sardorbek', 'Madina', 'Javlon', 'Laylo', 'Temur'];

const OFFER_TTL = 15 * 60 * 1000; // taklif 15 daqiqa turadi
const PASSIVE_PER_H = 12; // dispetcherning soatlik maoshi
const PASSIVE_CAP_H = 8;
// buyurtma haqi koeffitsienti: kuryerning soatlik daromadi ofitsiantnikiga (5-daraja, ~8 800 tanga/soat) teng bo'lsin
const PAY_SCALE = 0.72;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round1 = (x) => Math.round(x * 10) / 10;

export default function courierRoutes(app, { db, requireAuth, coins }) {
  // ---------- Jadvallar ----------
  // vehicles, skills — JSON massiv (sotib olingan transportlar, ochilgan skillar)
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_profile (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      xp INTEGER NOT NULL DEFAULT 0,
      vehicle TEXT NOT NULL DEFAULT 'foot',
      vehicles TEXT NOT NULL DEFAULT '["foot"]',
      skills TEXT NOT NULL DEFAULT '[]',
      on_shift INTEGER NOT NULL DEFAULT 0,
      orders_done INTEGER NOT NULL DEFAULT 0,
      stars_sum INTEGER NOT NULL DEFAULT 0,
      earned INTEGER NOT NULL DEFAULT 0,
      passive_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  // Buyurtmalar. status: offer — taklif, active — Sardor bajaryapti, dispatched — boshqa kuryerga berilgan,
  // done — yetkazildi, paid — dispetcher ulushi olindi, cancelled. phase (active uchun): shop — do'konga ketyapti,
  // pick — do'konda, deliver — mijozga ketyapti. data — JSON: do'kon, mijoz, manzil, mahsulotlar, masofalar.
  db.exec(`
    CREATE TABLE IF NOT EXISTS courier_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      phase TEXT,
      data TEXT NOT NULL,
      reward INTEGER NOT NULL,
      xp INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      vehicle TEXT,
      to_shop INTEGER,
      to_customer INTEGER,
      time_limit INTEGER,
      accepted_at INTEGER,
      arrived_at INTEGER,
      picked_at INTEGER,
      done_at INTEGER,
      mistakes INTEGER NOT NULL DEFAULT 0,
      stars INTEGER,
      paid INTEGER,
      gained_xp INTEGER,
      npc TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_courier_orders_user ON courier_orders(user_id, status)');
  // location — Sardor hozir qayerda: depot — kuryer xizmati, house — oxirgi buyurtma yetkazilgan uy.
  // Keyingi buyurtma shu yerdan boshlanadi, smena tugaganda kuryer xizmatiga qaytadi
  if (!db.prepare('PRAGMA table_info(courier_profile)').all().some((c) => c.name === 'location')) {
    db.exec("ALTER TABLE courier_profile ADD COLUMN location TEXT NOT NULL DEFAULT 'depot'");
  }
  // Bir martalik o'zgarishlar (har biri faqat bir marta bajariladi)
  db.exec('CREATE TABLE IF NOT EXISTS courier_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  if (!db.prepare("SELECT 1 FROM courier_migrations WHERE name = 'xp-slow-6'").get()) {
    // eski takliflar va bajarilayotgan buyurtmalarning XP si ham kamaytiriladi
    db.prepare("UPDATE courier_orders SET xp = MAX(3, ROUND(xp / 6.0)) WHERE status IN ('offer', 'active')").run();
    db.prepare("INSERT INTO courier_migrations (name, at) VALUES ('xp-slow-6', ?)").run(Date.now());
  }
  if (!db.prepare("SELECT 1 FROM courier_migrations WHERE name = 'level-6'").get()) {
    // foydalanuvchi so'rovi: kuryer darajasi 6 (1500 XP). 5 ta skill ochkosi daraja bilan o'zi keladi
    db.prepare('UPDATE courier_profile SET xp = ? WHERE xp < ?').run(xpFor(6), xpFor(6));
    db.prepare("INSERT INTO courier_migrations (name, at) VALUES ('level-6', ?)").run(Date.now());
  }

  const getProfile = db.prepare('SELECT * FROM courier_profile WHERE user_id = ?');
  const addCoins = (userId, n) => {
    coins(userId);
    db.prepare('UPDATE user_wallet SET coins = coins + ? WHERE user_id = ?').run(n, userId);
  };

  function profile(userId) {
    const p = getProfile.get(userId);
    if (!p) return null;
    return { ...p, vehicles: JSON.parse(p.vehicles), skills: JSON.parse(p.skills), level: levelOf(p.xp) };
  }
  const has = (p, skill) => p.skills.includes(skill);
  // transport bilan skillar hisobga olingan imkoniyatlar
  function ability(p, slug = p.vehicle) {
    const v = vehicleBy(slug);
    return { ...v, secPerKm: v.secPerKm * (has(p, 'fast') ? 0.85 : 1), maxItems: v.maxItems + (has(p, 'bag') ? 3 : 0) };
  }
  // buyurtmani qaysi eng oddiy transport bajara oladi
  function needs(p, d) {
    return VEHICLES.find((v) => {
      const a = ability(p, v.slug);
      return d.km <= a.maxKm && d.items <= a.maxItems && (!d.big || a.big);
    })?.slug || 'car';
  }

  // ---------- Taklif yaratish ----------
  const foodsForSale = () => db.prepare("SELECT id, kind, name FROM foods WHERE price IS NOT NULL AND slug != 'spoiled'").all();

  function makeOffer(userId, p) {
    const lvl = p.level;
    const open = VEHICLES.filter((v) => v.level <= lvl);
    // asosan o'z transportiga mos, ba'zan keyingi bosqichniki (qulfli — motivatsiya uchun)
    let ti = Math.min(open.length - 1, Math.floor(Math.pow(Math.random(), 0.7) * open.length));
    if (Math.random() < 0.2 && open.length < VEHICLES.length) ti = open.length; // hamma transport ochiq bo'lsa — yo'q
    const tier = VEHICLES[ti];
    const lo = ti ? VEHICLES[ti - 1].maxKm * 0.7 : 0.4;
    const km = round1(rnd(lo, tier.maxKm));
    const big = tier.big && Math.random() < 0.7;
    const foods = foodsForSale();
    const small = foods.filter((f) => f.kind !== 'big');
    const lines = [];
    const add = (f, q) => {
      const l = lines.find((x) => x.food === f.id);
      if (l) l.qty += q; else lines.push({ food: f.id, qty: q });
    };
    if (big) {
      add(pick(foods.filter((f) => f.kind === 'big')), 1);
      const target = Math.floor(rnd(6, 10));
      while (lines.reduce((n, l) => n + l.qty, 0) < target) add(pick(small), 1 + Math.floor(Math.random() * 2));
    } else {
      const maxItems = Math.max(2, Math.min(tier.maxItems, ti === 0 ? 3 : 6));
      const target = Math.floor(rnd(1, maxItems + 1));
      while (lines.reduce((n, l) => n + l.qty, 0) < target) add(pick(small), 1);
    }
    const items = lines.reduce((n, l) => n + l.qty, 0);
    const shopKm = round1(rnd(0.3, Math.min(1.2, Math.max(0.4, km * 0.6))));
    const d = {
      shop: pick(SHOPS), customer: pick(CUSTOMERS),
      address: `${pick(STREETS)} ko'chasi, ${1 + Math.floor(Math.random() * 60)}-uy`,
      lines, items, km, shopKm, big,
    };
    d.size = big ? 'big' : items <= 3 ? 'small' : 'medium';
    const reward = Math.round((6 + (km + shopKm) * 4 + items * 2 + (big ? 15 : 0)) * PAY_SCALE);
    // XP sekin yig'ilsin: bitta buyurtma 4–12 XP (avvalgidan ~6 baravar kam)
    const xp = Math.max(3, Math.round((20 + km * 5 + items * 3 + (big ? 20 : 0)) / XP_SLOW));
    const now = Date.now();
    db.prepare('INSERT INTO courier_orders (user_id, status, data, reward, xp, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, 'offer', JSON.stringify(d), reward, xp, now, now + OFFER_TTL + Math.floor(Math.random() * 60000));
  }

  // eskirgan takliflarni o'chiradi va yetishmaganini to'ldiradi
  function refill(userId, p) {
    db.prepare("DELETE FROM courier_orders WHERE user_id = ? AND status = 'offer' AND expires_at < ?").run(userId, Date.now());
    const want = 4 + (p.level >= 4 ? 1 : 0);
    const have = db.prepare("SELECT COUNT(*) AS n FROM courier_orders WHERE user_id = ? AND status = 'offer'").get(userId).n;
    for (let i = have; i < want; i++) makeOffer(userId, p);
  }

  // ---------- Holat ----------
  function orderRow(r, p) {
    const d = JSON.parse(r.data);
    return {
      id: r.id, status: r.status, phase: r.phase, ...d,
      reward: Math.round(r.reward * payMult(p)), xp: r.xp,
      needs: needs(p, d), expiresAt: r.expires_at,
      vehicle: r.vehicle, toShop: r.to_shop, toCustomer: r.to_customer, timeLimit: r.time_limit,
      acceptedAt: r.accepted_at, arrivedAt: r.arrived_at, pickedAt: r.picked_at, doneAt: r.done_at,
      stars: r.stars, paid: r.paid, gainedXp: r.gained_xp, npc: r.npc,
    };
  }
  // daraja va "Tajriba" skilli haqni oshiradi
  const payMult = (p) => (1 + 0.12 * (p.level - 1)) * (has(p, 'pro') ? 1.15 : 1);
  const commission = (p) => (has(p, 'team') ? 0.35 : 0.25);
  const dispatchSlots = (p) => (has(p, 'team') ? 4 : 2);

  function passive(p) {
    if (!has(p, 'dispatcher') || !p.passive_at) return 0;
    const h = Math.min(PASSIVE_CAP_H, (Date.now() - p.passive_at) / 3600000);
    return Math.floor(h * PASSIVE_PER_H);
  }

  function state(userId) {
    const p = profile(userId);
    const wallet = coins(userId);
    const job = db.prepare("SELECT uj.vehicle_at FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE j.slug = 'courier' AND uj.user_id = ?").get(userId);
    if (!p) return { hired: false, coins: wallet, hadScooter: Boolean(job?.vehicle_at), now: Date.now() };
    if (p.on_shift) refill(userId, p);
    const rows = db.prepare("SELECT * FROM courier_orders WHERE user_id = ? AND status IN ('offer', 'active', 'dispatched', 'done') ORDER BY id DESC LIMIT 40").all(userId);
    const now = Date.now();
    const list = rows.map((r) => orderRow(r, p));
    const rank = rankOf(p.level);
    const next = RANKS.find((r) => r.level > p.level);
    const spent = p.skills.length;
    const dispatched = list.filter((o) => o.status === 'dispatched');
    return {
      hired: true, now, coins: wallet,
      xpMult: XP_MULT,
      profile: {
        xp: p.xp, level: p.level, maxLevel: MAX_LEVEL,
        levelXp: xpFor(p.level), nextXp: p.level < MAX_LEVEL ? xpFor(p.level + 1) : null,
        rank, nextRank: next || null,
        vehicle: p.vehicle, onShift: Boolean(p.on_shift), location: p.location,
        skillPoints: p.level - 1 - spent,
        ordersDone: p.orders_done, avgStars: p.orders_done ? round1(p.stars_sum / p.orders_done) : null, earned: p.earned,
        payMult: Math.round(payMult(p) * 100) / 100,
      },
      ranks: RANKS.map((r) => ({ ...r, open: p.level >= r.level })),
      vehicles: VEHICLES.map((v) => {
        const a = ability(p, v.slug);
        return { ...v, maxItems: a.maxItems, secPerKm: round1(a.secPerKm), open: p.level >= v.level, owned: p.vehicles.includes(v.slug) || v.price === 0 };
      }),
      skills: SKILLS.map((s) => ({ ...s, owned: has(p, s.slug), can: !has(p, s.slug) && p.level >= s.level && (!s.need || has(p, s.need)) && p.level - 1 - spent > 0 })),
      offers: p.on_shift ? list.filter((o) => o.status === 'offer').reverse() : [],
      active: list.find((o) => o.status === 'active') || null,
      dispatcher: has(p, 'dispatcher') ? {
        slots: dispatchSlots(p), share: commission(p),
        orders: dispatched.map((o) => ({ ...o, ready: o.doneAt <= now })),
        passive: passive(p), passiveCap: PASSIVE_PER_H * PASSIVE_CAP_H, perHour: PASSIVE_PER_H,
      } : null,
      history: list.filter((o) => o.status === 'done').slice(0, 5),
    };
  }

  // ---------- Yordamchilar ----------
  const fail = (res, code, error) => res.status(code).json({ error });
  function need(req, res) {
    const p = profile(req.user.id);
    if (!p) { fail(res, 400, 'Avval kuryer bo\'lib ishga kiring'); return null; }
    return p;
  }
  const getOrder = (userId, id) => db.prepare('SELECT * FROM courier_orders WHERE id = ? AND user_id = ?').get(Number(id), userId);
  function gainXp(userId, n) {
    db.prepare('UPDATE courier_profile SET xp = xp + ? WHERE user_id = ?').run(Math.round(n * XP_MULT), userId);
    return Math.round(n * XP_MULT);
  }

  // ---------- Routelar ----------
  app.get('/api/courier', requireAuth, (req, res) => res.json(state(req.user.id)));

  // Ishga kirish. Avvalgi versiyada skuter olgan bo'lsa, darhol 2-daraja (skuter kuryer) bilan boshlaydi
  app.post('/api/courier/hire', requireAuth, (req, res) => {
    if (!getProfile.get(req.user.id)) {
      const job = db.prepare("SELECT uj.vehicle_at FROM user_jobs uj JOIN jobs j ON j.id = uj.job_id WHERE j.slug = 'courier' AND uj.user_id = ?").get(req.user.id);
      const old = Boolean(job?.vehicle_at);
      db.prepare('INSERT INTO courier_profile (user_id, xp, vehicle, vehicles, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, old ? xpFor(2) : 0, old ? 'scooter' : 'foot', JSON.stringify(old ? ['foot', 'scooter'] : ['foot']), Date.now());
    }
    res.json(state(req.user.id));
  });

  // Smena: faqat smenada telefonda Kuryer ilovasi ko'rinadi va buyurtma olinadi
  app.post('/api/courier/shift', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const on = req.body?.on === true;
    if (!on && db.prepare("SELECT 1 FROM courier_orders WHERE user_id = ? AND status = 'active'").get(req.user.id)) {
      return fail(res, 400, 'Avval buyurtmani yetkazing yoki bekor qiling');
    }
    // smena tugasa Sardor kuryer xizmatiga qaytadi
    db.prepare(`UPDATE courier_profile SET on_shift = ?, location = CASE WHEN ? THEN location ELSE 'depot' END WHERE user_id = ?`).run(on ? 1 : 0, on ? 1 : 0, req.user.id);
    res.json(state(req.user.id));
  });

  // Transport tanlash (kerak bo'lsa sotib olish). Daraja yetmasa — qulf
  app.post('/api/courier/vehicle', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const v = vehicleBy(req.body?.vehicle);
    if (!v) return fail(res, 400, "Bunday transport yo'q");
    if (p.level < v.level) return fail(res, 400, `${v.name} ${v.level}-darajada ochiladi`);
    if (db.prepare("SELECT 1 FROM courier_orders WHERE user_id = ? AND status = 'active'").get(req.user.id)) {
      return fail(res, 400, 'Buyurtma paytida transportni almashtirib bo\'lmaydi');
    }
    const vehicles = new Set(p.vehicles);
    if (!vehicles.has(v.slug) && v.price > 0) {
      if (coins(req.user.id) < v.price) return fail(res, 400, 'Tanga yetmaydi');
      db.prepare('UPDATE user_wallet SET coins = coins - ? WHERE user_id = ?').run(v.price, req.user.id);
    }
    vehicles.add(v.slug);
    db.prepare('UPDATE courier_profile SET vehicle = ?, vehicles = ? WHERE user_id = ?').run(v.slug, JSON.stringify([...vehicles]), req.user.id);
    res.json(state(req.user.id));
  });

  app.post('/api/courier/skills', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const s = SKILLS.find((x) => x.slug === req.body?.skill);
    if (!s) return fail(res, 400, "Bunday skill yo'q");
    if (has(p, s.slug)) return fail(res, 400, 'Bu skill allaqachon ochilgan');
    if (p.level < s.level) return fail(res, 400, `${s.level}-daraja kerak`);
    if (s.need && !has(p, s.need)) return fail(res, 400, `Avval "${SKILLS.find((x) => x.slug === s.need).name}" ni oching`);
    if (p.level - 1 - p.skills.length <= 0) return fail(res, 400, "Skill ochkosi yo'q");
    db.prepare('UPDATE courier_profile SET skills = ?, passive_at = COALESCE(passive_at, ?) WHERE user_id = ?')
      .run(JSON.stringify([...p.skills, s.slug]), s.slug === 'dispatcher' ? Date.now() : null, req.user.id);
    res.json(state(req.user.id));
  });

  // Takliflarni yangilash
  app.post('/api/courier/offers/refresh', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    db.prepare("DELETE FROM courier_orders WHERE user_id = ? AND status = 'offer'").run(req.user.id);
    res.json(state(req.user.id));
  });

  // Buyurtmani olish: yo'l vaqtlari va muddat shu transportga qarab hisoblanadi
  app.post('/api/courier/orders/:id/accept', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    if (!p.on_shift) return fail(res, 400, 'Avval smenani boshlang');
    const o = getOrder(req.user.id, req.params.id);
    if (!o || o.status !== 'offer' || o.expires_at < Date.now()) return fail(res, 404, 'Buyurtma topilmadi yoki eskirgan');
    if (db.prepare("SELECT 1 FROM courier_orders WHERE user_id = ? AND status = 'active'").get(req.user.id)) {
      return fail(res, 400, 'Sizda bajarilayotgan buyurtma bor');
    }
    const d = JSON.parse(o.data);
    const a = ability(p);
    if (d.km > a.maxKm) return fail(res, 400, `${a.name} uchun juda uzoq (${a.maxKm} km gacha)`);
    if (d.items > a.maxItems) return fail(res, 400, `${a.name}ga ${a.maxItems} tagacha mahsulot sig'adi`);
    if (d.big && !a.big) return fail(res, 400, 'Katta buyurtma uchun mashina kerak');
    const toShop = Math.max(3, Math.round(d.shopKm * a.secPerKm));
    const toCustomer = Math.max(4, Math.round(d.km * a.secPerKm));
    const limit = Math.ceil(((toShop + toCustomer) * 1.5 + 12 + 4 * d.lines.length) * (has(p, 'navigator') ? 1.2 : 1));
    db.prepare("UPDATE courier_orders SET status = 'active', phase = 'shop', vehicle = ?, to_shop = ?, to_customer = ?, time_limit = ?, accepted_at = ? WHERE id = ?")
      .run(p.vehicle, toShop, toCustomer, limit, Date.now(), o.id);
    res.json(state(req.user.id));
  });

  const active = (userId, id) => {
    const o = getOrder(userId, id);
    return o && o.status === 'active' ? o : null;
  };

  // Do'konga yetib keldi: yo'l vaqtidan oldin bo'lishi mumkin emas
  app.post('/api/courier/orders/:id/arrive', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'shop') return fail(res, 400, 'Buyurtma do\'konga yo\'lda emas');
    if (Date.now() < o.accepted_at + o.to_shop * 1000 * 0.85) return fail(res, 400, 'Hali yetib kelmadingiz');
    db.prepare("UPDATE courier_orders SET phase = 'pick', arrived_at = ? WHERE id = ?").run(Date.now(), o.id);
    res.json(state(req.user.id));
  });

  // Do'konda mahsulotlar terildi: savat buyurtma ro'yxati bilan aynan bir xil bo'lishi kerak
  app.post('/api/courier/orders/:id/pickup', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'pick') return fail(res, 400, 'Siz do\'konda emassiz');
    const d = JSON.parse(o.data);
    const picked = Array.isArray(req.body?.picked) ? req.body.picked : [];
    const want = new Map(d.lines.map((l) => [l.food, l.qty]));
    const got = new Map();
    for (const x of picked) if (Number.isInteger(x?.food) && Number.isInteger(x?.qty)) got.set(x.food, (got.get(x.food) || 0) + x.qty);
    const same = want.size === got.size && [...want].every(([f, q]) => got.get(f) === q);
    if (!same) return fail(res, 400, "Savatdagi mahsulotlar buyurtmaga mos emas");
    const mistakes = Math.max(0, Math.min(20, Number(req.body?.mistakes) || 0));
    db.prepare("UPDATE courier_orders SET phase = 'deliver', picked_at = ?, mistakes = ? WHERE id = ?").run(Date.now(), mistakes, o.id);
    res.json(state(req.user.id));
  });

  // Mijozga yetkazildi: yulduz, haq, choychaqa va XP shu yerda hisoblanadi
  app.post('/api/courier/orders/:id/deliver', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o || o.phase !== 'deliver') return fail(res, 400, 'Buyurtma mijozga yo\'lda emas');
    const now = Date.now();
    if (now < o.picked_at + o.to_customer * 1000 * 0.85) return fail(res, 400, 'Hali yetib kelmadingiz');
    const ratio = (now - o.accepted_at) / 1000 / o.time_limit;
    let stars = ratio <= 0.8 ? 5 : ratio <= 1 ? 4 : ratio <= 1.25 ? 3 : ratio <= 1.6 ? 2 : 1;
    if (o.mistakes >= 3) stars -= 1;
    stars = Math.max(1, stars);
    const base = o.reward * payMult(p) * (ratio > 1 ? 0.75 : 1);
    const tip = base * (stars === 5 ? 0.15 : stars === 4 ? 0.07 : 0) * (has(p, 'polite') ? 2 : 1);
    const paid = Math.round(base + tip);
    const before = p.level;
    const gained = gainXp(req.user.id, o.xp * (0.5 + stars / 10));
    addCoins(req.user.id, paid);
    db.prepare("UPDATE courier_orders SET status = 'done', phase = NULL, done_at = ?, stars = ?, paid = ?, gained_xp = ? WHERE id = ?").run(now, stars, paid, gained, o.id);
    db.prepare("UPDATE courier_profile SET orders_done = orders_done + 1, stars_sum = stars_sum + ?, earned = earned + ?, location = 'house' WHERE user_id = ?").run(stars, paid, req.user.id);
    const after = levelOf(getProfile.get(req.user.id).xp);
    res.json({
      ...state(req.user.id),
      result: {
        stars, paid, tip: Math.round(tip), xp: gained, late: ratio > 1,
        levelUp: after > before ? { level: after, rank: rankOf(after).level > before ? rankOf(after) : null,
          vehicles: VEHICLES.filter((v) => v.level > before && v.level <= after).map((v) => v.name),
          skills: SKILLS.filter((s) => s.level > before && s.level <= after).map((s) => s.name) } : null,
      },
    });
  });

  app.post('/api/courier/orders/:id/cancel', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    const o = active(req.user.id, req.params.id);
    if (!o) return fail(res, 404, 'Buyurtma topilmadi');
    db.prepare("UPDATE courier_orders SET status = 'cancelled', phase = NULL WHERE id = ?").run(o.id);
    res.json(state(req.user.id));
  });

  // Dispetcher: taklifni boshqa kuryerga berish, u yetkazgach ulush olinadi
  app.post('/api/courier/orders/:id/dispatch', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    if (!has(p, 'dispatcher')) return fail(res, 400, '"Dispetcher" skilli kerak');
    const o = getOrder(req.user.id, req.params.id);
    if (!o || o.status !== 'offer') return fail(res, 404, 'Buyurtma topilmadi');
    const busy = db.prepare("SELECT COUNT(*) AS n FROM courier_orders WHERE user_id = ? AND status = 'dispatched'").get(req.user.id).n;
    if (busy >= dispatchSlots(p)) return fail(res, 400, "Hamma kuryerlar band");
    const d = JSON.parse(o.data);
    const doneAt = Date.now() + Math.round(((d.shopKm + d.km) * 5 + 20) * 1000);
    const share = Math.round(o.reward * payMult(p) * commission(p));
    db.prepare("UPDATE courier_orders SET status = 'dispatched', npc = ?, done_at = ?, paid = ?, accepted_at = ? WHERE id = ?")
      .run(pick(NPCS), doneAt, share, Date.now(), o.id);
    res.json(state(req.user.id));
  });

  // Dispetcher daromadi: yetkazilgan buyurtmalar ulushi + soatlik maosh
  app.post('/api/courier/dispatch/claim', requireAuth, (req, res) => {
    const p = need(req, res); if (!p) return;
    if (!has(p, 'dispatcher')) return fail(res, 400, '"Dispetcher" skilli kerak');
    const now = Date.now();
    const ready = db.prepare("SELECT id, paid FROM courier_orders WHERE user_id = ? AND status = 'dispatched' AND done_at <= ?").all(req.user.id, now);
    const salary = passive(p);
    const total = ready.reduce((n, r) => n + r.paid, 0) + salary;
    if (!total) return fail(res, 400, "Hozircha yig'adigan daromad yo'q");
    db.exec('BEGIN');
    try {
      for (const r of ready) db.prepare("UPDATE courier_orders SET status = 'paid' WHERE id = ?").run(r.id);
      addCoins(req.user.id, total);
      if (salary) db.prepare('UPDATE courier_profile SET passive_at = ? WHERE user_id = ?').run(now, req.user.id);
      db.prepare('UPDATE courier_profile SET earned = earned + ? WHERE user_id = ?').run(total, req.user.id);
      gainXp(req.user.id, ready.length);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(err);
      return fail(res, 500, 'Server xatosi');
    }
    res.json({ ...state(req.user.id), claimed: total });
  });
}
