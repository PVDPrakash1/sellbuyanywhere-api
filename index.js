import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db, UPLOADS_DIR } from './db.js';
import { registerRoutes } from './routes.js';
import { registerAdmin } from './admin.js';
import { registerVoice, attachVoiceSocket } from './voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4000;

// Admin login from the environment (created or updated every start)
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const h = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), e = process.env.ADMIN_EMAIL.toLowerCase();
  const ex = db.prepare('SELECT id FROM users WHERE email=?').get(e);
  if (ex) db.prepare("UPDATE users SET role='admin', status='active', password_hash=? WHERE id=?").run(h, ex.id);
  else db.prepare("INSERT INTO users (email,password_hash,role,name) VALUES (?,?,'admin','Admin')").run(e, h);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true }));

registerRoutes(app);
registerAdmin(app);
registerVoice(app);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

// Built React site: CLIENT_DIST, ./public, ./client/dist or ../client/dist
const dist = [process.env.CLIENT_DIST, path.join(__dirname, 'public'), path.join(__dirname, 'client/dist'), path.join(__dirname, '../client/dist')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'index.html')));
if (dist) {
  console.log('Serving website from', dist);
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  console.warn('Website build not found. Copy client/dist to server/public.');
  app.get('/', (_req, res) => res.type('text').send('SellBuyAnywhere API is running. The website build was not found: copy client/dist into server/public and redeploy.'));
}
app.use((err, _req, res, _next) => {
  if (err.status !== 503) console.error(err);
  res.status(err.status || 500).json({ error: err.status === 503 ? err.message : err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large.' : 'Something went wrong on our side. Try again.' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`SellBuyAnywhere running on http://localhost:${PORT}`));
attachVoiceSocket(server);
