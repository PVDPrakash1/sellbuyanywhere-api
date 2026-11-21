// Adds demo shops, products (with generated pictures), ads and an admin login.
// Run: npm run seed        Start over: npm run seed -- --reset
// Demo data only. Do not run this against your live database.
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SCHEMA } from './schema.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(dir, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || UPLOADS_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'sba.db'));
db.exec(SCHEMA);
try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'owner'"); } catch { /* already there */ }

if (process.argv.includes('--reset')) {
  db.exec('DELETE FROM products; DELETE FROM shops; DELETE FROM users; DELETE FROM ads; DELETE FROM calls;');
  for (const f of fs.readdirSync(UPLOADS_DIR)) if (f.startsWith('seed-')) fs.unlinkSync(path.join(dir, 'uploads', f));
}
if (db.prepare("SELECT 1 FROM users WHERE email LIKE '%@demo.sellbuyanywhere.com'").get()) {
  console.log('Demo data already exists. Use `npm run seed -- --reset` to start over.');
  process.exit(0);
}

const PASSWORD = 'demo1234';
const ADMIN = { email: 'admin@demo.sellbuyanywhere.com', password: 'admin1234' };
const hash = bcrypt.hashSync(PASSWORD, 10);

// Category look: [background, text colour, icon]
const LOOK = {
  Electronics: ['#dbeafe', '#1e3a8a', '📱'], Vehicles: ['#fee2e2', '#7f1d1d', '🚗'], Furniture: ['#fef3c7', '#78350f', '🛋️'],
  Fashion: ['#fce7f3', '#831843', '👗'], Jobs: ['#e0e7ff', '#312e81', '💼'], 'Real Estate': ['#dcfce7', '#14532d', '🏠'],
  Services: ['#ffedd5', '#7c2d12', '🔧'], Books: ['#f3e8ff', '#581c87', '📚'], Sports: ['#cffafe', '#164e63', '⚽'], Others: ['#e5e7eb', '#1f2937', '🎁'],
};
const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let n = 0;
function picture(title, cat) {
  const [bg, fg, icon] = LOOK[cat] || LOOK.Others;
  const name = `seed-${++n}.svg`;
  fs.writeFileSync(path.join(dir, 'uploads', name),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${bg}"/>` +
    `<text x="200" y="165" font-size="110" text-anchor="middle">${icon}</text>` +
    `<text x="200" y="258" font-size="21" font-family="sans-serif" font-weight="700" fill="${fg}" text-anchor="middle">${xml(title.slice(0, 30))}</text></svg>`);
  return `/uploads/${name}`;
}
function banner(text, sub, bg, fg) {
  const name = `seed-${++n}.svg`;
  fs.writeFileSync(path.join(dir, 'uploads', name),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 180"><rect width="600" height="180" rx="12" fill="${bg}"/>` +
    `<text x="30" y="85" font-size="34" font-family="sans-serif" font-weight="800" fill="${fg}">${xml(text)}</text>` +
    `<text x="30" y="125" font-size="20" font-family="sans-serif" fill="${fg}" opacity=".85">${xml(sub)}</text></svg>`);
  return `/uploads/${name}`;
}

// Phone numbers are fake placeholders.
const shops = [
  { email: 'ravi', name: 'Ravi Watch House', city: 'Hyderabad', phone: '9000000001', address: 'Abids Road', plan: 'basic', products: [
    ['Titan Classique Analog Watch', 'Slim steel case, leather strap, 1 year warranty.', 3495, 'Fashion'],
    ['Casio F-91W Digital Watch', 'Classic digital watch with alarm and stopwatch.', 1295, 'Fashion'],
    ['Fastrack Smartwatch', 'Bluetooth calling, heart-rate and sleep tracking.', 1999, 'Electronics'],
    ['Leather Watch Strap 20mm', 'Genuine leather, fits most analog watches.', 399, 'Fashion'] ] },
  { email: 'lakshmi', name: 'Lakshmi Mobiles', city: 'Hyderabad', phone: '9000000002', address: 'Koti', plan: 'ai', products: [
    ['Redmi Note 13 (8GB/128GB)', 'Sealed box, GST bill included.', 15999, 'Electronics'],
    ['Samsung Galaxy M14', '6GB/128GB, 6000 mAh battery, 1 year warranty.', 11499, 'Electronics'],
    ['20W Fast Charger', 'Type-C, BIS certified.', 499, 'Electronics'],
    ['Tempered Glass Screen Guard', 'Fits most Redmi and Samsung phones.', 149, 'Electronics'] ] },
  { email: 'meena', name: 'Meena Handlooms', city: 'Hyderabad', phone: '9000000003', address: 'Pochampally Road', plan: 'basic', products: [
    ['Pochampally Ikat Cotton Saree', 'Handwoven, 6.3 m with blouse piece.', 2800, 'Fashion'],
    ['Cotton Kurta Set', 'Block print, sizes M to XXL.', 1150, 'Fashion'],
    ['Handloom Dupatta', 'Soft cotton, natural dyes.', 650, 'Fashion'] ] },
  { email: 'srinivas', name: 'Srinivas Furniture Mart', city: 'Hyderabad', phone: '9000000007', address: 'Kukatpally', plan: 'ai', products: [
    ['Teak Wood 4-Seater Dining Table', 'Solid teak, polished finish, 4 chairs included.', 28500, 'Furniture'],
    ['3-Seater Fabric Sofa', 'Grey fabric, washable covers.', 17999, 'Furniture'],
    ['Study Table with Shelf', 'Engineered wood, walnut finish.', 4299, 'Furniture'] ] },
  { email: 'harsha', name: 'Harsha Pre-Owned Bikes', city: 'Hyderabad', phone: '9000000008', address: 'Ameerpet', plan: 'store', products: [
    ['Honda Activa 6G (2021)', '18,000 km, single owner, papers clear.', 58000, 'Vehicles'],
    ['Royal Enfield Classic 350 (2019)', '32,000 km, new tyres, insurance valid.', 115000, 'Vehicles'],
    ['TVS Jupiter (2020)', '24,000 km, well maintained.', 49000, 'Vehicles'] ] },
  { email: 'sai', name: 'Sai Realty', city: 'Hyderabad', phone: '9000000009', address: 'Madhapur', plan: 'ai', products: [
    ['2BHK Flat for Rent, Madhapur', 'Semi-furnished, 1100 sq ft, near metro.', 24000, 'Real Estate'],
    ['3BHK Apartment for Sale, Gachibowli', '1650 sq ft, gated community, 2 parking slots.', 9500000, 'Real Estate'],
    ['Single Room for Rent, Ameerpet', 'Attached bath, water included.', 7500, 'Real Estate'] ] },
  { email: 'swathi', name: 'Swathi Home Services', city: 'Hyderabad', phone: '9000000010', address: 'Kondapur', plan: 'basic', products: [
    ['AC Service and Gas Refill', 'Split or window AC, same-day visit.', 699, 'Services'],
    ['Home Deep Cleaning (2BHK)', 'Trained team, equipment included.', 3499, 'Services'],
    ['Plumber Visit', 'Leak and tap repairs, labour charge per visit.', 299, 'Services'] ] },
  { email: 'arun', name: 'Arun Electronics', city: 'Bengaluru', phone: '9000000004', address: 'SP Road', plan: 'store', products: [
    ['Bluetooth Speaker', '10 hour battery, water resistant.', 1799, 'Electronics'],
    ['Titan Edge Watch', 'Ultra-slim, sapphire glass.', 8995, 'Fashion'],
    ['USB-C Hub 6-in-1', 'HDMI, USB 3.0, SD card reader.', 1399, 'Electronics'] ] },
  { email: 'kavitha', name: 'Kavitha Books and Stationery', city: 'Chennai', phone: '9000000005', address: 'T Nagar', plan: 'basic', products: [
    ['NCERT Class 10 Science', 'New, latest edition.', 150, 'Books'],
    ['Telugu Novel Collection (5 books)', 'Popular classics, good condition.', 600, 'Books'],
    ['Cricket Bat, English Willow', 'Full size, with grip and cover.', 3200, 'Sports'] ] },
  { email: 'imran', name: 'Imran Home Needs', city: 'Mumbai', phone: '9000000006', address: 'Crawford Market', plan: 'ai', products: [
    ['Stainless Steel Lunch Box', '3 containers with bag.', 699, 'Others'],
    ['Table Fan 400mm', '3 speed, 2 year warranty.', 1899, 'Electronics'],
    ['Yoga Mat 6mm', 'Non-slip, with carry strap.', 549, 'Sports'] ] },
  { email: 'careers', name: 'Careers Point Staffing', city: 'Hyderabad', phone: '9000000011', address: 'Secunderabad', plan: 'basic', products: [
    ['Delivery Executive (monthly salary)', 'Own bike needed, fuel allowance, weekly payout.', 18000, 'Jobs'],
    ['Shop Assistant, Electronics Store', 'Freshers welcome, 6 days a week.', 15000, 'Jobs'] ] },
];

const insUser = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?,?,?)');
const insShop = db.prepare('INSERT INTO shops (user_id, name, city, phone, address, plan) VALUES (?,?,?,?,?,?)');
const insProd = db.prepare('INSERT INTO products (shop_id, title, description, price, category, city, image) VALUES (?,?,?,?,?,?,?)');
const insAd = db.prepare('INSERT INTO ads (slot, title, image, link) VALUES (?,?,?,?)');

let products = 0;
db.transaction(() => {
  insUser.run(ADMIN.email, bcrypt.hashSync(ADMIN.password, 10), 'admin');
  for (const s of shops) {
    s.email = `${s.email}@demo.sellbuyanywhere.com`;
    const uid = insUser.run(s.email, hash, 'owner').lastInsertRowid;
    const sid = insShop.run(uid, s.name, s.city, s.phone, s.address, s.plan).lastInsertRowid;
    for (const [t, d, p, c] of s.products) { insProd.run(sid, t, d, p, c, s.city, picture(t, c)); products++; }
  }
  insAd.run('home-top', 'Open a shop and get your own page', banner('Add your shop', 'Get your website today', '#fef3c7', '#78350f'), 'https://sellbuyanywhere.com/open-shop');
  insAd.run('home-top', 'Sell more with the AI shop plan', banner('AI shop plan', 'Chat and recommendations for buyers', '#dbeafe', '#1e3a8a'), 'https://sellbuyanywhere.com/open-shop');
  insAd.run('home-top', 'Festival offers on mobiles', banner('Festival mobile deals', 'Up to 20% off this week', '#fce7f3', '#831843'), 'https://sellbuyanywhere.com');
  insAd.run('search-top', 'Fast home services in Hyderabad', banner('Home services', 'AC, cleaning, plumbing', '#dcfce7', '#14532d'), 'https://sellbuyanywhere.com');
  insAd.run('search-top', 'Advertise on SellBuyAnywhere', banner('Your ad here', 'Reach shoppers in your city', '#e0e7ff', '#312e81'), 'https://sellbuyanywhere.com');
  insAd.run('search-top', 'Pre-owned bikes with papers', banner('Pre-owned bikes', 'Single owner, papers clear', '#fee2e2', '#7f1d1d'), 'https://sellbuyanywhere.com');
})();

console.log(`Added ${shops.length} shops, ${products} products and 6 ads.`);
console.log(`Admin login:  ${ADMIN.email} / ${ADMIN.password}`);
console.log(`Shop owners (password "${PASSWORD}"):`);
shops.forEach((s) => console.log('  ' + s.email));
