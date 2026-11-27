// Backups of all site data (JSON) and photos. Data itself lives in MySQL; these are extra safety copies and a way to move data.
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { db, pool, BACKUP_DIR } from './db.js';

const TABLES = ['users', 'shops', 'categories', 'cities', 'listings', 'payments', 'ads', 'calls', 'pages', 'messages', 'reports'];   // settings (API keys) are never overwritten by a restore
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

async function dumpTables() {
  const tables = {};
  for (const t of TABLES) tables[t] = await db.prepare(`SELECT * FROM ${t}`).all();
  return { app: 'sellbuyanywhere', version: 3, createdAt: new Date().toISOString(), tables };
}
export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^sba-.*\.json\.gz$/.test(f)).map((f) => { const s = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: s.size, at: s.mtime.toISOString() }; })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}
export async function backupNow(tag = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `sba-${stamp()}-${tag}.json.gz`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), zlib.gzipSync(JSON.stringify(await dumpTables())));
  for (const old of listBackups().slice(20)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));      // keep the newest 20
  return name;
}
export function startBackups() {
  const run = () => backupNow('auto').catch((e) => console.error('Backup failed:', e.message));
  const last = listBackups()[0];
  if (!last || Date.now() - Date.parse(last.at) > 6 * 3600 * 1000) run();
  setInterval(run, 6 * 3600 * 1000).unref();
}

// One .zip: data.json + every photo (media/<id>.<mime>) so it can be moved to another database
export async function zipBackup() {
  const zip = new AdmZip();
  zip.addFile('data.json', Buffer.from(JSON.stringify(await dumpTables())));
  const media = await db.prepare('SELECT id, mime FROM media').all();
  zip.addFile('media.json', Buffer.from(JSON.stringify(media)));
  for (const m of media) { const r = await db.prepare('SELECT data FROM media WHERE id=?').get(m.id); if (r) zip.addFile(`media/${m.id}`, r.data); }
  return zip.toBuffer();
}

// Restore from the .zip (data + photos) or a bare .json / .json.gz (data only). The signed-in admin keeps access.
export async function restoreFrom(buf, admin) {
  let data = null, media = [], files = new Map();
  try {
    if (buf.subarray(0, 2).toString() === 'PK') {
      const zip = new AdmZip(buf);
      for (const e of zip.getEntries()) {
        if (e.entryName === 'data.json') data = JSON.parse(e.getData().toString('utf8'));
        else if (e.entryName === 'media.json') media = JSON.parse(e.getData().toString('utf8'));
        else if (/^media\/\d+$/.test(e.entryName)) files.set(Number(e.entryName.slice(6)), e.getData());
      }
    } else data = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  } catch { throw new Error('That file is not a backup from this site (.zip, .json or .json.gz).'); }
  if (!data?.tables?.users || !data?.tables?.listings) throw new Error('That file is not a backup from this site.');

  const safety = await backupNow('before-restore');
  const counts = {};
  await db.transaction(async (tx) => {
    for (const t of TABLES) {
      const rows = data.tables[t];
      if (!Array.isArray(rows)) continue;
      const cols = (await tx.prepare(`SHOW COLUMNS FROM ${t}`).all()).map((c) => c.Field);
      await tx.exec(`DELETE FROM ${t}`);
      const use = rows.length ? cols.filter((c) => c in rows[0]) : [];
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await tx.prepare(`INSERT INTO ${t} (${use.map((c) => '`' + c + '`').join(',')}) VALUES ?`).all(chunk.map((r) => use.map((c) => r[c])));
      }
      counts[t] = rows.length;
    }
    const has = await tx.prepare('SELECT id FROM users WHERE email=?').get(admin.email);
    if (has) await tx.prepare("UPDATE users SET role='admin', status='active', password_hash=? WHERE id=?").run(admin.password_hash, has.id);
    else await tx.prepare("INSERT INTO users (email,password_hash,role,name) VALUES (?,?,'admin',?)").run(admin.email, admin.password_hash, admin.name || 'Admin');
  });
  let photos = 0;
  for (const m of media) {
    const buf2 = files.get(m.id);
    if (!buf2) continue;
    await pool.execute('INSERT INTO media (id, mime, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mime=VALUES(mime), data=VALUES(data)', [m.id, m.mime, buf2]);
    photos++;
  }
  return { counts, photos, safetyBackup: safety };
}
