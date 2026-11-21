// "Call shop": the buyer enters their number and a Telugu AI voice assistant phones them.
// Uses Twilio Programmable Voice + ConversationRelay (speech-to-text and text-to-speech in te-IN),
// with Meta Llama writing the replies over a WebSocket.
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export const normalizePhone = (raw) => {
  const m = String(raw || '').replace(/[\s-]/g, '').match(/^(?:\+91|91|0)?([6-9]\d{9})$/);
  return m ? `+91${m[1]}` : null;
};
const spoken = (digits) => String(digits).replace(/\D/g, '').split('').join(' ');
const productFor = (db, callId) => db.prepare(`
  SELECT p.title, p.price, p.category, p.description, s.name AS shop, s.address, s.city, s.phone AS shop_phone
  FROM calls c JOIN products p ON p.id = c.product_id JOIN shops s ON s.id = c.shop_id WHERE c.id = ?`).get(callId);

export function registerCalls(app, { db, env, wrap, limiter }) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const configured = () => env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && site.startsWith('https://');

  app.post('/api/calls', limiter(10), wrap(async (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'Calling is not set up yet.' });
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a 10-digit Indian mobile number.' });
    if (!req.body.consent) return res.status(400).json({ error: 'Tick the box to agree to receive the call.' });
    const p = db.prepare('SELECT id, shop_id FROM products WHERE id = ?').get(Number(req.body.productId));
    if (!p) return res.status(404).json({ error: 'This listing is no longer available.' });

    const day = "created_at >= datetime('now','-1 day')";
    if (db.prepare(`SELECT COUNT(*) n FROM calls WHERE phone = ? AND ${day}`).get(phone).n >= 3)
      return res.status(429).json({ error: 'You have reached today’s limit of 3 calls. Try again tomorrow.' });
    if (db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${day}`).get().n >= Number(env.CALLS_PER_DAY_MAX || 200))
      return res.status(429).json({ error: 'Calls are busy right now. Try again later.' });

    const id = db.prepare("INSERT INTO calls (product_id, shop_id, phone, status) VALUES (?,?,?, 'queued')")
      .run(p.id, p.shop_id, phone).lastInsertRowid;
    try {
      const body = new URLSearchParams({
        To: phone, From: env.TWILIO_FROM, Method: 'POST', Timeout: '30', TimeLimit: '300',
        Url: `${site}/api/voice/twiml?callId=${id}`,
        StatusCallback: `${site}/api/voice/status?callId=${id}`, StatusCallbackMethod: 'POST',
      });
      body.append('StatusCallbackEvent', 'answered');
      body.append('StatusCallbackEvent', 'completed');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || `Twilio error ${r.status}`);
      db.prepare("UPDATE calls SET status = 'calling', call_sid = ? WHERE id = ?").run(j.sid, id);
      res.json({ ok: true, phone });
    } catch (e) {
      console.error('Call failed:', e.message);
      db.prepare("UPDATE calls SET status = 'failed', note = ? WHERE id = ?").run(e.message.slice(0, 200), id);
      res.status(502).json({ error: 'We could not place the call. Check the number and try again.' });
    }
  }));

  // Twilio signs every webhook; reject anything that is not from Twilio.
  const fromTwilio = (req) => {
    const sig = req.headers['x-twilio-signature'];
    if (!sig || !env.TWILIO_AUTH_TOKEN) return false;
    const data = site + req.originalUrl + Object.keys(req.body || {}).sort().map((k) => k + req.body[k]).join('');
    const exp = crypto.createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(data).digest('base64');
    return exp.length === sig.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(sig));
  };

  app.post('/api/voice/twiml', (req, res) => {
    if (!fromTwilio(req)) return res.status(403).end();
    const callId = Number(req.query.callId);
    const p = productFor(db, callId);
    if (!p) return res.status(404).end();
    const token = jwt.sign({ callId }, env.JWT_SECRET || 'dev-secret-change-me', { expiresIn: '20m' });
    const wsUrl = site.replace(/^http/, 'ws') + '/voice/ws';
    // Review this greeting with a native Telugu speaker before launch.
    const greeting = `నమస్కారం! నేను సెల్ బై ఎనీవేర్ ఏఐ అసిస్టెంట్‌ని. మీరు చూసిన ${p.title} గురించి సహాయం చేస్తాను. ` +
      `ఇది ${p.shop} షాపులో ${p.price} రూపాయలకు ఉంది. మీకు ఏమి తెలుసుకోవాలి?`;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Connect>
<ConversationRelay url="${esc(wsUrl)}" language="te-IN" ttsProvider="Google" voice="te-IN-Standard-A" transcriptionProvider="Google" interruptible="speech" welcomeGreeting="${esc(greeting)}">
<Parameter name="token" value="${esc(token)}"/>
</ConversationRelay>
</Connect></Response>`);
  });

  app.post('/api/voice/status', (req, res) => {
    if (!fromTwilio(req)) return res.status(403).end();
    const s = { answered: 'answered', completed: 'completed', busy: 'busy', 'no-answer': 'no-answer', failed: 'failed', canceled: 'canceled' }[req.body.CallStatus];
    if (s) db.prepare('UPDATE calls SET status = ? WHERE id = ?').run(s, Number(req.query.callId));
    res.end();
  });
}

export function attachVoiceSocket(server, { db, env, askLlama }) {
  const wss = new WebSocketServer({ server, path: '/voice/ws' });
  wss.on('connection', (ws) => {
    let product = null;
    let system = '';
    const history = [];

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (m.type === 'setup') {
        try {
          const { callId } = jwt.verify(m.customParameters?.token || '', env.JWT_SECRET || 'dev-secret-change-me');
          product = productFor(db, callId);
        } catch { /* fall through */ }
        if (!product) return ws.close();
        system =
          'You are the AI voice assistant of SellBuyAnywhere, an Indian marketplace, on a phone call with a buyer. ' +
          'Always reply in Telugu using Telugu script; product and shop names may stay in English. ' +
          'Be warm and brief: at most two short sentences, no lists, no markdown, no emojis. ' +
          'You are an AI; say so if asked. Use only these facts. ' +
          `Product: ${product.title}. Price: ${product.price} rupees. Category: ${product.category}. ` +
          `Description: ${product.description || 'none given'}. Shop: ${product.shop}, ${product.address || ''} ${product.city}. ` +
          `Shop phone: ${spoken(product.shop_phone)}. ` +
          'If asked about stock, discounts, delivery or warranty, say you do not know and suggest asking the shop on its phone number. ' +
          'Never promise anything for the shop. Never ask for card numbers, OTPs or passwords.';
        return;
      }
      if (!product) return;

      if (m.type === 'prompt' && m.voicePrompt) {
        history.push({ role: 'user', content: m.voicePrompt });
        let reply = null;
        try { reply = await askLlama([{ role: 'system', content: system }, ...history.slice(-12)]); } catch (e) { console.error(e.message); }
        if (!reply) reply = `క్షమించండి, ఇప్పుడు నేను ఎక్కువ వివరాలు చెప్పలేను. దయచేసి షాపును ఈ నంబర్‌కు సంప్రదించండి: ${spoken(product.shop_phone)}.`;
        history.push({ role: 'assistant', content: reply });
        ws.send(JSON.stringify({ type: 'text', token: reply, last: true }));
      }
    });
  });
}
