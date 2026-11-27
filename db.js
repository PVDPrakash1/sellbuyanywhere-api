// MySQL data layer. All live data (including photos) is stored in MySQL, so publishing new code can never wipe it.
// Connection: MYSQL_URL=mysql://user:pass@host:3306/dbname   or   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE   (MYSQL_SSL=true for hosted databases that need TLS)
import mysql from 'mysql2/promise';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT_SECRET } from './config.js';
import { DEFAULT_PAGES } from './pages-default.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = __dirname;
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');   // only used to serve photos uploaded before the MySQL version
function pickBackupDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  for (const base of [path.resolve(__dirname, '..'), os.homedir()]) {
    try { const d = path.join(base, 'sba-backups'); fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* next */ }
  }
  return path.join(__dirname, 'backups');
}
export const BACKUP_DIR = pickBackupDir();

function poolConfig() {
  let c = { host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE };
  const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (url) { const u = new URL(url); c = { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) }; }
  return { ...c, charset: 'utf8mb4', timezone: 'Z', dateStrings: true, waitForConnections: true, connectionLimit: 10, connectTimeout: 15000,
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined };
}
export const pool = mysql.createPool(poolConfig());
pool.pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));       // every time is stored and compared in UTC

// Small helper API: db.prepare(sql).get / all / run  (always async), db.transaction(async (tx) => ...)
const api = (conn) => ({
  prepare: (sql) => ({
    get: async (...p) => (await conn.query(sql, p))[0][0],
    all: async (...p) => (await conn.query(sql, p))[0],
    run: async (...p) => { const r = (await conn.query(sql, p))[0]; return { lastInsertRowid: r.insertId, changes: r.affectedRows }; },
  }),
  exec: async (sql) => (await conn.query(sql))[0],
});
export const db = {
  ...api(pool),
  transaction: async (fn) => {
    const c = await pool.getConnection();
    try { await c.beginTransaction(); const r = await fn(api(c)); await c.commit(); return r; }
    catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  },
};

// ---- Photos live in MySQL too ----
export async function addMedia(mime, buffer) {
  const [r] = await pool.execute('INSERT INTO media (mime, data) VALUES (?, ?)', [mime, buffer]);
  return `/media/${r.insertId}`;
}
export async function removeMedia(urls) {
  const ids = urls.map((u) => /^\/media\/(\d+)$/.exec(u)?.[1]).filter(Boolean).map(Number);
  if (ids.length) await pool.query('DELETE FROM media WHERE id IN (?)', [ids]);
}

const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'user',
    name VARCHAR(120) NOT NULL DEFAULT '', phone VARCHAR(30) NOT NULL DEFAULT '', status VARCHAR(20) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
  `CREATE TABLE IF NOT EXISTS shops (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, name VARCHAR(160) NOT NULL, city VARCHAR(80) NOT NULL, phone VARCHAR(30) NOT NULL,
    address VARCHAR(400) NOT NULL DEFAULT '', description VARCHAR(600) NOT NULL DEFAULT '', plan VARCHAR(20) NOT NULL DEFAULT 'basic', status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_shop_user (user_id), KEY idx_shop_city (city)) ${T}`,
  `CREATE TABLE IF NOT EXISTS categories (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, name_te VARCHAR(120) NOT NULL DEFAULT '', icon VARCHAR(20) NOT NULL DEFAULT '🎁',
    sort INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1) ${T}`,
  `CREATE TABLE IF NOT EXISTS cities (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, name_te VARCHAR(120) NOT NULL DEFAULT '', state VARCHAR(60) NOT NULL DEFAULT '',
    lat DOUBLE NULL, lng DOUBLE NULL, sort INT NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1) ${T}`,
  `CREATE TABLE IF NOT EXISTS listings (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NULL, shop_id INT NULL, title VARCHAR(160) NOT NULL, description TEXT NULL, price BIGINT NOT NULL DEFAULT 0,
    category VARCHAR(80) NOT NULL DEFAULT 'Others', city VARCHAR(80) NOT NULL, phone VARCHAR(30) NOT NULL DEFAULT '', image VARCHAR(255) NOT NULL DEFAULT '', images TEXT NULL,
    buy_url VARCHAR(600) NOT NULL DEFAULT '', featured_until DATETIME NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', views INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_l_city (city), KEY idx_l_shop (shop_id), KEY idx_l_user (user_id), KEY idx_l_status (status), KEY idx_l_feat (featured_until)) ${T}`,
  `CREATE TABLE IF NOT EXISTS payments (id INT AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(20) NOT NULL, order_id VARCHAR(100) NOT NULL UNIQUE, payment_id VARCHAR(100) NULL, user_id INT NULL,
    amount INT NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'created', meta TEXT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
  `CREATE TABLE IF NOT EXISTS ads (id INT AUTO_INCREMENT PRIMARY KEY, slot VARCHAR(40) NOT NULL, title VARCHAR(160) NOT NULL, image VARCHAR(255) NOT NULL DEFAULT '', link VARCHAR(600) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1) ${T}`,
  `CREATE TABLE IF NOT EXISTS calls (id INT AUTO_INCREMENT PRIMARY KEY, product_id INT NULL, shop_id INT NULL, phone VARCHAR(30) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'queued',
    call_sid VARCHAR(100) NULL, note VARCHAR(255) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, KEY idx_c_phone (phone), KEY idx_c_sid (call_sid)) ${T}`,
  `CREATE TABLE IF NOT EXISTS pages (slug VARCHAR(60) NOT NULL PRIMARY KEY, title VARCHAR(200) NOT NULL, title_te VARCHAR(200) NOT NULL DEFAULT '', body MEDIUMTEXT NOT NULL, body_te MEDIUMTEXT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
  `CREATE TABLE IF NOT EXISTS messages (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL, phone VARCHAR(30) NOT NULL DEFAULT '', subject VARCHAR(200) NOT NULL DEFAULT '',
    message TEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'new', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
  `CREATE TABLE IF NOT EXISTS reports (id INT AUTO_INCREMENT PRIMARY KEY, listing_id INT NOT NULL, reason VARCHAR(600) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'open', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
  `CREATE TABLE IF NOT EXISTS settings (skey VARCHAR(100) NOT NULL PRIMARY KEY, svalue TEXT NULL) ${T}`,
  `CREATE TABLE IF NOT EXISTS media (id INT AUTO_INCREMENT PRIMARY KEY, mime VARCHAR(60) NOT NULL, data MEDIUMBLOB NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ${T}`,
];

const CATS = [['Electronics', 'ఎలక్ట్రానిక్స్', '📱'], ['Vehicles', 'వాహనాలు', '🚗'], ['Furniture', 'ఫర్నిచర్', '🛋️'], ['Fashion', 'ఫ్యాషన్', '👗'],
  ['Jobs', 'ఉద్యోగాలు', '💼'], ['Real Estate', 'ఇళ్లు & స్థలాలు', '🏠'], ['Services', 'సేవలు', '🔧'], ['Books', 'పుస్తకాలు', '📚'],
  ['Sports', 'క్రీడలు', '⚽'], ['Others', 'ఇతరాలు', '🎁']];
const CITIES = [['Hyderabad', 'హైదరాబాద్', 'Telangana', 17.385, 78.4867], ['Vijayawada', 'విజయవాడ', 'Andhra Pradesh', 16.5062, 80.648], ['Visakhapatnam', 'విశాఖపట్నం', 'Andhra Pradesh', 17.6868, 83.2185],
  ['Warangal', 'వరంగల్', 'Telangana', 17.9689, 79.5941], ['Guntur', 'గుంటూరు', 'Andhra Pradesh', 16.3067, 80.4365], ['Tirupati', 'తిరుపతి', 'Andhra Pradesh', 13.6288, 79.4192],
  ['Nellore', 'నెల్లూరు', 'Andhra Pradesh', 14.4426, 79.9865], ['Karimnagar', 'కరీంనగర్', 'Telangana', 18.4392, 79.1288], ['Kakinada', 'కాకినాడ', 'Andhra Pradesh', 16.9891, 82.2475],
  ['Rajahmundry', 'రాజమండ్రి', 'Andhra Pradesh', 17.0005, 81.804], ['Kurnool', 'కర్నూలు', 'Andhra Pradesh', 15.8281, 78.0373], ['Bengaluru', 'బెంగళూరు', 'Karnataka', 12.9716, 77.5946],
  ['Chennai', 'చెన్నై', 'Tamil Nadu', 13.0827, 80.2707], ['Mumbai', 'ముంబై', 'Maharashtra', 19.076, 72.8777], ['Delhi', 'ఢిల్లీ', 'Delhi', 28.6139, 77.209],
  ['Pune', 'పుణె', 'Maharashtra', 18.5204, 73.8567], ['Kolkata', 'కోల్‌కతా', 'West Bengal', 22.5726, 88.3639]];

// ---- Settings: cached in memory (so getSetting stays synchronous); secrets are encrypted in the database ----
export const DEFAULTS = {
  site_name: 'SellBuyAnywhere', support_email: 'support@sellbuyanywhere.com', support_phone: '', address: '',
  promo_active: 'yes', promo_shop_price: '1', promo_title: 'Launch offer',
  premium_price: '50', premium_days: '7', plan_basic_price: '100', plan_ai_price: '299', plan_store_price: '599', max_ads_per_day: '10',
  ai_provider: 'llama',
  llama_api_url: 'https://api.llama.com/compat/v1', llama_api_key: '', llama_model: 'Llama-4-Maverick-17B-128E-Instruct-FP8', llama_vision_model: '',
  gemini_api_key: '', gemini_model: 'gemini-3.5-flash',
  anthropic_api_key: '', anthropic_model: 'claude-haiku-5-5',
  razorpay_key_id: '', razorpay_key_secret: '',
  exotel_sid: '', exotel_api_key: '', exotel_api_token: '', exotel_subdomain: 'api.exotel.com', exotel_caller_id: '', exotel_flow_id: '', exotel_flow_url: '',
  google_cloud_key: '', tts_voice: 'te-IN-Standard-A', calls_per_day_max: '200', call_time_limit: '180',
};
export const SECRET_KEYS = new Set(['llama_api_key', 'gemini_api_key', 'anthropic_api_key', 'razorpay_key_secret', 'exotel_api_key', 'exotel_api_token', 'google_cloud_key']);
const KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const enc = (t) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv); const d = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return 'enc:' + [iv, c.getAuthTag(), d].map((b) => b.toString('base64')).join(':'); };
const dec = (v) => { try { const [iv, tag, d] = v.slice(4).split(':').map((x) => Buffer.from(x, 'base64'));
  const c = crypto.createDecipheriv('aes-256-gcm', KEY, iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); } catch { return ''; } };
const cache = new Map();
export async function loadSettings() { cache.clear(); for (const r of await db.prepare('SELECT skey, svalue FROM settings').all()) cache.set(r.skey, r.svalue ?? ''); }
export function getSetting(k) {
  const v = cache.get(k);
  if (v !== undefined && v !== '') return SECRET_KEYS.has(k) ? dec(v) : v;
  return process.env[k.toUpperCase()] ?? DEFAULTS[k] ?? '';
}
export async function setSetting(k, v) {
  const stored = v === '' ? '' : SECRET_KEYS.has(k) ? enc(String(v)) : String(v);
  await db.prepare('INSERT INTO settings (skey, svalue) VALUES (?, ?) ON DUPLICATE KEY UPDATE svalue = VALUES(svalue)').run(k, stored);
  cache.set(k, stored);
}
export const wsKey = () => crypto.createHmac('sha256', JWT_SECRET).update('voicebot-ws').digest('hex').slice(0, 24);

export async function resolvePage(slug, lang = 'en') {
  const p = await db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug);
  if (!p) return null;
  const vars = { site: getSetting('site_name'), email: getSetting('support_email'), phone: getSetting('support_phone') ? 'Phone: ' + getSetting('support_phone') : '',
    address: getSetting('address'), premium_price: getSetting('premium_price'), premium_days: getSetting('premium_days') };
  const fill = (s) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  const te = lang === 'te';
  return { slug, title: fill((te && p.title_te) || p.title), body: fill((te && p.body_te) || p.body), translated: te && !!p.body_te };
}

// ---- Start-up: connect, create tables, insert defaults once, load settings ----
export async function initDb() {
  try { await pool.query('SELECT 1'); }
  catch (e) { throw new Error(`Cannot connect to MySQL (${e.code || e.message}). Set MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD and MYSQL_DATABASE (or MYSQL_URL) in the environment settings.`); }
  for (const sql of SCHEMA) await db.exec(sql);
  for (const [i, [n, te, ic]] of CATS.entries()) await db.prepare('INSERT IGNORE INTO categories (name,name_te,icon,sort) VALUES (?,?,?,?)').run(n, te, ic, i);
  for (const [i, [n, te, st, la, lo]] of CITIES.entries()) {
    await db.prepare('INSERT IGNORE INTO cities (name,name_te,state,lat,lng,sort) VALUES (?,?,?,?,?,?)').run(n, te, st, la, lo, i);
    await db.prepare('UPDATE cities SET lat=?, lng=? WHERE name=? AND lat IS NULL').run(la, lo, n);
  }
  for (const [slug, p] of Object.entries(DEFAULT_PAGES)) await db.prepare('INSERT IGNORE INTO pages (slug,title,title_te,body) VALUES (?,?,?,?)').run(slug, p.title, p.title_te, p.body);
  await loadSettings();
  if (!(await db.prepare("SELECT 1 x FROM settings WHERE skey='db_created_at'").get())) await setSetting('db_created_at', new Date().toISOString());
  await setSetting('boots', String((Number(getSetting('boots')) || 0) + 1));
  await setSetting('last_boot_at', new Date().toISOString());
}
