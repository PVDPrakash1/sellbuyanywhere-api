// Backups of the database and uploaded photos: automatic copies on the server, plus download/restore for the admin.
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { db, DATA_DIR, BACKUP_DIR, UPLOADS_DIR } from './db.js';

const esc = (p) => p.replace(/'/g, "''");
const TABLES = ['users', 'shops', 'categories', 'cities', 'listings', 'payments', 'ads', 'calls', 'pages', 'messages', 'reports'];   // settings (API keys) are never overwritten by a restore
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

export function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^sba-.*\.db$/.test(f)).map((f) => { const s = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size: s.size, at: s.mtime.toISOString() }; })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return []; }
}
export function backupNow(tag = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `sba-${stamp()}-${tag}.db`;
  db.exec(`VACUUM INTO '${esc(path.join(BACKUP_DIR, name))}'`);
  for (const old of listBackups().slice(20)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));      // keep the newest 20
  return name;
}
export function startBackups() {
  const last = listBackups()[0];
  if (!last || Date.now() - Date.parse(last.at) > 6 * 3600 * 1000) { try { backupNow('auto'); } catch (e) { console.error('Backup failed:', e.message); } }
  setInterval(() => { try { backupNow('auto'); } catch (e) { console.error('Backup failed:', e.message); } }, 6 * 3600 * 1000).unref();
}

// One file with the database and all photos
export function zipBackup() {
  const tmp = path.join(DATA_DIR, `export-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${esc(tmp)}'`);
  try {
    const zip = new AdmZip();
    zip.addFile('sba.db', fs.readFileSync(tmp));
    if (fs.existsSync(UPLOADS_DIR)) zip.addLocalFolder(UPLOADS_DIR, 'uploads');
    return zip.toBuffer();
  } finally { fs.unlinkSync(tmp); }
}

// Restore from a backup .zip (database + photos) or a bare .db. The signed-in admin keeps access.
export function restoreFrom(buf, admin) {
  let dbBuf = null, photos = [];
  if (buf.subarray(0, 2).toString() === 'PK') {
    const zip = new AdmZip(buf);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      if (e.entryName === 'sba.db') dbBuf = e.getData();
      else if (e.entryName.startsWith('uploads/') && /^[\w.-]+$/.test(path.basename(e.entryName))) photos.push(e);
    }
  } else if (buf.subarray(0, 15).toString() === 'SQLite format 3') dbBuf = buf;
  if (!dbBuf || dbBuf.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('That file is not a backup from this site (.zip or .db).');

  const safety = backupNow('before-restore');
  const tmp = path.join(DATA_DIR, `restore-${Date.now()}.db`);
  fs.writeFileSync(tmp, dbBuf);
  const counts = {};
  try {
    db.exec(`ATTACH DATABASE '${esc(tmp)}' AS bk`);
    const cols = (schema, t) => db.prepare(`PRAGMA ${schema}.table_info(${t})`).all().map((c) => c.name);
    if (!cols('bk', 'users').length || !cols('bk', 'listings').length) throw new Error('This backup is from an older version of the site and cannot be restored here.');
    db.transaction(() => {
      for (const t of TABLES) {
        const b = cols('bk', t);
        if (!b.length) continue;
        const common = cols('main', t).filter((c) => b.includes(c)).join(',');
        db.exec(`DELETE FROM main.${t}`);
        db.exec(`INSERT INTO main.${t} (${common}) SELECT ${common} FROM bk.${t}`);
        counts[t] = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
      }
      // keep the current admin able to sign in
      const has = db.prepare('SELECT id FROM users WHERE email=?').get(admin.email);
      if (has) db.prepare("UPDATE users SET role='admin', status='active', password_hash=? WHERE id=?").run(admin.password_hash, has.id);
      else db.prepare("INSERT INTO users (email,password_hash,role,name) VALUES (?,?,'admin',?)").run(admin.email, admin.password_hash, admin.name || 'Admin');
    })();
  } finally { try { db.exec('DETACH DATABASE bk'); } catch { /* not attached */ } fs.unlinkSync(tmp); }
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  for (const e of photos) fs.writeFileSync(path.join(UPLOADS_DIR, path.basename(e.entryName)), e.getData());
  return { counts, photos: photos.length, safetyBackup: safety };
}
