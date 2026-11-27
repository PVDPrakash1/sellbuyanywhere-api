// Admin API: full create/read/update/delete for every part of the site. All routes need an admin login.
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { db, getSetting, setSetting, SECRET_KEYS, DEFAULTS, wsKey, BACKUP_DIR } from './db.js';
import { backupNow, listBackups, restoreFrom, zipBackup } from './backup.js';
import { aiChat, aiEnabled, aiListModels, aiProvider, aiStatus } from './ai.js';
import { PLAN_LABELS } from './routes.js';
import { clean, normalizePhone, adminOnly, upload, wrap, randomPassword, isEmail, siteUrl, safeApp, saveImages } from './util.js';

const n = async (sql, ...a) => (await db.prepare(sql).get(...a)).n;
const bool = (v) => (v === true || v === 'true' || v === '1' || v === 1 ? 1 : 0);
const img = async (req, old = '') => (req.file ? (await saveImages([req.file]))[0] : old);
const cleanUrl = (v) => { const s = clean(v, 600); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };

export function registerAdmin(appRaw) {
  const app = safeApp(appRaw);
  const A = adminOnly;
  const page = (req) => ({ limit: Math.min(Number(req.query.limit) || 50, 200), offset: ((Math.max(Number(req.query.page) || 1, 1)) - 1) * (Math.min(Number(req.query.limit) || 50, 200)) });
  const like = (req) => `%${clean(req.query.q, 80)}%`;

  // ---------- Dashboard ----------
  app.get('/api/admin/stats', ...A, async (_req, res) => res.json({
    users: await n("SELECT COUNT(*) n FROM users WHERE role!='admin'"), shops: await n('SELECT COUNT(*) n FROM shops'),
    listings: await n("SELECT COUNT(*) n FROM listings WHERE status='active'"), pending: await n("SELECT COUNT(*) n FROM listings WHERE status='pending'"),
    premium: await n("SELECT COUNT(*) n FROM listings WHERE featured_until > NOW()"),
    reports: await n("SELECT COUNT(*) n FROM reports WHERE status='open'"), messages: await n("SELECT COUNT(*) n FROM messages WHERE status='new'"),
    calls24: await n("SELECT COUNT(*) n FROM calls WHERE created_at >= (NOW() - INTERVAL 1 DAY)"),
    revenue: await n("SELECT CAST(COALESCE(SUM(amount),0) AS SIGNED) n FROM payments WHERE status='paid'"),
    revenueShops: await n("SELECT CAST(COALESCE(SUM(amount),0) AS SIGNED) n FROM payments WHERE status='paid' AND kind='shop'"),
    revenuePremium: await n("SELECT CAST(COALESCE(SUM(amount),0) AS SIGNED) n FROM payments WHERE status='paid' AND kind='featured'"),
    ai: { provider: aiProvider(), enabled: aiEnabled(), ...aiStatus() },
    storage: { database: 'MySQL', createdAt: getSetting('db_created_at'), boots: Number(getSetting('boots')) || 0, lastBackup: listBackups()[0]?.at || null },
  }));

  // ---------- Backup and restore ----------
  const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 } });
  app.get('/api/admin/backup', ...A, async (_req, res) => {
    const media = await db.prepare('SELECT COUNT(*) n, COALESCE(SUM(LENGTH(data)),0) bytes FROM media').get();
    res.json({ database: 'MySQL', backupDir: BACKUP_DIR, createdAt: getSetting('db_created_at'), boots: Number(getSetting('boots')) || 0, lastBoot: getSetting('last_boot_at'),
      photos: Number(media.n), photoBytes: Number(media.bytes), backups: listBackups() });
  });
  app.post('/api/admin/backup/now', ...A, async (_req, res) => res.json({ ok: true, name: await backupNow('manual') }));
  app.get('/api/admin/backup/download', ...A, async (_req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="sba-backup-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.send(await zipBackup());
  });
  app.get('/api/admin/backup/file/:name', ...A, (req, res) => {
    if (!/^sba-[\w.-]+\.json\.gz$/.test(req.params.name) || !fs.existsSync(path.join(BACKUP_DIR, req.params.name))) return res.status(404).json({ error: 'Backup not found.' });
    res.download(path.join(BACKUP_DIR, req.params.name));
  });
  app.post('/api/admin/backup/restore', ...A, restoreUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a backup file (.zip, .json or .json.gz).' });
    try {
      const me = await db.prepare('SELECT email,password_hash,name FROM users WHERE id=?').get(req.user.id);
      res.json({ ok: true, ...(await restoreFrom(req.file.buffer, me)) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- Users ----------
  app.get('/api/admin/users', ...A, async (req, res) => res.json((await db.prepare(
    `SELECT id,email,name,phone,role,status,created_at,(SELECT COUNT(*) FROM listings WHERE user_id=users.id) AS ads,(SELECT COUNT(*) FROM shops WHERE user_id=users.id) AS shops
     FROM users WHERE email LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`).all(like(req), like(req), page(req).limit, page(req).offset))));
  app.post('/api/admin/users', ...A, async (req, res) => {
    const b = req.body, email = clean(b.email, 120).toLowerCase();
    if (!isEmail(email) || String(b.password || '').length < 6) return res.status(400).json({ error: 'A valid email and a password of 6+ characters are required.' });
    if ((await db.prepare('SELECT 1 FROM users WHERE email=?').get(email))) return res.status(409).json({ error: 'That email already exists.' });
    const id = (await db.prepare('INSERT INTO users (email,password_hash,role,name,phone,status) VALUES (?,?,?,?,?,?)').run(email, bcrypt.hashSync(String(b.password), 10),
      b.role === 'admin' ? 'admin' : 'user', clean(b.name, 80), normalizePhone(b.phone) || '', b.status === 'blocked' ? 'blocked' : 'active')).lastInsertRowid;
    res.status(201).json({ id });
  });
  app.put('/api/admin/users/:id', ...A, async (req, res) => {
    const u = (await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id)), b = req.body;
    if (!u) return res.status(404).json({ error: 'User not found.' });
    const role = b.role === 'admin' ? 'admin' : 'user', status = b.status === 'blocked' ? 'blocked' : 'active';
    if (u.id === req.user.id && (role !== 'admin' || status === 'blocked')) return res.status(400).json({ error: 'You cannot remove your own admin access.' });
    const email = clean(b.email, 120).toLowerCase() || u.email;
    if (email !== u.email && (await db.prepare('SELECT 1 FROM users WHERE email=?').get(email))) return res.status(409).json({ error: 'That email already exists.' });
    (await db.prepare('UPDATE users SET email=?,name=?,phone=?,role=?,status=? WHERE id=?').run(email, clean(b.name, 80), normalizePhone(b.phone) || clean(b.phone, 20), role, status, u.id));
    if (b.password) (await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(b.password), 10), u.id));
    res.json({ ok: true });
  });
  app.delete('/api/admin/users/:id', ...A, async (req, res) => {
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    await db.transaction(async (tx) => {
      (await tx.prepare('DELETE FROM listings WHERE user_id=? OR shop_id IN (SELECT id FROM shops WHERE user_id=?)').run(req.params.id, req.params.id));
      (await tx.prepare('DELETE FROM shops WHERE user_id=?').run(req.params.id));
      (await tx.prepare('DELETE FROM users WHERE id=?').run(req.params.id));
    });
    res.json({ ok: true });
  });

  // ---------- Shops ----------
  app.get('/api/admin/shops', ...A, async (req, res) => res.json((await db.prepare(
    `SELECT s.*, u.email AS owner_email, (SELECT COUNT(*) FROM listings WHERE shop_id=s.id) AS ads FROM shops s JOIN users u ON u.id=s.user_id
     WHERE s.name LIKE ? OR u.email LIKE ? ORDER BY s.id DESC LIMIT ? OFFSET ?`).all(like(req), like(req), page(req).limit, page(req).offset))));
  app.post('/api/admin/shops', ...A, async (req, res) => {
    const b = req.body, email = clean(b.owner_email, 120).toLowerCase(), phone = normalizePhone(b.phone);
    if (!isEmail(email) || !clean(b.name) || !clean(b.city) || !phone) return res.status(400).json({ error: 'Owner email, shop name, city and a valid mobile number are required.' });
    let u = (await db.prepare('SELECT id FROM users WHERE email=?').get(email)), password = null;
    if (!u) { password = String(b.owner_password || '').length >= 6 ? null : randomPassword(); const chosen = password || String(b.owner_password); u = { id: (await db.prepare("INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,'user',?,?)").run(email, bcrypt.hashSync(chosen, 10), clean(b.owner_name, 80), phone)).lastInsertRowid }; }
    const id = (await db.prepare('INSERT INTO shops (user_id,name,city,phone,address,description,plan,status) VALUES (?,?,?,?,?,?,?,?)')
      .run(u.id, clean(b.name, 100), clean(b.city, 60), phone, clean(b.address, 300), clean(b.description, 500), PLAN_LABELS[b.plan] ? b.plan : 'basic', b.status === 'suspended' ? 'suspended' : 'active')).lastInsertRowid;
    res.status(201).json({ id, email, password });
  });
  app.put('/api/admin/shops/:id', ...A, async (req, res) => {
    const s = (await db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id)), b = req.body;
    if (!s) return res.status(404).json({ error: 'Shop not found.' });
    (await db.prepare('UPDATE shops SET name=?,city=?,phone=?,address=?,description=?,plan=?,status=? WHERE id=?').run(clean(b.name, 100) || s.name, clean(b.city, 60) || s.city,
      normalizePhone(b.phone) || s.phone, b.address === undefined ? s.address : clean(b.address, 300), b.description === undefined ? s.description : clean(b.description, 500), PLAN_LABELS[b.plan] ? b.plan : s.plan, b.status === 'suspended' ? 'suspended' : 'active', s.id));
    res.json({ ok: true });
  });
  app.delete('/api/admin/shops/:id', ...A, async (req, res) => {
    await db.transaction(async (tx) => { await tx.prepare('DELETE FROM listings WHERE shop_id=?').run(req.params.id); await tx.prepare('DELETE FROM shops WHERE id=?').run(req.params.id); });
    res.json({ ok: true });
  });

  // ---------- Listings ----------
  const LQ = `SELECT l.id,l.title,l.description,l.price,l.category,l.city,l.phone,l.image,l.status,l.views,l.created_at,l.featured_until,l.shop_id,l.user_id,
    COALESCE(l.featured_until > NOW(),0) AS featured, s.name AS shop_name, u.email AS owner_email FROM listings l LEFT JOIN shops s ON s.id=l.shop_id LEFT JOIN users u ON u.id=l.user_id`;
  app.get('/api/admin/listings', ...A, async (req, res) => res.json((await db.prepare(
    `${LQ} WHERE (l.title LIKE ? OR u.email LIKE ?) AND (?='' OR l.status=?) ORDER BY l.id DESC LIMIT ? OFFSET ?`)
    .all(like(req), like(req), clean(req.query.status, 20), clean(req.query.status, 20), page(req).limit, page(req).offset))));
  const lvals = (b, req, old = {}) => { const u = (k) => b[k] === undefined; return {
    title: clean(b.title, 120) || old.title, description: u('description') ? old.description || '' : clean(b.description, 2000),
    price: u('price') ? old.price || 0 : Math.max(0, Math.round(Number(b.price) || 0)), category: clean(b.category, 60) || old.category || 'Others', city: clean(b.city, 60) || old.city,
    phone: u('phone') ? old.phone || '' : normalizePhone(b.phone) || clean(b.phone, 20), status: ['active', 'pending', 'hidden'].includes(b.status) ? b.status : old.status || 'active', buy_url: u('buy_url') ? old.buy_url || '' : cleanUrl(b.buy_url) }; };
  app.post('/api/admin/listings', ...A, upload.single('image'), async (req, res) => {
    const b = req.body, v = lvals(b, req);
    if (!v.title || !v.city) return res.status(400).json({ error: 'Title and city are required.' });
    const owner = (await db.prepare('SELECT id FROM users WHERE email=?').get(clean(b.owner_email, 120).toLowerCase())) || { id: req.user.id };
    const cover = await img(req, '');
    const id = (await db.prepare('INSERT INTO listings (user_id,shop_id,title,description,price,category,city,phone,image,images,buy_url,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(owner.id, Number(b.shop_id) || null, v.title, v.description, v.price, v.category, v.city, v.phone, cover, JSON.stringify(cover ? [cover] : []), v.buy_url, v.status)).lastInsertRowid;
    if (Number(b.featured_days) > 0) (await db.prepare("UPDATE listings SET featured_until=DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id=?").run(Number(b.featured_days), id));
    res.status(201).json({ id });
  });
  app.put('/api/admin/listings/:id', ...A, upload.single('image'), async (req, res) => {
    const l = (await db.prepare('SELECT * FROM listings WHERE id=?').get(req.params.id)), b = req.body;
    if (!l) return res.status(404).json({ error: 'Ad not found.' });
    const v = lvals(b, req, l);
    let pics = null;
    if (req.file) { const cover = await img(req, ''); let list = []; try { list = JSON.parse(l.images || '[]'); } catch { /* ignore */ } pics = [cover, ...(list.length ? list : l.image ? [l.image] : [])].slice(0, 6); }
    (await db.prepare('UPDATE listings SET title=?,description=?,price=?,category=?,city=?,phone=?,image=?,images=?,buy_url=?,status=?,shop_id=? WHERE id=?')
      .run(v.title, v.description, v.price, v.category, v.city, v.phone, pics ? pics[0] : l.image, pics ? JSON.stringify(pics) : l.images, v.buy_url, v.status, b.shop_id === undefined ? l.shop_id : Number(b.shop_id) || null, l.id));
    if (b.featured_days !== undefined && b.featured_days !== '') {
      const d = Number(b.featured_days);
      d > 0 ? (await db.prepare("UPDATE listings SET featured_until=DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id=?").run(d, l.id))
        : (await db.prepare('UPDATE listings SET featured_until=NULL WHERE id=?').run(l.id));
    }
    res.json({ ok: true });
  });
  app.delete('/api/admin/listings/:id', ...A, async (req, res) => { (await db.prepare('DELETE FROM listings WHERE id=?').run(req.params.id)); res.json({ ok: true }); });

  // ---------- Simple tables: categories, cities, banners, reports, messages ----------
  const crud = (name, table, cols, { order = 'id DESC', create = true, imageCol = null } = {}) => {
    const pick = async (b, req) => Promise.all(cols.map(async ([c, t]) => (c === imageCol ? await img(req, b.__old?.[c] || '') : t === 'int' ? Number(b[c]) || 0 : t === 'real' ? (b[c] === '' || b[c] === undefined ? null : Number(b[c])) : t === 'bool' ? bool(b[c]) : clean(b[c], 4000))));
    app.get(`/api/admin/${name}`, ...A, async (_req, res) => res.json((await db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 500`).all())));
    if (create) app.post(`/api/admin/${name}`, ...A, upload.single('image'), async (req, res) => {
      try { res.status(201).json({ id: (await db.prepare(`INSERT INTO ${table} (${cols.map((c) => c[0]).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...(await pick(req.body, req)))).lastInsertRowid }); }
      catch (e) { res.status(400).json({ error: /UNIQUE|Duplicate/.test(e.message) ? 'That name already exists.' : 'Please fill in all required fields.' }); }
    });
    app.put(`/api/admin/${name}/:id`, ...A, upload.single('image'), async (req, res) => {
      const old = (await db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id));
      if (!old) return res.status(404).json({ error: 'Not found.' });
      req.body.__old = old;
      const use = cols.filter(([c]) => req.body[c] !== undefined || c === imageCol);
      const vals = await pick(req.body, req);
      try { (await db.prepare(`UPDATE ${table} SET ${use.map((c) => c[0] + '=?').join(',')} WHERE id=?`).run(...use.map((c) => vals[cols.indexOf(c)]), req.params.id)); res.json({ ok: true }); }
      catch (e) { res.status(400).json({ error: /UNIQUE|Duplicate/.test(e.message) ? 'That name already exists.' : 'Could not save.' }); }
    });
    app.delete(`/api/admin/${name}/:id`, ...A, async (req, res) => { (await db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id)); res.json({ ok: true }); });
  };
  crud('categories', 'categories', [['name', 'text'], ['name_te', 'text'], ['icon', 'text'], ['sort', 'int'], ['active', 'bool']], { order: 'sort,id' });
  crud('cities', 'cities', [['name', 'text'], ['name_te', 'text'], ['state', 'text'], ['lat', 'real'], ['lng', 'real'], ['sort', 'int'], ['active', 'bool']], { order: 'sort,id' });
  crud('banners', 'ads', [['slot', 'text'], ['title', 'text'], ['image', 'text'], ['link', 'text'], ['active', 'bool']], { imageCol: 'image' });
  crud('messages', 'messages', [['status', 'text']], { create: false });
  app.get('/api/admin/reports', ...A, async (_req, res) => res.json((await db.prepare(`SELECT r.*, l.title AS listing_title FROM reports r LEFT JOIN listings l ON l.id=r.listing_id ORDER BY r.id DESC LIMIT 300`).all())));
  crud('reports', 'reports', [['status', 'text']], { create: false });

  // ---------- Pages (terms, privacy, contact...) ----------
  app.get('/api/admin/pages', ...A, async (_req, res) => res.json((await db.prepare('SELECT * FROM pages ORDER BY slug').all())));
  app.put('/api/admin/pages/:slug', ...A, async (req, res) => {
    const b = req.body;
    if (!clean(b.title) || !clean(b.body, 20000)) return res.status(400).json({ error: 'Title and text are required.' });
    (await db.prepare("UPDATE pages SET title=?,title_te=?,body=?,body_te=?,updated_at=NOW() WHERE slug=?").run(clean(b.title), clean(b.title_te), clean(b.body, 20000), clean(b.body_te, 20000), req.params.slug));
    res.json({ ok: true });
  });
  app.post('/api/admin/pages', ...A, async (req, res) => {
    const slug = clean(req.body.slug, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!slug || !clean(req.body.title) || !clean(req.body.body, 20000)) return res.status(400).json({ error: 'Slug, title and text are required.' });
    if ((await db.prepare('SELECT 1 FROM pages WHERE slug=?').get(slug))) return res.status(409).json({ error: 'That page already exists.' });
    (await db.prepare('INSERT INTO pages (slug,title,title_te,body,body_te) VALUES (?,?,?,?,?)').run(slug, clean(req.body.title), clean(req.body.title_te), clean(req.body.body, 20000), clean(req.body.body_te, 20000)));
    res.status(201).json({ slug });
  });
  app.delete('/api/admin/pages/:slug', ...A, async (req, res) => {
    if (['about', 'terms', 'privacy', 'refund', 'rules', 'contact'].includes(req.params.slug)) return res.status(400).json({ error: 'Core pages cannot be deleted. Edit them instead.' });
    (await db.prepare('DELETE FROM pages WHERE slug=?').run(req.params.slug)); res.json({ ok: true });
  });

  // ---------- Payments and calls (read, delete log rows) ----------
  app.get('/api/admin/payments', ...A, async (_req, res) => res.json((await db.prepare(
    "SELECT p.id,p.kind,p.order_id,p.payment_id,p.amount,p.status,p.created_at,p.meta FROM payments p ORDER BY p.id DESC LIMIT 300").all())
    .map((p) => { const m = JSON.parse(p.meta || '{}'); return { ...p, meta: undefined, detail: m.shopName || (m.listingId ? `Ad #${m.listingId}` : ''), email: m.email || '' }; })));
  app.get('/api/admin/calls', ...A, async (_req, res) => res.json((await db.prepare(
    `SELECT c.id,c.phone,c.status,c.note,c.created_at,l.title AS listing FROM calls c LEFT JOIN listings l ON l.id=c.product_id ORDER BY c.id DESC LIMIT 300`).all())
    .map((r) => ({ ...r, phone: r.phone.slice(0, 3) + '******' + r.phone.slice(-4) }))));
  app.delete('/api/admin/calls/:id', ...A, async (req, res) => { (await db.prepare('DELETE FROM calls WHERE id=?').run(req.params.id)); res.json({ ok: true }); });

  // ---------- Settings (AI provider, payments, Exotel, prices, site info) ----------
  const GROUPS = [
    { title: 'Site', fields: [['site_name', 'Site name'], ['support_email', 'Support email'], ['support_phone', 'Support phone'], ['address', 'Business address', 'textarea']] },
    { title: 'Pricing', fields: [['promo_active', 'Launch offer on Basic shop', 'select', [['yes', 'On'], ['no', 'Off']]], ['promo_shop_price', 'Launch offer price (Rs, minimum 1)', 'number'], ['promo_title', 'Offer label'], ['premium_price', 'Premium ad price (Rs)', 'number'], ['premium_days', 'Premium ad days', 'number'], ['plan_basic_price', 'Basic shop plan (Rs)', 'number'],
      ['plan_ai_price', 'AI shop plan (Rs)', 'number'], ['plan_store_price', 'Full store plan (Rs)', 'number'], ['max_ads_per_day', 'Max ads per user per day', 'number']] },
    { title: 'AI provider (whole site)', fields: [['ai_provider', 'Active AI', 'select', [['llama', 'Meta Llama'], ['gemini', 'Google Gemini'], ['anthropic', 'Claude (Anthropic)']]],
      ['llama_api_url', 'Llama API URL (OpenAI-compatible)'], ['llama_api_key', 'Llama API key', 'secret'], ['llama_model', 'Llama model'], ['llama_vision_model', 'Llama vision model (optional)'],
      ['gemini_api_key', 'Gemini API key', 'secret'], ['gemini_model', 'Gemini model'], ['anthropic_api_key', 'Claude API key', 'secret'], ['anthropic_model', 'Claude model']] },
    { title: 'Payments (Razorpay)', fields: [['razorpay_key_id', 'Key ID'], ['razorpay_key_secret', 'Key secret', 'secret']] },
    { title: 'AI phone calls (Exotel + Google speech)', fields: [['exotel_sid', 'Exotel account SID'], ['exotel_api_key', 'Exotel API key', 'secret'], ['exotel_api_token', 'Exotel API token', 'secret'],
      ['exotel_subdomain', 'Exotel API host (api.exotel.com or api.in.exotel.com)'], ['exotel_caller_id', 'ExoPhone (caller ID)'], ['exotel_flow_id', 'Voicebot flow (app) ID'],
      ['exotel_flow_url', 'Flow URL override (optional)'], ['google_cloud_key', 'Google Cloud API key (Speech-to-Text + Text-to-Speech)', 'secret'], ['tts_voice', 'Telugu voice'],
      ['calls_per_day_max', 'Max AI calls per day', 'number'], ['call_time_limit', 'Max seconds per call', 'number']] },
  ];
  app.get('/api/admin/settings', ...A, async (_req, res) => res.json({
    groups: GROUPS.map((g) => ({ title: g.title, fields: g.fields.map(([key, label, type = 'text', options]) => ({ key, label, type, options,
      value: type === 'secret' ? '' : getSetting(key), hasValue: type === 'secret' ? !!getSetting(key) : undefined })) })),
    voicebotUrl: `${siteUrl().replace(/^http/, 'ws')}/voice/ws?key=${wsKey()}`,
    exotelStatusUrl: `${siteUrl()}/api/voice/status?key=${wsKey()}`,
  }));
  app.put('/api/admin/settings', ...A, async (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!(k in DEFAULTS)) continue;
      if (SECRET_KEYS.has(k) && (v === '' || v === null)) continue;      // blank secret = keep the saved one
      await setSetting(k, clean(v, 500));
    }
    res.json({ ok: true });
  });
  app.get('/api/admin/ai-models', ...A, wrap(async (_req, res) => {
    try { res.json({ provider: aiProvider(), models: await aiListModels() }); } catch (e) { res.status(502).json({ error: e.message }); }
  }));
  app.post('/api/admin/ai-test', ...A, wrap(async (_req, res) => {
    if (!aiEnabled()) return res.status(400).json({ error: `No API key saved for ${aiProvider()}.` });
    try { const t = await aiChat({ messages: [{ role: 'user', content: 'Reply with the single word: OK' }], maxTokens: 20 }); res.json({ ok: true, provider: aiProvider(), model: aiStatus().model, reply: clean(t, 80) }); }
    catch (e) { res.status(502).json({ error: e.message }); }
  }));
}
