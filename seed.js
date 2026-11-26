// Demo data: shops, individual sellers, ads (some Premium), banners and an admin login.
// Run: npm run seed      Start over: npm run seed -- --reset      Demo only, do not run on your live database.
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { db, UPLOADS_DIR } from './db.js';

if (process.argv.includes('--reset')) {
  db.exec('DELETE FROM listings; DELETE FROM shops; DELETE FROM users; DELETE FROM ads; DELETE FROM calls; DELETE FROM payments; DELETE FROM messages; DELETE FROM reports;');
  for (const f of fs.readdirSync(UPLOADS_DIR)) if (f.startsWith('seed-')) fs.unlinkSync(path.join(UPLOADS_DIR, f));
}
if (db.prepare("SELECT 1 FROM users WHERE email LIKE '%@demo.sellbuyanywhere.com'").get()) { console.log('Demo data already exists. Use `npm run seed -- --reset` to start over.'); process.exit(0); }

const PW = 'demo1234', ADMIN = ['admin@demo.sellbuyanywhere.com', 'admin1234'];
const LOOK = { Electronics: ['#dbeafe', '#1e3a8a', '📱'], Vehicles: ['#fee2e2', '#7f1d1d', '🚗'], Furniture: ['#fef3c7', '#78350f', '🛋️'], Fashion: ['#fce7f3', '#831843', '👗'],
  Jobs: ['#e0e7ff', '#312e81', '💼'], 'Real Estate': ['#dcfce7', '#14532d', '🏠'], Services: ['#ffedd5', '#7c2d12', '🔧'], Books: ['#f3e8ff', '#581c87', '📚'],
  Sports: ['#cffafe', '#164e63', '⚽'], Others: ['#e5e7eb', '#1f2937', '🎁'] };
const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let k = 0;
const write = (svg) => { const f = `seed-${++k}.svg`; fs.writeFileSync(path.join(UPLOADS_DIR, f), svg); return `/uploads/${f}`; };
const ICONS = [[/watch|smartwatch/i, '⌚'], [/strap/i, '⌚'], [/phone|redmi|galaxy|iphone/i, '📱'], [/charger|guard/i, '🔌'], [/saree|dupatta|kurta/i, '👘'], [/table|desk|chair/i, '🪑'], [/sofa/i, '🛋️'],
  [/activa|jupiter|splendor|enfield/i, '🏍️'], [/flat|apartment|room/i, '🏠'], [/ac service|clean|plumb/i, '🛠️'], [/book|novel/i, '📚'], [/bat|racket|yoga/i, '🏏'], [/speaker/i, '🔊'], [/hub/i, '🔌'], [/delivery|assistant|tutor/i, '💼']];
const picture = (t, c, view = 0) => { let [bg, fg, ic0] = LOOK[c] || LOOK.Others; if (view === 1) [bg, fg] = [fg, bg]; const label = ['', 'Side view', 'Close-up'][view] || t; const ic = (ICONS.find(([re]) => re.test(t)) || [0, ic0])[1];
  return write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/><text x="200" y="165" font-size="110" text-anchor="middle">${ic}</text><text x="200" y="258" font-size="21" font-family="sans-serif" font-weight="700" fill="${fg}" text-anchor="middle">${xml((label || t).slice(0, 30))}</text></svg>`); };
const gallery = (t, c, premium) => [picture(t, c, 0), picture(t, c, 1), ...(premium ? [picture(t, c, 2)] : [])];
const banner = (a, b, bg, fg) => write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180"><rect width="600" height="180" rx="12" fill="${bg}"/><text x="30" y="85" font-size="34" font-family="sans-serif" font-weight="800" fill="${fg}">${xml(a)}</text><text x="30" y="125" font-size="20" font-family="sans-serif" fill="${fg}" opacity=".85">${xml(b)}</text></svg>`);

// [title, description, price, category, premiumDays]
const shops = [
  ['ravi', 'Ravi', 'Ravi Watch House', 'Hyderabad', '9000000001', 'Abids Road', 'basic', 'Watches and straps since 1998.', [
    ['Titan Classique Analog Watch', 'Slim steel case, leather strap, 1 year warranty.', 3495, 'Fashion', 7], ['Casio F-91W Digital Watch', 'Classic digital watch with alarm and stopwatch.', 1295, 'Fashion'],
    ['Fastrack Smartwatch', 'Bluetooth calling, heart-rate and sleep tracking.', 1999, 'Electronics'], ['Leather Watch Strap 20mm', 'Genuine leather, fits most analog watches.', 399, 'Fashion']]],
  ['lakshmi', 'Lakshmi', 'Lakshmi Mobiles', 'Hyderabad', '9000000002', 'Koti', 'ai', 'New and refurbished phones with bill and warranty.', [
    ['Redmi Note 13 (8GB/128GB)', 'Sealed box, GST bill included.', 15999, 'Electronics', 7], ['Samsung Galaxy M14', '6GB/128GB, 6000 mAh battery, 1 year warranty.', 11499, 'Electronics'],
    ['20W Fast Charger', 'Type-C, BIS certified.', 499, 'Electronics'], ['Tempered Glass Screen Guard', 'Fits most Redmi and Samsung phones.', 149, 'Electronics']]],
  ['meena', 'Meena', 'Meena Handlooms', 'Hyderabad', '9000000003', 'Pochampally Road', 'basic', 'Handwoven ikat sarees and cotton wear.', [
    ['Pochampally Ikat Cotton Saree', 'Handwoven, 6.3 m with blouse piece.', 2800, 'Fashion', 7], ['Cotton Kurta Set', 'Block print, sizes M to XXL.', 1150, 'Fashion'], ['Handloom Dupatta', 'Soft cotton, natural dyes.', 650, 'Fashion']]],
  ['srinivas', 'Srinivas', 'Srinivas Furniture Mart', 'Vijayawada', '9000000007', 'Benz Circle', 'ai', 'Solid wood furniture made to order.', [
    ['Teak Wood 4-Seater Dining Table', 'Solid teak, polished finish, 4 chairs included.', 28500, 'Furniture'], ['3-Seater Fabric Sofa', 'Grey fabric, washable covers.', 17999, 'Furniture'], ['Study Table with Shelf', 'Engineered wood, walnut finish.', 4299, 'Furniture']]],
  ['harsha', 'Harsha', 'Harsha Pre-Owned Bikes', 'Visakhapatnam', '9000000008', 'Dwaraka Nagar', 'store', 'Single-owner two wheelers with papers.', [
    ['Honda Activa 6G (2021)', '18,000 km, single owner, papers clear.', 58000, 'Vehicles', 7], ['Royal Enfield Classic 350 (2019)', '32,000 km, new tyres, insurance valid.', 115000, 'Vehicles'], ['TVS Jupiter (2020)', '24,000 km, well maintained.', 49000, 'Vehicles']]],
  ['sai', 'Sai', 'Sai Realty', 'Hyderabad', '9000000009', 'Madhapur', 'ai', 'Rentals and sales across Hyderabad.', [
    ['2BHK Flat for Rent, Madhapur', 'Semi-furnished, 1100 sq ft, near metro.', 24000, 'Real Estate'], ['3BHK Apartment for Sale, Gachibowli', '1650 sq ft, gated community, 2 parking slots.', 9500000, 'Real Estate'], ['Single Room for Rent, Ameerpet', 'Attached bath, water included.', 7500, 'Real Estate']]],
  ['swathi', 'Swathi', 'Swathi Home Services', 'Guntur', '9000000010', 'Brodipet', 'basic', 'Trusted home repair and cleaning.', [
    ['AC Service and Gas Refill', 'Split or window AC, same-day visit.', 699, 'Services'], ['Home Deep Cleaning (2BHK)', 'Trained team, equipment included.', 3499, 'Services'], ['Plumber Visit', 'Leak and tap repairs, labour charge per visit.', 299, 'Services']]],
  ['kavitha', 'Kavitha', 'Kavitha Books and Stationery', 'Tirupati', '9000000005', 'Tilak Road', 'basic', 'School books, novels and sports goods.', [
    ['NCERT Class 10 Science', 'New, latest edition.', 150, 'Books'], ['Telugu Novel Collection (5 books)', 'Popular classics, good condition.', 600, 'Books'], ['Cricket Bat, English Willow', 'Full size, with grip and cover.', 3200, 'Sports']]],
  ['arun', 'Arun', 'Arun Electronics', 'Bengaluru', '9000000004', 'SP Road', 'store', 'Audio, accessories and gadgets.', [
    ['Bluetooth Speaker', '10 hour battery, water resistant.', 1799, 'Electronics'], ['Titan Edge Watch', 'Ultra-slim, sapphire glass.', 8995, 'Fashion'], ['USB-C Hub 6-in-1', 'HDMI, USB 3.0, SD card reader.', 1399, 'Electronics']]],
  ['careers', 'Careers Point', 'Careers Point Staffing', 'Warangal', '9000000011', 'Hanamkonda', 'basic', 'Jobs for freshers and experienced.', [
    ['Delivery Executive (monthly salary)', 'Own bike needed, fuel allowance, weekly payout.', 18000, 'Jobs'], ['Shop Assistant, Electronics Store', 'Freshers welcome, 6 days a week.', 15000, 'Jobs']]],
];
// Individual sellers: [email, name, phone, city, listings]
const people = [
  ['ramesh', 'Ramesh', '9000000020', 'Hyderabad', [['Hero Splendor Plus (2018)', 'Good condition, 41,000 km, second owner.', 38000, 'Vehicles', 7], ['Wooden Study Chair', 'Used for one year.', 1200, 'Furniture']]],
  ['anitha', 'Anitha', '9000000021', 'Vijayawada', [['Class 12 Maths and Physics Books', 'Complete set, neat.', 800, 'Books'], ['Badminton Racket Pair', 'Yonex, with cover.', 1500, 'Sports', 7]]],
  ['venkat', 'Venkat', '9000000022', 'Hyderabad', [['iPhone 12 (128GB)', 'Battery health 86%, box and charger included.', 29500, 'Electronics'], ['Home Tutor Needed, Class 8', 'Maths and science, evenings, Kukatpally.', 6000, 'Jobs']]],
];

db.transaction(() => {
  db.prepare("INSERT INTO users (email,password_hash,role,name) VALUES (?,?,'admin','Admin')").run(ADMIN[0], bcrypt.hashSync(ADMIN[1], 10));
  const hash = bcrypt.hashSync(PW, 10);
  const user = db.prepare("INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,'user',?,?)");
  const shop = db.prepare('INSERT INTO shops (user_id,name,city,phone,address,description,plan) VALUES (?,?,?,?,?,?,?)');
  const ad = db.prepare('INSERT INTO listings (user_id,shop_id,title,description,price,category,city,phone,image,images,featured_until) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const feat = (d) => (d ? db.prepare("SELECT datetime('now', '+' || ? || ' days') d").get(d).d : null);
  for (const [e, n, name, city, phone, addr, plan, desc, items] of shops) {
    const uid = user.run(`${e}@demo.sellbuyanywhere.com`, hash, n, phone).lastInsertRowid;
    const sid = shop.run(uid, name, city, phone, addr, desc, plan).lastInsertRowid;
    for (const [t, d, p, c, f] of items) { const g = gallery(t, c, f); ad.run(uid, sid, t, d, p, c, city, phone, g[0], JSON.stringify(g), feat(f)); }
  }
  for (const [e, n, phone, city, items] of people) {
    const uid = user.run(`${e}@demo.sellbuyanywhere.com`, hash, n, phone).lastInsertRowid;
    for (const [t, d, p, c, f] of items) { const g = gallery(t, c, f); ad.run(uid, null, t, d, p, c, city, phone, g[0], JSON.stringify(g), feat(f)); }
  }
  const b = db.prepare('INSERT INTO ads (slot,title,image,link) VALUES (?,?,?,?)');
  b.run('home-top', 'Open a shop for just Rs 1', banner('Open a shop for Rs 1', 'Launch offer: your shop page today', '#ede9fe', '#5b21b6'), '/open-shop');
  b.run('home-top', 'Open a shop and get your own page', banner('Add your shop', 'Get your page from Rs 100', '#fef3c7', '#78350f'), '/open-shop');
  b.run('home-top', 'Post a free ad in seconds', banner('Post a free ad', 'Premium ads show first', '#dbeafe', '#1e3a8a'), '/post');
  b.run('home-top', 'Festival offers on mobiles', banner('Festival mobile deals', 'Up to 20% off this week', '#fce7f3', '#831843'), '/search?q=mobile');
  b.run('search-top', 'Fast home services', banner('Home services', 'AC, cleaning, plumbing', '#dcfce7', '#14532d'), '/search?q=service');
  b.run('search-top', 'Advertise on SellBuyAnywhere', banner('Your ad here', 'Reach shoppers in your city', '#e0e7ff', '#312e81'), '/contact');
  b.run('search-top', 'Pre-owned bikes with papers', banner('Pre-owned bikes', 'Single owner, papers clear', '#fee2e2', '#7f1d1d'), '/search?q=bike');
  db.prepare('INSERT INTO messages (name,email,subject,message) VALUES (?,?,?,?)').run('Sample Visitor', 'visitor@example.com', 'Question about Premium ads', 'How long does a Premium ad stay on the homepage?');
  db.prepare('INSERT INTO reports (listing_id,reason) VALUES (1,?)').run('Sample report: price looks wrong');
})();
const c = db.prepare('SELECT (SELECT COUNT(*) FROM shops) s, (SELECT COUNT(*) FROM listings) l, (SELECT COUNT(*) FROM listings WHERE featured_until > datetime(\'now\')) p').get();
console.log(`Added ${c.s} shops, ${c.l} ads (${c.p} Premium), 6 banners.\nAdmin: ${ADMIN[0]} / ${ADMIN[1]}\nShop owners and sellers use password "${PW}", for example ravi@demo.sellbuyanywhere.com (shop) and ramesh@demo.sellbuyanywhere.com (individual).`);
