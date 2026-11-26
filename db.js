import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JWT_SECRET } from './config.js';
import { DEFAULT_PAGES } from './pages-default.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');           // set DATA_DIR to a persistent disk in production
export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, 'sba.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user', name TEXT DEFAULT '', phone TEXT DEFAULT '', status TEXT DEFAULT 'active', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS shops (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, city TEXT NOT NULL,
  phone TEXT NOT NULL, address TEXT DEFAULT '', description TEXT DEFAULT '', plan TEXT DEFAULT 'basic', status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, name_te TEXT DEFAULT '', icon TEXT DEFAULT '🎁', sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS cities (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, name_te TEXT DEFAULT '', state TEXT DEFAULT '', sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY, user_id INTEGER, shop_id INTEGER, title TEXT NOT NULL, description TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0, category TEXT DEFAULT 'Others', city TEXT NOT NULL, phone TEXT DEFAULT '', image TEXT DEFAULT '', images TEXT DEFAULT '[]',
  featured_until TEXT, status TEXT DEFAULT 'active', views INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_listings_city ON listings(city);
CREATE INDEX IF NOT EXISTS idx_listings_shop ON listings(shop_id);
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, order_id TEXT UNIQUE NOT NULL, payment_id TEXT, user_id INTEGER,
  amount INTEGER DEFAULT 0, status TEXT DEFAULT 'created', meta TEXT DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ads (id INTEGER PRIMARY KEY, slot TEXT NOT NULL, title TEXT NOT NULL, image TEXT DEFAULT '', link TEXT NOT NULL, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY, product_id INTEGER, shop_id INTEGER, phone TEXT NOT NULL, status TEXT DEFAULT 'queued',
  call_sid TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, title TEXT, title_te TEXT DEFAULT '', body TEXT, body_te TEXT DEFAULT '', updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT DEFAULT '', subject TEXT DEFAULT '', message TEXT, status TEXT DEFAULT 'new', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, listing_id INTEGER, reason TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// ---- Migration from the first version (products table) ----
function addCol(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCol('users', 'role', "TEXT DEFAULT 'user'"); addCol('users', 'name', "TEXT DEFAULT ''");
addCol('users', 'phone', "TEXT DEFAULT ''"); addCol('users', 'status', "TEXT DEFAULT 'active'");
addCol('listings', 'images', "TEXT DEFAULT '[]'"); addCol('cities', 'lat', 'REAL'); addCol('cities', 'lng', 'REAL');
addCol('shops', 'description', "TEXT DEFAULT ''"); addCol('shops', 'status', "TEXT DEFAULT 'active'");
if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'").get() && !db.prepare('SELECT 1 FROM listings LIMIT 1').get()) {
  db.exec(`INSERT INTO listings (id,user_id,shop_id,title,description,price,category,city,phone,image,created_at)
    SELECT p.id, s.user_id, p.shop_id, p.title, p.description, p.price, p.category, p.city, s.phone, p.image, p.created_at
    FROM products p JOIN shops s ON s.id = p.shop_id`);
  db.exec('ALTER TABLE products RENAME TO products_old');
}
db.exec("UPDATE users SET role='user' WHERE role IS NULL OR role='owner'");

// ---- Default categories, cities and pages (inserted once; admin edits are kept) ----
const CATS = [['Electronics', 'ఎలక్ట్రానిక్స్', '📱'], ['Vehicles', 'వాహనాలు', '🚗'], ['Furniture', 'ఫర్నిచర్', '🛋️'], ['Fashion', 'ఫ్యాషన్', '👗'],
  ['Jobs', 'ఉద్యోగాలు', '💼'], ['Real Estate', 'ఇళ్లు & స్థలాలు', '🏠'], ['Services', 'సేవలు', '🔧'], ['Books', 'పుస్తకాలు', '📚'],
  ['Sports', 'క్రీడలు', '⚽'], ['Others', 'ఇతరాలు', '🎁']];
CATS.forEach(([n, te, ic], i) => db.prepare('INSERT OR IGNORE INTO categories (name,name_te,icon,sort) VALUES (?,?,?,?)').run(n, te, ic, i));
const CITIES = [['Hyderabad', 'హైదరాబాద్', 'Telangana'], ['Vijayawada', 'విజయవాడ', 'Andhra Pradesh'], ['Visakhapatnam', 'విశాఖపట్నం', 'Andhra Pradesh'],
  ['Warangal', 'వరంగల్', 'Telangana'], ['Guntur', 'గుంటూరు', 'Andhra Pradesh'], ['Tirupati', 'తిరుపతి', 'Andhra Pradesh'], ['Nellore', 'నెల్లూరు', 'Andhra Pradesh'],
  ['Karimnagar', 'కరీంనగర్', 'Telangana'], ['Kakinada', 'కాకినాడ', 'Andhra Pradesh'], ['Rajahmundry', 'రాజమండ్రి', 'Andhra Pradesh'], ['Kurnool', 'కర్నూలు', 'Andhra Pradesh'],
  ['Bengaluru', 'బెంగళూరు', 'Karnataka'], ['Chennai', 'చెన్నై', 'Tamil Nadu'], ['Mumbai', 'ముంబై', 'Maharashtra'], ['Delhi', 'ఢిల్లీ', 'Delhi'],
  ['Pune', 'పుణె', 'Maharashtra'], ['Kolkata', 'కోల్‌కతా', 'West Bengal']];
CITIES.forEach(([n, te, st], i) => db.prepare('INSERT OR IGNORE INTO cities (name,name_te,state,sort) VALUES (?,?,?,?)').run(n, te, st, i));
const COORDS = { Hyderabad: [17.385, 78.4867], Vijayawada: [16.5062, 80.648], Visakhapatnam: [17.6868, 83.2185], Warangal: [17.9689, 79.5941], Guntur: [16.3067, 80.4365],
  Tirupati: [13.6288, 79.4192], Nellore: [14.4426, 79.9865], Karimnagar: [18.4392, 79.1288], Kakinada: [16.9891, 82.2475], Rajahmundry: [17.0005, 81.804], Kurnool: [15.8281, 78.0373],
  Bengaluru: [12.9716, 77.5946], Chennai: [13.0827, 80.2707], Mumbai: [19.076, 72.8777], Delhi: [28.6139, 77.209], Pune: [18.5204, 73.8567], Kolkata: [22.5726, 88.3639] };
for (const [n, [la, lo]] of Object.entries(COORDS)) db.prepare('UPDATE cities SET lat=?, lng=? WHERE name=? AND lat IS NULL').run(la, lo, n);
for (const [slug, p] of Object.entries(DEFAULT_PAGES))
  db.prepare('INSERT OR IGNORE INTO pages (slug,title,title_te,body) VALUES (?,?,?,?)').run(slug, p.title, p.title_te, p.body);

// ---- Settings (secrets are encrypted in the database; environment variables are the fallback) ----
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
export function getSetting(k) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  if (r && r.value !== '') return SECRET_KEYS.has(k) ? dec(r.value) : r.value;
  return process.env[k.toUpperCase()] ?? DEFAULTS[k] ?? '';
}
export function setSetting(k, v) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(k, v === '' ? '' : SECRET_KEYS.has(k) ? enc(String(v)) : String(v));
}
export const wsKey = () => crypto.createHmac('sha256', JWT_SECRET).update('voicebot-ws').digest('hex').slice(0, 24);

export function resolvePage(slug, lang = 'en') {
  const p = db.prepare('SELECT * FROM pages WHERE slug = ?').get(slug);
  if (!p) return null;
  const vars = { site: getSetting('site_name'), email: getSetting('support_email'), phone: getSetting('support_phone') ? 'Phone: ' + getSetting('support_phone') : '',
    address: getSetting('address'), premium_price: getSetting('premium_price'), premium_days: getSetting('premium_days') };
  const fill = (s) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  const te = lang === 'te';
  return { slug, title: fill((te && p.title_te) || p.title), body: fill((te && p.body_te) || p.body), translated: te && !!p.body_te };
}
