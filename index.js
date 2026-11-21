import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import Razorpay from 'razorpay';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SCHEMA } from './schema.js';
import { registerAdmin } from './admin.js';
import { registerCalls, attachVoiceSocket } from './calls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = env.PORT || 4000;
const JWT_SECRET = env.JWT_SECRET || 'dev-secret-change-me';

// ---------- Plans (prices in rupees; edit to match your pricing) ----------
const PLANS = {
  basic: { label: 'Basic shop', price: 100 },
  ai: { label: 'Shop + AI chat and recommendations', price: 299 },
  store: { label: 'Full e-commerce + AI', price: 599 },
};

// ---------- Database ----------
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'sba.db'));
db.pragma('journal_mode = WAL');
db.exec(SCHEMA);
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'owner'"); } catch { /* column already exists */ }
if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const h = bcrypt.hashSync(env.ADMIN_PASSWORD, 10);
  const e = env.ADMIN_EMAIL.toLowerCase();
  const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (ex) db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?").run(h, ex.id);
  else db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?,?, 'admin')").run(e, h);
}

// ---------- App setup ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: '*',
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

const limiter = (max) => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false });

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'uploads'),
    filename: (_req, file, cb) =>
      cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)),
});
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

const razorpay =
  env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET
    ? new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET })
    : null;

const mailer = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 587),
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

// ---------- Helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in to continue.' });
  }
}

async function askLlama(messages, model = env.LLAMA_MODEL) {
  if (!env.LLAMA_API_URL || !env.LLAMA_API_KEY) return null;
  const r = await fetch(`${env.LLAMA_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLAMA_API_KEY}` },
    body: JSON.stringify({ model, messages, temperature: 0.2 }),
  });
  if (!r.ok) throw new Error(`AI request failed (${r.status})`);
  const j = await r.json();
  const c = j.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
}

const aiCache = new Map(); // key -> { at, data }
async function aiSuggestions(q, city) {
  const key = `${q.toLowerCase()}|${city.toLowerCase()}`;
  const hit = aiCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.data;
  const text = await askLlama([
    {
      role: 'system',
      content:
        'You help shoppers in India find where products are sold. Reply with ONLY a JSON array of up to 6 objects: ' +
        '{"name": string, "area": string, "note": string}. name is a real, well-known shop or market type for the product ' +
        'in the given city, area is a neighbourhood, note is one short sentence. If unsure, return fewer items or []. Never invent phone numbers.',
    },
    { role: 'user', content: `Product: ${q}\nCity: ${city || 'India'}` },
  ]);
  if (text === null) return null;
  let data = [];
  try {
    const s = text.indexOf('['), e = text.lastIndexOf(']');
    data = JSON.parse(text.slice(s, e + 1)).slice(0, 6).map((x) => ({
      name: clean(x.name, 80), area: clean(x.area, 80), note: clean(x.note, 160),
    }));
  } catch { data = []; }
  aiCache.set(key, { at: Date.now(), data });
  return data;
}

const productSelect = `
  SELECT p.*, s.name AS shop_name, s.phone AS shop_phone, s.address AS shop_address, s.plan AS shop_plan
  FROM products p JOIN shops s ON s.id = p.shop_id`;

// ---------- Plans & shop signup (Razorpay) ----------
app.get('/api/plans', (_req, res) => res.json(PLANS));

app.post('/api/shops/order', limiter(30), wrap(async (req, res) => {
  const b = req.body;
  const plan = PLANS[b.plan];
  const email = clean(b.email, 120).toLowerCase();
  if (!plan) return res.status(400).json({ error: 'Choose a plan.' });
  if (!clean(b.shopName) || !/^\S+@\S+\.\S+$/.test(email) || clean(b.phone, 20).length < 8 || !clean(b.city))
    return res.status(400).json({ error: 'Fill in shop name, email, phone and city.' });
  if (!razorpay) return res.status(503).json({ error: 'Payments are not configured yet.' });

  const order = await razorpay.orders.create({
    amount: plan.price * 100, currency: 'INR', receipt: 'shop_' + Date.now(),
  });
  db.prepare(`INSERT INTO pending_shops (order_id, owner_name, email, phone, shop_name, city, address, plan)
              VALUES (?,?,?,?,?,?,?,?)`).run(
    order.id, clean(b.ownerName), email, clean(b.phone, 20), clean(b.shopName), clean(b.city, 60),
    clean(b.address, 300), b.plan);
  res.json({ orderId: order.id, amount: order.amount, keyId: env.RAZORPAY_KEY_ID, planLabel: plan.label });
}));

app.post('/api/shops/verify', limiter(30), wrap(async (req, res) => {
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body;
  if (!oid || !pid || !sig) return res.status(400).json({ error: 'Missing payment details.' });
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET || '').update(`${oid}|${pid}`).digest('hex');
  const ok = expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  if (!ok) return res.status(400).json({ error: 'Payment could not be verified.' });

  const p = db.prepare('SELECT * FROM pending_shops WHERE order_id = ?').get(oid);
  if (!p) return res.status(404).json({ error: 'Order not found.' });
  if (p.status === 'paid') return res.json({ ok: true });

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(p.email);
  let password = null;
  if (!user) {
    password = crypto.randomBytes(6).toString('base64url');
    const id = db.prepare('INSERT INTO users (email, password_hash) VALUES (?,?)')
      .run(p.email, bcrypt.hashSync(password, 10)).lastInsertRowid;
    user = { id };
  }
  db.prepare('INSERT INTO shops (user_id, name, city, phone, address, plan) VALUES (?,?,?,?,?,?)')
    .run(user.id, p.shop_name, p.city, p.phone, p.address, p.plan);
  db.prepare("UPDATE pending_shops SET status='paid' WHERE order_id=?").run(oid);

  const site = env.SITE_URL || 'http://localhost:5173';
  const body = password
    ? `Hi ${p.owner_name || 'there'},\n\nYour shop "${p.shop_name}" is open on SellBuyAnywhere.\n\nLogin: ${site}/login\nEmail: ${p.email}\nPassword: ${password}\n\nLog in and add your products.`
    : `Hi ${p.owner_name || 'there'},\n\nYour shop "${p.shop_name}" is open. Log in with your existing account: ${site}/login`;
  if (mailer) {
    mailer.sendMail({ from: env.MAIL_FROM, to: p.email, subject: 'Your SellBuyAnywhere shop is ready', text: body })
      .catch((e) => console.error('Mail failed:', e.message));
  } else console.log('--- EMAIL (SMTP not configured) ---\n' + body);
  res.json({ ok: true });
}));

// ---------- Auth ----------
app.post('/api/auth/login', limiter(20), wrap(async (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash))
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '14d' }), email: u.email, role: u.role });
}));

app.get('/api/me', auth, (req, res) => {
  const shops = db.prepare('SELECT * FROM shops WHERE user_id = ?').all(req.user.id);
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  res.json({ email: req.user.email, role: u?.role || 'owner', shops });
});

// ---------- Products ----------
app.get('/api/products', (req, res) => {
  const city = clean(req.query.city, 60);
  const category = clean(req.query.category, 60);
  const rows = db.prepare(`${productSelect}
    WHERE (? = '' OR p.city = ? COLLATE NOCASE) AND (? = '' OR p.category = ?)
    ORDER BY p.id DESC LIMIT 24`).all(city, city, category, category);
  res.json(rows);
});

app.get('/api/products/mine', auth, (req, res) => {
  res.json(db.prepare(`${productSelect} WHERE s.user_id = ? ORDER BY p.id DESC`).all(req.user.id));
});

app.get('/api/products/:id', (req, res) => {
  const p = db.prepare(`${productSelect} WHERE p.id = ?`).get(req.params.id);
  p ? res.json(p) : res.status(404).json({ error: 'This listing is no longer available.' });
});

app.post('/api/products', auth, upload.single('image'), (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE user_id = ? ORDER BY id LIMIT 1').get(req.user.id);
  if (!shop) return res.status(403).json({ error: 'Open a shop first to add products.' });
  const price = Math.round(Number(req.body.price));
  if (!clean(req.body.title) || !(price >= 0)) return res.status(400).json({ error: 'Add a title and a price.' });
  const id = db.prepare(`INSERT INTO products (shop_id, title, description, price, category, city, image)
    VALUES (?,?,?,?,?,?,?)`).run(
    shop.id, clean(req.body.title, 120), clean(req.body.description, 2000), price,
    clean(req.body.category, 60) || 'Other', shop.city, req.file ? `/uploads/${req.file.filename}` : '').lastInsertRowid;
  res.status(201).json({ id });
});

app.delete('/api/products/:id', auth, (req, res) => {
  const r = db.prepare(`DELETE FROM products WHERE id = ? AND shop_id IN (SELECT id FROM shops WHERE user_id = ?)`)
    .run(req.params.id, req.user.id);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Listing not found.' });
});

// ---------- Search: own database first, then Meta Llama ----------
app.get('/api/search', limiter(120), wrap(async (req, res) => {
  const q = clean(req.query.q, 100);
  const city = clean(req.query.city, 60);
  if (!q) return res.json({ local: [], ai: [], aiEnabled: !!env.LLAMA_API_KEY });
  const like = `%${q}%`;
  const local = db.prepare(`${productSelect}
    WHERE (p.title LIKE ? OR p.description LIKE ? OR p.category LIKE ?)
    AND (? = '' OR p.city = ? COLLATE NOCASE)
    ORDER BY p.id DESC LIMIT 40`).all(like, like, like, city, city);
  let ai = [], aiError = false;
  try { ai = (await aiSuggestions(q, city)) || []; } catch (e) { console.error(e.message); aiError = true; }
  res.json({ local, ai, aiEnabled: !!env.LLAMA_API_KEY, aiError });
}));

app.post('/api/search/image', limiter(30), memUpload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an image.' });
  const url = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const text = await askLlama([{
    role: 'user',
    content: [
      { type: 'text', text: 'Name the product in this photo in 1 to 4 words, as a shopper would search for it. Reply with only the name.' },
      { type: 'image_url', image_url: { url } },
    ],
  }], env.LLAMA_VISION_MODEL || env.LLAMA_MODEL);
  if (!text) return res.status(503).json({ error: 'Image search is not configured yet.' });
  res.json({ query: clean(text.replace(/["\n.]/g, ' '), 60) });
}));

// ---------- Ads ----------
app.get('/api/ads', (req, res) => {
  const slot = clean(req.query.slot, 40);
  res.json(db.prepare('SELECT id, slot, title, image, link FROM ads WHERE active = 1 AND slot = ? ORDER BY RANDOM() LIMIT 3').all(slot));
});

// ---------- Admin and AI calls ----------
const ctx = { db, env, auth, wrap, clean, limiter, upload, askLlama, JWT_SECRET, mailer, PLANS };
registerAdmin(app, ctx);
registerCalls(app, ctx);

// ---------- Serve the built React app in production ----------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
const dist = path.join(__dirname, '../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
});

const server = app.listen(PORT, () => console.log(`SellBuyAnywhere running on http://localhost:${PORT}`));
attachVoiceSocket(server, ctx);
