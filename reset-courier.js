// Kuryer progressini qaytadan boshlash: XP 0 (1-daraja, piyoda) yoki --level bilan berilgan daraja, skillar, transportlar va buyurtmalar o'chadi.
// Tangalar (balans) o'zgarmaydi. Ishlatish (server papkasida):
//   node reset-courier.js            — hamma foydalanuvchilar
//   node reset-courier.js murod      — faqat bitta foydalanuvchi
//   node reset-courier.js --level=6  — nol emas, kerakli darajadan boshlash (murod --level=6 ham bo'ladi)
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('auth.db');
const args = process.argv.slice(2);
const level = Number(args.find((a) => a.startsWith('--level='))?.slice(8)) || 1;
const xp = 50 * (level - 1) * level; // server/courier.js dagi xpFor bilan bir xil
const name = args.find((a) => !a.startsWith('--'));
const users = name
  ? db.prepare('SELECT id, username FROM users WHERE username = ?').all(name)
  : db.prepare('SELECT u.id, u.username FROM users u JOIN courier_profile c ON c.user_id = u.id').all();
if (!users.length) {
  console.log(name ? `"${name}" topilmadi` : "Kuryer profili bor foydalanuvchi yo'q");
  process.exit(0);
}
for (const u of users) {
  db.prepare(`UPDATE courier_profile SET xp = ?, vehicle = 'foot', vehicles = '["foot"]', skills = '[]', on_shift = 0,
    orders_done = 0, stars_sum = 0, earned = 0, passive_at = NULL WHERE user_id = ?`).run(xp, u.id);
  try { db.prepare("UPDATE courier_profile SET location = 'depot' WHERE user_id = ?").run(u.id); } catch {}
  db.prepare('DELETE FROM courier_orders WHERE user_id = ?').run(u.id);
  console.log(`${u.username}: kuryer darajasi ${level} (${xp} XP)`);
}
