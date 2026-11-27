import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'crypto';
import { db, addMedia, removeMedia } from './db.js';
import { JWT_SECRET } from './config.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
export const normalizePhone = (raw) => {
  const m = String(raw || '').replace(/[\s-]/g, '').match(/^(?:\+91|91|0)?([6-9]\d{9})$/);
  return m ? `+91${m[1]}` : null;
};
export const limiter = (max, minutes = 15) => rateLimit({ windowMs: minutes * 60 * 1000, max, standardHeaders: true, legacyHeaders: false });
export const randomPassword = () => crypto.randomBytes(6).toString('base64url');
export const siteUrl = () => (process.env.SITE_URL || 'http://localhost:5173').replace(/\/$/, '');
export const isEmail = (s) => /^\S+@\S+\.\S+$/.test(s || '');

const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined })
  : null;
export async function sendMail(to, subject, text) {
  if (!mailer) return console.log(`--- EMAIL to ${to} (SMTP not configured) ---\n${subject}\n${text}\n---`);
  try { await mailer.sendMail({ from: process.env.MAIL_FROM || 'SellBuyAnywhere <no-reply@sellbuyanywhere.com>', to, subject, text }); }
  catch (e) { console.error('Mail failed:', e.message); }
}

// ---- Auth ----
const lookup = async (req) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const u = await db.prepare('SELECT id,email,role,status,name,phone FROM users WHERE id = ?').get(p.id);
    return u && u.status !== 'blocked' ? u : null;
  } catch { return null; }
};
export async function auth(req, res, next) {
  const u = await lookup(req);
  if (!u) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.user = u; next();
}
export async function optAuth(req, _res, next) { req.user = await lookup(req); next(); }
export const adminOnly = [auth, (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' }))];
export const signToken = (u) => jwt.sign({ id: u.id, email: u.email }, JWT_SECRET, { expiresIn: '30d' });

// ---- Uploads: kept in memory, then stored in MySQL (media table) so photos survive publishes ----
const imageOnly = (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: imageOnly });
export const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: imageOnly });
export async function saveImages(files) { const urls = []; for (const f of files) urls.push(await addMedia(f.mimetype, f.buffer)); return urls; }
export { removeMedia };

// Express 4 does not catch errors from async handlers; this wraps every handler so a failed database call returns a clean 500.
const wrapH = (h) => (req, res, next) => { try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } };
export const safeApp = (app) => new Proxy(app, { get(t, k) {
  if (['get', 'post', 'put', 'patch', 'delete'].includes(k)) return (path, ...hs) => t[k](path, ...hs.map(wrapH));
  const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
