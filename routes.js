// Public and signed-in user API: auth, listings (ads), shops, search, AI helpers, payments, pages, contact.
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db, getSetting, resolvePage, UPLOADS_DIR } from './db.js';
import { JWT_SECRET } from './config.js';
import { aiEnabled, aiParseSearch, aiSuggestions, aiToEnglish, aiImageToQuery, aiDescribe, aiModerate, aiAsk, aiAssistant, aiShopIntake } from './ai.js';
import { wrap, clean, normalizePhone, limiter, sendMail, randomPassword, siteUrl, isEmail, auth, optAuth, signToken, upload, memUpload } from './util.js';

export const PLAN_LABELS = { basic: 'Basic shop', ai: 'Shop + AI chat and recommendations', store: 'Full e-commerce + AI' };
const regularPrice = (k) => Number(getSetting(`plan_${k}_price`)) || 0;
const promoOn = () => getSetting('promo_active') === 'yes' && Number(getSetting('promo_shop_price')) > 0;
// Launch offer (e.g. open a Basic shop for Rs 1). Razorpay's minimum order is Rs 1.
const planPrice = (k) => (k === 'basic' && promoOn() ? Math.max(1, Math.round(Number(getSetting('promo_shop_price')))) : regularPrice(k));
const premium = () => ({ price: Number(getSetting('premium_price')) || 50, days: Number(getSetting('premium_days')) || 7 });

let rz = null, rzKey = '';
function razorpay() {
  const id = getSetting('razorpay_key_id'), sec = getSetting('razorpay_key_secret');
  if (!id || !sec) return null;
  if (!rz || rzKey !== id + sec) { rz = new Razorpay({ key_id: id, key_secret: sec }); rzKey = id + sec; }
  return rz;
}
async function createOrder(kind, rupees, meta, userId = null) {
  const r = razorpay();
  if (!r) { const e = new Error('Payments are not configured yet.'); e.status = 503; throw e; }
  const o = await r.orders.create({ amount: rupees * 100, currency: 'INR', receipt: `${kind}_${Date.now()}` });
  db.prepare('INSERT INTO payments (kind, order_id, user_id, amount, meta) VALUES (?,?,?,?,?)').run(kind, o.id, userId, rupees, JSON.stringify(meta));
  return { orderId: o.id, amount: o.amount, keyId: getSetting('razorpay_key_id') };
}

const MAXIMG = 6;
const imagesOf = (row) => { let a = []; try { a = JSON.parse(row.images || '[]'); } catch { /* ignore */ } return a.length ? a : row.image ? [row.image] : []; };
const pubRow = ({ images, ...r }) => ({ ...r, image_count: imagesOf({ images, image: r.image }).length });
const rmFiles = (list) => list.forEach((u) => { try { if (/^\/uploads\/[\w.-]+$/.test(u)) fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(u))); } catch { /* already gone */ } });
const LSEL = `SELECT l.images,l.id,l.title,l.description,l.price,l.category,l.city,l.image,l.shop_id,l.user_id,l.status,l.views,l.created_at,l.featured_until,
  COALESCE(l.featured_until > datetime('now'), 0) AS featured, s.name AS shop_name FROM listings l LEFT JOIN shops s ON s.id = l.shop_id`;

function findListings({ q = '', terms = [], city = '', category = '', shop = '', minPrice = null, maxPrice = null, limit = 24, offset = 0 }) {
  const w = ["l.status = 'active'"], a = [];
  if (city) { w.push('l.city = ? COLLATE NOCASE'); a.push(city); }
  if (category) { w.push('l.category = ? COLLATE NOCASE'); a.push(category); }
  if (shop) { w.push('l.shop_id = ?'); a.push(Number(shop)); }
  if (minPrice !== null) { w.push('l.price >= ?'); a.push(minPrice); }
  if (maxPrice !== null) { w.push('l.price <= ?'); a.push(maxPrice); }
  const all = [q, ...terms].filter(Boolean);
  if (all.length) { w.push('(' + all.map(() => '(l.title LIKE ? OR l.description LIKE ? OR l.category LIKE ? OR s.name LIKE ?)').join(' OR ') + ')');
    all.forEach((t) => a.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`)); }
  const where = w.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM listings l LEFT JOIN shops s ON s.id = l.shop_id WHERE ${where}`).get(...a).n;
  const items = db.prepare(`${LSEL} WHERE ${where} ORDER BY featured DESC, l.id DESC LIMIT ? OFFSET ?`).all(...a, limit, offset).map(pubRow);
  return { items, total };
}

function fulfill(p, paymentId) {
  const meta = JSON.parse(p.meta || '{}');
  db.prepare("UPDATE payments SET status='paid', payment_id=? WHERE order_id=?").run(paymentId, p.order_id);
  if (p.kind === 'featured') {
    const { days } = premium();
    db.prepare(`UPDATE listings SET featured_until = datetime(CASE WHEN featured_until > datetime('now') THEN featured_until ELSE datetime('now') END, '+' || ? || ' days') WHERE id = ?`)
      .run(days, meta.listingId);
    return { kind: 'featured', listingId: meta.listingId };
  }
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(meta.email);
  let password = null;
  if (!user) {
    password = randomPassword();
    user = { id: db.prepare("INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,'user',?,?)")
      .run(meta.email, bcrypt.hashSync(password, 10), meta.ownerName || '', meta.phone || '').lastInsertRowid };
  }
  const shopId = db.prepare('INSERT INTO shops (user_id,name,city,phone,address,description,plan) VALUES (?,?,?,?,?,?,?)')
    .run(user.id, meta.shopName, meta.city, meta.phone, meta.address || '', meta.description || '', meta.plan).lastInsertRowid;
  const site = getSetting('site_name');
  sendMail(meta.email, `Your ${site} shop is ready`, password
    ? `Hi ${meta.ownerName || 'there'},\n\nYour shop "${meta.shopName}" is open on ${site}.\n\nSign in: ${siteUrl()}/login\nEmail: ${meta.email}\nPassword: ${password}\n\nChange your password after signing in, then add your products.`
    : `Hi ${meta.ownerName || 'there'},\n\nYour shop "${meta.shopName}" is open. Sign in with your existing account: ${siteUrl()}/login`);
  return { kind: 'shop', shopId };
}

export function registerRoutes(app) {
  const ai = limiter(40);
  const aiWrap = (fn) => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { console.error('AI error:', e.message); if (!res.headersSent) res.status(502).json({ error: 'The AI service did not respond. Please try again in a moment.' }); } });
  const needAi = (res) => res.status(503).json({ error: 'AI is not set up yet.' });

  // ---------- Site info ----------
  app.get('/api/meta', (_req, res) => res.json({
    version: 2,
    categories: db.prepare('SELECT name,name_te,icon FROM categories WHERE active=1 ORDER BY sort,id').all(),
    cities: db.prepare('SELECT name,name_te,state,lat,lng FROM cities WHERE active=1 ORDER BY sort,id').all(),
    plans: Object.keys(PLAN_LABELS).map((k) => ({ key: k, label: PLAN_LABELS[k], price: planPrice(k), original: planPrice(k) < regularPrice(k) ? regularPrice(k) : null })),
    promo: promoOn() ? { price: planPrice('basic'), original: regularPrice('basic'), title: getSetting('promo_title') } : null,
    premium: premium(),
    site: { name: getSetting('site_name'), email: getSetting('support_email'), phone: getSetting('support_phone'), address: getSetting('address') },
    aiEnabled: aiEnabled(),
  }));
  // Nearest supported city to the visitor's coordinates (used to pre-select the city from their location)
  app.get('/api/geo/nearest', (req, res) => {
    const lat = Number(req.query.lat), lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'Send lat and lng.' });
    const rad = (x) => (x * Math.PI) / 180;
    let best = null;
    for (const c of db.prepare('SELECT name,lat,lng FROM cities WHERE active=1 AND lat IS NOT NULL AND lng IS NOT NULL').all()) {
      const dLa = rad(c.lat - lat), dLo = rad(c.lng - lng);
      const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(c.lat)) * Math.sin(dLo / 2) ** 2;
      const km = 12742 * Math.asin(Math.sqrt(h));
      if (!best || km < best.km) best = { city: c.name, km: Math.round(km) };
    }
    res.json(best && best.km <= 150 ? best : { city: null, nearest: best?.city || null, km: best?.km ?? null });
  });
  app.get('/api/pages/:slug', (req, res) => {
    const p = resolvePage(req.params.slug, req.query.lang);
    p ? res.json(p) : res.status(404).json({ error: 'Page not found.' });
  });
  app.get('/api/ads', (req, res) => res.json(db.prepare('SELECT id,slot,title,image,link FROM ads WHERE active=1 AND slot=? ORDER BY RANDOM() LIMIT 3').all(clean(req.query.slot, 40))));
  app.post('/api/contact', limiter(10), (req, res) => {
    const b = req.body;
    if (!clean(b.name) || !isEmail(clean(b.email)) || clean(b.message, 3000).length < 5) return res.status(400).json({ error: 'Add your name, a valid email and a message.' });
    db.prepare('INSERT INTO messages (name,email,phone,subject,message) VALUES (?,?,?,?,?)').run(clean(b.name), clean(b.email), clean(b.phone, 20), clean(b.subject, 150), clean(b.message, 3000));
    sendMail(getSetting('support_email'), `New message: ${clean(b.subject, 100) || 'Contact form'}`, `From: ${clean(b.name)} <${clean(b.email)}> ${clean(b.phone, 20)}\n\n${clean(b.message, 3000)}`);
    res.json({ ok: true });
  });

  // ---------- Accounts ----------
  app.post('/api/auth/register', limiter(20), (req, res) => {
    const email = clean(req.body.email, 120).toLowerCase(), pw = String(req.body.password || '');
    if (!isEmail(email) || pw.length < 6 || !clean(req.body.name)) return res.status(400).json({ error: 'Enter your name, a valid email and a password of at least 6 characters.' });
    if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    const phone = normalizePhone(req.body.phone) || '';
    const id = db.prepare("INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,'user',?,?)").run(email, bcrypt.hashSync(pw, 10), clean(req.body.name, 80), phone).lastInsertRowid;
    res.status(201).json({ token: signToken({ id, email }), role: 'user' });
  });
  app.post('/api/auth/login', limiter(30), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(clean(req.body.email, 120).toLowerCase());
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (u.status === 'blocked') return res.status(403).json({ error: 'This account has been blocked. Contact support.' });
    res.json({ token: signToken(u), role: u.role });
  });
  app.post('/api/auth/forgot', limiter(10), (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(clean(req.body.email, 120).toLowerCase());
    if (u) {
      const token = jwt.sign({ id: u.id }, JWT_SECRET + u.password_hash, { expiresIn: '30m' });
      sendMail(u.email, 'Reset your password', `Open this link within 30 minutes to choose a new password:\n${siteUrl()}/reset?token=${token}\n\nIf you did not ask for this, ignore this email.`);
    }
    res.json({ ok: true });
  });
  app.post('/api/auth/reset', limiter(10), (req, res) => {
    const pw = String(req.body.password || '');
    const d = jwt.decode(String(req.body.token || ''));
    const u = d && db.prepare('SELECT * FROM users WHERE id=?').get(d.id);
    try { if (!u || pw.length < 6) throw new Error(); jwt.verify(req.body.token, JWT_SECRET + u.password_hash); }
    catch { return res.status(400).json({ error: 'This reset link is invalid or has expired, or the password is too short.' }); }
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(pw, 10), u.id);
    res.json({ ok: true });
  });
  app.get('/api/me', auth, (req, res) => {
    const { id, email, role, name, phone } = req.user;
    res.json({ id, email, role, name, phone, shops: db.prepare('SELECT * FROM shops WHERE user_id=?').all(id) });
  });
  app.patch('/api/me', auth, (req, res) => {
    const phone = req.body.phone ? normalizePhone(req.body.phone) : '';
    if (req.body.phone && !phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });
    db.prepare('UPDATE users SET name=?, phone=? WHERE id=?').run(clean(req.body.name, 80), phone, req.user.id);
    if (req.body.password) {
      if (String(req.body.password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(req.body.password), 10), req.user.id);
    }
    res.json({ ok: true });
  });

  // ---------- Listings (ads) ----------
  app.get('/api/listings', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 24, 60), page = Math.max(Number(req.query.page) || 1, 1);
    res.json(findListings({ q: clean(req.query.q, 100), city: clean(req.query.city, 60), category: clean(req.query.category, 60), shop: req.query.shop, limit, offset: (page - 1) * limit }));
  });
  app.get('/api/listings/mine', auth, (req, res) => res.json(db.prepare(`${LSEL} WHERE l.user_id=? ORDER BY l.id DESC`).all(req.user.id).map((l) => ({ ...pubRow(l), images: imagesOf(l) }))));
  app.get('/api/listings/:id', (req, res) => {
    const l = db.prepare(`${LSEL} WHERE l.id=?`).get(req.params.id);
    if (!l || l.status === 'hidden') return res.status(404).json({ error: 'This ad is no longer available.' });
    db.prepare('UPDATE listings SET views=views+1 WHERE id=?').run(l.id);
    const shop = l.shop_id ? db.prepare('SELECT id,name,address,phone FROM shops WHERE id=?').get(l.shop_id) : null;
    const seller = db.prepare('SELECT name FROM users WHERE id=?').get(l.user_id);
    const { user_id, images, ...pub } = l;
    res.json({ ...pub, images: imagesOf(l), contact_phone: db.prepare('SELECT phone FROM listings WHERE id=?').get(l.id).phone || shop?.phone || '', shop, seller_name: seller?.name || '' });
  });
  const listingFields = (b, user, existing = {}) => {
    const cats = db.prepare('SELECT name FROM categories').all().map((c) => c.name);
    return { title: clean(b.title, 120), description: clean(b.description, 2000), price: Math.max(0, Math.round(Number(b.price) || 0)),
      category: cats.includes(b.category) ? b.category : existing.category || 'Others', city: clean(b.city, 60) || existing.city || '',
      phone: normalizePhone(b.phone) || user.phone || existing.phone || '' };
  };
  const photos = upload.fields([{ name: 'images', maxCount: MAXIMG }, { name: 'image', maxCount: 1 }]);
  const filesOf = (req) => [...(req.files?.images || []), ...(req.files?.image || [])].map((f) => `/uploads/${f.filename}`);
  app.post('/api/listings', auth, photos, wrap(async (req, res) => {
    const f = listingFields(req.body, req.user);
    if (!f.title || !f.city) return res.status(400).json({ error: 'Add a title and choose a city.' });
    if (!f.phone) return res.status(400).json({ error: 'Add a valid 10-digit mobile number so buyers can reach you.' });
    const cap = Number(getSetting('max_ads_per_day')) || 10;
    if (db.prepare("SELECT COUNT(*) n FROM listings WHERE user_id=? AND created_at >= datetime('now','-1 day')").get(req.user.id).n >= cap)
      return res.status(429).json({ error: `You can post up to ${cap} ads a day. Try again tomorrow.` });
    const mod = await aiModerate(f);
    const shop = db.prepare("SELECT id FROM shops WHERE user_id=? AND status='active' ORDER BY id LIMIT 1").get(req.user.id);
    const useShop = shop && req.body.as_shop === 'true';
    const pics = filesOf(req).slice(0, MAXIMG);
    const id = db.prepare('INSERT INTO listings (user_id,shop_id,title,description,price,category,city,phone,image,images,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(req.user.id, useShop ? shop.id : null, f.title, f.description, f.price, f.category, f.city, f.phone, pics[0] || '', JSON.stringify(pics), mod.ok ? 'active' : 'pending').lastInsertRowid;
    res.status(201).json({ id, status: mod.ok ? 'active' : 'pending', reason: mod.reason });
  }));
  const owned = (req) => db.prepare('SELECT * FROM listings WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  app.put('/api/listings/:id', auth, photos, (req, res) => {
    const l = owned(req);
    if (!l) return res.status(404).json({ error: 'Ad not found.' });
    const f = listingFields(req.body, req.user, l);
    if (!f.title) return res.status(400).json({ error: 'Add a title.' });
    const had = imagesOf(l);
    let keep = had;
    if (req.body.keep !== undefined) { try { keep = JSON.parse(req.body.keep).filter((u) => had.includes(u)); } catch { keep = had; } }
    const pics = [...keep, ...filesOf(req)].slice(0, MAXIMG);
    rmFiles(had.filter((u) => !pics.includes(u)));
    db.prepare('UPDATE listings SET title=?,description=?,price=?,category=?,city=?,phone=?,image=?,images=? WHERE id=?')
      .run(f.title, f.description, f.price, f.category, f.city, f.phone, pics[0] || '', JSON.stringify(pics), l.id);
    res.json({ ok: true });
  });
  app.delete('/api/listings/:id', auth, (req, res) => {
    const own = owned(req);
    if (!own) return res.status(404).json({ error: 'Ad not found.' });
    rmFiles(imagesOf(own));
    db.prepare('DELETE FROM listings WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/listings/:id/report', limiter(10), (req, res) => {
    if (!db.prepare('SELECT 1 FROM listings WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Ad not found.' });
    db.prepare('INSERT INTO reports (listing_id, reason) VALUES (?,?)').run(req.params.id, clean(req.body.reason, 500) || 'No reason given');
    res.json({ ok: true });
  });
  app.post('/api/listings/:id/feature/order', auth, wrap(async (req, res) => {
    const l = owned(req);
    if (!l) return res.status(404).json({ error: 'Ad not found.' });
    if (l.status !== 'active') return res.status(400).json({ error: 'This ad is waiting for review. Premium can be added once it is approved.' });
    const p = premium();
    res.json({ ...(await createOrder('featured', p.price, { listingId: l.id }, req.user.id)), label: `Premium ad, ${p.days} days` });
  }));

  // ---------- Shops ----------
  app.get('/api/shops', (req, res) => {
    const w = ["s.status='active'"], a = [];
    if (req.query.city) { w.push('s.city = ? COLLATE NOCASE'); a.push(clean(req.query.city, 60)); }
    if (req.query.q) { w.push('(s.name LIKE ? OR s.description LIKE ?)'); a.push(`%${clean(req.query.q, 80)}%`, `%${clean(req.query.q, 80)}%`); }
    res.json(db.prepare(`SELECT s.id,s.name,s.city,s.address,s.description,s.plan,
      (SELECT COUNT(*) FROM listings l WHERE l.shop_id=s.id AND l.status='active') AS count FROM shops s WHERE ${w.join(' AND ')} ORDER BY count DESC, s.id DESC LIMIT 60`).all(...a));
  });
  app.get('/api/shops/:id', (req, res) => {
    const s = db.prepare("SELECT id,name,city,address,description,phone,plan FROM shops WHERE id=? AND status='active'").get(req.params.id);
    s ? res.json({ ...s, listings: findListings({ shop: s.id, limit: 60 }).items }) : res.status(404).json({ error: 'Shop not found.' });
  });
  app.put('/api/shops/:id', auth, (req, res) => {
    const s = db.prepare('SELECT * FROM shops WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
    if (!s) return res.status(404).json({ error: 'Shop not found.' });
    const phone = normalizePhone(req.body.phone) || s.phone;
    db.prepare('UPDATE shops SET name=?,city=?,phone=?,address=?,description=? WHERE id=?')
      .run(clean(req.body.name) || s.name, clean(req.body.city, 60) || s.city, phone, clean(req.body.address, 300), clean(req.body.description, 500), s.id);
    res.json({ ok: true });
  });
  app.post('/api/shops/order', limiter(30), wrap(async (req, res) => {
    const b = req.body, email = clean(b.email, 120).toLowerCase(), phone = normalizePhone(b.phone);
    const plan = PLAN_LABELS[b.plan] ? b.plan : 'basic';
    if (!clean(b.shopName) || !isEmail(email) || !phone || !clean(b.city) || !clean(b.ownerName)) return res.status(400).json({ error: 'Fill in shop name, your name, a valid email, a 10-digit mobile number and city.' });
    const meta = { shopName: clean(b.shopName, 100), ownerName: clean(b.ownerName, 80), email, phone, city: clean(b.city, 60), address: clean(b.address, 300), description: clean(b.description, 500), plan };
    res.json({ ...(await createOrder('shop', planPrice(plan), meta)), label: PLAN_LABELS[plan] });
  }));

  // ---------- Payments (shop plans and Premium ads) ----------
  app.post('/api/payments/verify', limiter(40), (req, res) => {
    const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body;
    if (!oid || !pid || !sig) return res.status(400).json({ error: 'Missing payment details.' });
    const exp = crypto.createHmac('sha256', getSetting('razorpay_key_secret')).update(`${oid}|${pid}`).digest('hex');
    if (exp.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig))) return res.status(400).json({ error: 'Payment could not be verified.' });
    const p = db.prepare('SELECT * FROM payments WHERE order_id=?').get(oid);
    if (!p) return res.status(404).json({ error: 'Order not found.' });
    res.json({ ok: true, ...(p.status === 'paid' ? { kind: p.kind } : fulfill(p, pid)) });
  });

  // ---------- Search ----------
  app.get('/api/search', limiter(120), wrap(async (req, res) => {
    const original = clean(req.query.q, 100);
    let q = original, city = clean(req.query.city, 60), category = clean(req.query.category, 60), minPrice = null, maxPrice = null, parsed = null;
    // AI understands full sentences like "honda bike under 60k in vizag"
    if (original.split(/\s+/).length >= 3 && aiEnabled()) {
      try {
        const cities = db.prepare('SELECT name FROM cities WHERE active=1').all().map((c) => c.name), cats = db.prepare('SELECT name FROM categories WHERE active=1').all().map((c) => c.name);
        parsed = await aiParseSearch(original, cities, cats);
        if (parsed) { q = parsed.keywords; if (parsed.city) city = parsed.city; if (parsed.category && !category) category = parsed.category; minPrice = parsed.min_price; maxPrice = parsed.max_price; }
      } catch (e) { console.error(e.message); }
    }
    const terms = [];
    if (q && /[\u0C00-\u0C7F]/.test(q) && aiEnabled()) { try { const en = await aiToEnglish(q); if (en) terms.push(en); } catch { /* keep going */ } }
    let { items, total } = findListings({ q, terms, city, category, minPrice, maxPrice, limit: 40 });
    let relaxed = false;
    if (!items.length && parsed) { ({ items, total } = findListings({ q: original, limit: 40 })); relaxed = items.length > 0; }
    let suggestions = [], aiError = false;
    if ((q || original) && aiEnabled()) { try { suggestions = await aiSuggestions(terms[0] || q || original, city); } catch (e) { console.error(e.message); aiError = true; } }
    res.json({ local: items, total, ai: suggestions, aiEnabled: aiEnabled(), aiError, translatedTo: terms[0] || '', city,
      parsed: parsed && (parsed.keywords || parsed.city || parsed.category || parsed.min_price !== null || parsed.max_price !== null) ? parsed : null, relaxed });
  }));
  app.post('/api/search/image', limiter(30), memUpload.single('image'), aiWrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a photo (JPG, PNG or WebP).' });
    if (!aiEnabled()) return needAi(res);
    const query = await aiImageToQuery(req.file.buffer, req.file.mimetype);
    res.json({ query });
  }));

  // ---------- AI helpers ----------
  app.post('/api/ai/chat', ai, aiWrap(async (req, res) => {
    if (!aiEnabled()) return needAi(res);
    const history = (req.body.messages || []).slice(-10).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clean(m.content, 800) })).filter((m) => m.content);
    if (!history.length) return res.status(400).json({ error: 'Say something first.' });
    const settings = { site: getSetting('site_name'), premium_price: premium().price, premium_days: premium().days, plan_basic_price: planPrice('basic') };
    res.json(await aiAssistant(history, req.body.lang, settings));
  }));
  app.post('/api/ai/describe', ai, auth, aiWrap(async (req, res) => {
    if (!aiEnabled()) return needAi(res);
    if (!clean(req.body.title)) return res.status(400).json({ error: 'Type the title first.' });
    res.json({ description: await aiDescribe({ title: clean(req.body.title, 120), category: clean(req.body.category, 60), city: clean(req.body.city, 60), l: req.body.lang }) });
  }));
  app.post('/api/ai/ask', ai, aiWrap(async (req, res) => {
    if (!aiEnabled()) return needAi(res);
    const l = db.prepare(`${LSEL} WHERE l.id=? AND l.status='active'`).get(req.body.listingId);
    if (!l || !clean(req.body.question)) return res.status(400).json({ error: 'Ask a question about an available ad.' });
    const history = (req.body.history || []).slice(-6).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clean(m.content, 500) }));
    res.json({ reply: await aiAsk(l, clean(req.body.question, 400), history, req.body.lang) });
  }));
  app.post('/api/ai/shop-intake', ai, aiWrap(async (req, res) => {
    if (!aiEnabled()) return needAi(res);
    const cities = db.prepare('SELECT name FROM cities WHERE active=1').all().map((c) => c.name);
    const history = (req.body.history || []).slice(-20).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: clean(m.content, 500) }));
    const r = await aiShopIntake({ history, fields: req.body.fields || {}, l: req.body.lang, cities, plans: Object.keys(PLAN_LABELS).join('/') });
    const f = r.fields, phone = normalizePhone(f.phone);
    if (phone) f.phone = phone.slice(3); else if (f.phone) delete f.phone;
    if (f.email && !isEmail(f.email)) delete f.email;
    if (f.city) { const c = cities.find((x) => x.toLowerCase() === f.city.toLowerCase()); f.city = c || f.city; }
    if (f.plan && !PLAN_LABELS[f.plan]) delete f.plan;
    res.json({ reply: r.reply, fields: f, ready: r.required.every((k) => f[k]) });
  }));
}
