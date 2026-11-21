// Admin API: stats, shops, products, ads, call log. All routes need an admin login.
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export const AD_SLOTS = ['home-top', 'search-top'];

export function registerAdmin(app, { db, auth, clean, upload, PLANS }) {
  const admin = [
    auth,
    (req, res, next) => {
      const u = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
      u?.role === 'admin' ? next() : res.status(403).json({ error: 'This area is for admins only.' });
    },
  ];
  const count = (sql) => db.prepare(sql).get().n;

  app.get('/api/admin/stats', ...admin, (_req, res) => res.json({
    owners: count("SELECT COUNT(*) n FROM users WHERE role != 'admin'"),
    shops: count('SELECT COUNT(*) n FROM shops'),
    products: count('SELECT COUNT(*) n FROM products'),
    activeAds: count('SELECT COUNT(*) n FROM ads WHERE active = 1'),
    calls: count('SELECT COUNT(*) n FROM calls'),
    callsToday: count("SELECT COUNT(*) n FROM calls WHERE created_at >= datetime('now','-1 day')"),
  }));

  // Shops
  app.get('/api/admin/shops', ...admin, (_req, res) => res.json(db.prepare(`
    SELECT s.*, u.email AS owner_email, (SELECT COUNT(*) FROM products WHERE shop_id = s.id) AS products
    FROM shops s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC`).all()));

  app.post('/api/admin/shops', ...admin, (req, res) => {
    const b = req.body;
    const email = clean(b.ownerEmail, 120).toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || !clean(b.shopName) || !clean(b.city) || clean(b.phone, 20).length < 8 || !PLANS[b.plan])
      return res.status(400).json({ error: 'Owner email, shop name, city, phone and plan are required.' });
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    let password = null;
    if (!user) {
      password = crypto.randomBytes(6).toString('base64url');
      user = { id: db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?,?, 'owner')")
        .run(email, bcrypt.hashSync(password, 10)).lastInsertRowid };
    }
    const id = db.prepare('INSERT INTO shops (user_id, name, city, phone, address, plan) VALUES (?,?,?,?,?,?)')
      .run(user.id, clean(b.shopName), clean(b.city, 60), clean(b.phone, 20), clean(b.address, 300), b.plan).lastInsertRowid;
    res.status(201).json({ id, email, password });
  });

  app.delete('/api/admin/shops/:id', ...admin, (req, res) => {
    db.transaction(() => {
      db.prepare('DELETE FROM products WHERE shop_id = ?').run(req.params.id);
      db.prepare('DELETE FROM shops WHERE id = ?').run(req.params.id);
    })();
    res.json({ ok: true });
  });

  // Products
  app.get('/api/admin/products', ...admin, (_req, res) => res.json(db.prepare(`
    SELECT p.id, p.title, p.price, p.category, p.city, p.created_at, s.name AS shop_name
    FROM products p JOIN shops s ON s.id = p.shop_id ORDER BY p.id DESC LIMIT 300`).all()));

  app.delete('/api/admin/products/:id', ...admin, (req, res) => {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Ads
  app.get('/api/admin/ads', ...admin, (_req, res) => res.json(db.prepare('SELECT * FROM ads ORDER BY id DESC').all()));

  app.post('/api/admin/ads', ...admin, upload.single('image'), (req, res) => {
    const { slot, title, link } = req.body;
    if (!AD_SLOTS.includes(slot) || !clean(title) || !/^https?:\/\//.test(link || ''))
      return res.status(400).json({ error: 'Choose a slot, add a title and a link that starts with http:// or https://.' });
    const id = db.prepare('INSERT INTO ads (slot, title, image, link) VALUES (?,?,?,?)')
      .run(slot, clean(title, 120), req.file ? `/uploads/${req.file.filename}` : '', link).lastInsertRowid;
    res.status(201).json({ id });
  });

  app.patch('/api/admin/ads/:id', ...admin, (req, res) => {
    db.prepare('UPDATE ads SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
    res.json({ ok: true });
  });

  app.delete('/api/admin/ads/:id', ...admin, (req, res) => {
    db.prepare('DELETE FROM ads WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Call log (phone numbers are masked)
  app.get('/api/admin/calls', ...admin, (_req, res) => {
    const rows = db.prepare(`SELECT c.id, c.phone, c.status, c.note, c.created_at, p.title AS product, s.name AS shop
      FROM calls c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN shops s ON s.id = c.shop_id
      ORDER BY c.id DESC LIMIT 200`).all();
    res.json(rows.map((r) => ({ ...r, phone: r.phone.slice(0, 3) + '******' + r.phone.slice(-4) })));
  });
}
