// One-time move of an older SQLite database (sba.db) and its uploaded photos into MySQL.
//   npm install --no-save better-sqlite3
//   node scripts/sqlite-to-mysql.js /path/to/sba.db [/path/to/uploads] [--force]
// Needs the same MYSQL_* settings as the server. The MySQL database should be empty (use --force to replace what is in it).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { db, initDb, pool, addMedia } from '../db.js';

const args = process.argv.slice(2);
const [src, uploadsArg] = args.filter((a) => !a.startsWith('--'));
const force = args.includes('--force');
if (!src || !fs.existsSync(src)) { console.log('Usage: node scripts/sqlite-to-mysql.js <path-to-sba.db> [<uploads-folder>] [--force]'); process.exit(1); }
let Sqlite;
try { Sqlite = (await import('better-sqlite3')).default; } catch { console.error('Install the reader once:  npm install --no-save better-sqlite3'); process.exit(1); }

await initDb();
if ((await db.prepare('SELECT COUNT(*) n FROM users').get()).n > 0 && !force) { console.error('The MySQL database already has users. Use an empty database, or add --force to replace its data.'); process.exit(1); }
const lite = new Sqlite(src, { readonly: true });
const has = (t) => !!lite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// photos: /uploads/<file> on disk -> /media/<id> in MySQL
const dirs = [uploadsArg, path.join(path.dirname(src), '..', 'uploads'), path.join(path.dirname(src), 'uploads'), path.join(path.dirname(src), '..', '..', 'uploads')].filter(Boolean);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const seen = new Map(); let photos = 0, missing = 0;
async function moveUrl(u) {
  const m = /^\/uploads\/([\w.-]+)$/.exec(u || '');
  if (!m) return u;
  if (seen.has(u)) return seen.get(u);
  const file = dirs.map((d) => path.join(d, m[1])).find((f) => fs.existsSync(f));
  const mime = MIME[path.extname(m[1]).toLowerCase()];
  if (!file || !mime) { missing++; return u; }
  const nu = await addMedia(mime, fs.readFileSync(file)); seen.set(u, nu); photos++; return nu;
}

const counts = {};
async function copy(table, { from = table, fix } = {}) {
  if (!has(from)) return;
  const liteCols = lite.prepare(`PRAGMA table_info(${from})`).all().map((c) => c.name);
  const myCols = (await db.prepare(`SHOW COLUMNS FROM ${table}`).all()).map((c) => c.Field);
  const use = myCols.filter((c) => liteCols.includes(c));
  await db.exec(`DELETE FROM ${table}`);
  let rows = lite.prepare(`SELECT * FROM ${from}`).all();
  if (fix) rows = await Promise.all(rows.map(fix));
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.prepare(`INSERT INTO ${table} (${use.map((c) => '`' + c + '`').join(',')}) VALUES ?`).all(chunk.map((r) => use.map((c) => r[c] ?? null)));
  }
  counts[table] = rows.length;
}
const fixImages = async (r) => {
  if (r.image) r.image = await moveUrl(r.image);
  if (r.images) { try { r.images = JSON.stringify(await Promise.all(JSON.parse(r.images).map(moveUrl))); } catch { /* leave as is */ } }
  return r;
};

await copy('users', { fix: (r) => ({ ...r, role: r.role === 'admin' ? 'admin' : 'user', name: r.name ?? '', phone: r.phone ?? '', status: r.status || 'active' }) });
await copy('shops'); await copy('categories'); await copy('cities');
if (has('listings')) await copy('listings', { fix: fixImages });
else if (has('products') || has('products_old')) {                       // the very first version stored ads in "products"
  const old = has('products') ? 'products' : 'products_old';
  const shopUser = new Map(lite.prepare('SELECT id, user_id FROM shops').all().map((s) => [s.id, s.user_id]));
  await db.exec('DELETE FROM listings');
  for (const p of lite.prepare(`SELECT * FROM ${old}`).all()) {
    const img = await moveUrl(p.image);
    await db.prepare('INSERT INTO listings (id,user_id,shop_id,title,description,price,category,city,image,images,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(p.id, shopUser.get(p.shop_id) ?? null, p.shop_id, p.title, p.description || '', p.price, p.category || 'Others', p.city, img || '', JSON.stringify(img ? [img] : []), p.created_at);
  }
  counts.listings = (await db.prepare('SELECT COUNT(*) n FROM listings').get()).n;
}
await copy('payments'); await copy('ads', { fix: fixImages }); await copy('calls'); await copy('pages'); await copy('messages'); await copy('reports');
if (has('settings')) {                                                  // saved admin settings (API keys stay readable only if JWT_SECRET is unchanged)
  let n = 0;
  for (const s of lite.prepare('SELECT * FROM settings').all()) {
    const k = s.key ?? s.skey, v = s.value ?? s.svalue;
    if (['db_created_at', 'boots', 'last_boot_at'].includes(k)) continue;
    await db.prepare('INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)').run(k, v); n++;
  }
  counts.settings = n;
}
console.log('Moved:', counts, `\nPhotos moved into MySQL: ${photos}${missing ? `  (${missing} photo files were not found; check the uploads folder path)` : ''}`);
await pool.end();
