// Sinash uchun: Sardorning energiyasi va kasalligini qaytadan boshlash (o'lgan bo'lsa tiriltiradi).
// O'yinga qayta kirish (respawn) tartibi hali yo'q — keyin qo'shiladi. Ishlatish (server papkasida):
//   node reset-vitals.js                — hamma foydalanuvchilar: energiya 100%, sog'
//   node reset-vitals.js murod          — faqat bitta foydalanuvchi
//   node reset-vitals.js murod --energy=21 --stage=2  — kerakli holatdan boshlash
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('auth.db');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.slice(k.length + 3)) : d;
};
const energy = Math.min(100, Math.max(0, opt('energy', 100)));
const stage = Math.min(3, Math.max(0, opt('stage', 0)));
const name = args.find((a) => !a.startsWith('--'));
const users = name
  ? db.prepare('SELECT id, username FROM users WHERE username = ?').all(name)
  : db.prepare('SELECT u.id, u.username FROM users u JOIN user_vitals v ON v.user_id = u.id').all();
if (!users.length) {
  console.log(name ? `"${name}" topilmadi` : "Energiya ma'lumoti bor foydalanuvchi yo'q");
  process.exit(0);
}
for (const u of users) {
  db.prepare(`
    INSERT INTO user_vitals (user_id, energy, stage, clock_ms, dead, died_at, last_seen) VALUES (?, ?, ?, 0, 0, NULL, NULL)
    ON CONFLICT(user_id) DO UPDATE SET energy = excluded.energy, stage = excluded.stage, clock_ms = 0, dead = 0, died_at = NULL, last_seen = NULL
  `).run(u.id, energy, stage);
  console.log(`${u.username}: energiya ${energy}%, kasallik ${stage}-bosqich, tirik`);
}
