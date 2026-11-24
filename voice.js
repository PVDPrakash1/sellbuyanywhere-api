// "Call shop": the buyer enters their number and a Telugu AI voice assistant phones them.
// Telephony: Exotel (outbound call API + Voicebot applet WebSocket, 16-bit 8 kHz mono PCM).
// Speech: Google Cloud Speech-to-Text and Text-to-Speech (te-IN). Replies: the AI provider chosen in Admin > Settings.
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { db, getSetting, wsKey } from './db.js';
import { aiChat, aiEnabled } from './ai.js';
import { clean, normalizePhone, limiter, wrap, siteUrl } from './util.js';

const STT_URL = process.env.GOOGLE_STT_URL || 'https://speech.googleapis.com/v1/speech:recognize';
const TTS_URL = process.env.GOOGLE_TTS_URL || 'https://texttospeech.googleapis.com/v1/text:synthesize';
const FRAME = 3200;                                   // bytes per outgoing chunk (200 ms), a multiple of 320 as Exotel requires
const spoken = (d) => String(d).replace(/\D/g, '').split('').join(' ');
const ready = () => ['exotel_sid', 'exotel_api_key', 'exotel_api_token', 'exotel_caller_id'].every((k) => getSetting(k)) && (getSetting('exotel_flow_id') || getSetting('exotel_flow_url')) && siteUrl().startsWith('https://');
const keyOk = (k) => { const a = Buffer.from(String(k || '')), b = Buffer.from(wsKey()); return a.length === b.length && crypto.timingSafeEqual(a, b); };

const infoFor = (callId) => db.prepare(`SELECT l.title,l.price,l.category,l.description,l.city,COALESCE(NULLIF(l.phone,''),s.phone) AS phone,s.name AS shop,s.address
  FROM calls c JOIN listings l ON l.id=c.product_id LEFT JOIN shops s ON s.id=l.shop_id WHERE c.id=?`).get(callId);

export function registerVoice(app) {
  app.post('/api/calls', limiter(10), wrap(async (req, res) => {
    if (!ready()) return res.status(503).json({ error: 'AI calling is not set up yet.' });
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a 10-digit Indian mobile number.' });
    if (!req.body.consent) return res.status(400).json({ error: 'Tick the box to agree to receive the call.' });
    const l = db.prepare("SELECT id,shop_id FROM listings WHERE id=? AND status='active'").get(Number(req.body.listingId || req.body.productId));
    if (!l) return res.status(404).json({ error: 'This ad is no longer available.' });
    const day = "created_at >= datetime('now','-1 day')";
    if (db.prepare(`SELECT COUNT(*) n FROM calls WHERE phone=? AND ${day}`).get(phone).n >= 3) return res.status(429).json({ error: 'You have reached today’s limit of 3 calls. Try again tomorrow.' });
    if (db.prepare(`SELECT COUNT(*) n FROM calls WHERE ${day}`).get().n >= Number(getSetting('calls_per_day_max') || 200)) return res.status(429).json({ error: 'Calls are busy right now. Try again later.' });

    const id = db.prepare("INSERT INTO calls (product_id,shop_id,phone,status) VALUES (?,?,?, 'queued')").run(l.id, l.shop_id, phone).lastInsertRowid;
    try {
      const sid = getSetting('exotel_sid');
      const flow = getSetting('exotel_flow_url') || `http://my.exotel.com/${sid}/exoml/start_voice/${getSetting('exotel_flow_id')}`;
      const body = new URLSearchParams({ From: phone, CallerId: getSetting('exotel_caller_id'), Url: flow, CallType: 'trans',
        TimeLimit: String(Number(getSetting('call_time_limit')) || 180), CustomField: String(id),
        StatusCallback: `${siteUrl()}/api/voice/status?callId=${id}&key=${wsKey()}` });
      const r = await fetch(`https://${getSetting('exotel_subdomain') || 'api.exotel.com'}/v1/Accounts/${sid}/Calls/connect.json`, {
        method: 'POST', body, signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Basic ' + Buffer.from(`${getSetting('exotel_api_key')}:${getSetting('exotel_api_token')}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.RestException?.Message || j.message || `Exotel error ${r.status}`);
      db.prepare("UPDATE calls SET status='calling', call_sid=? WHERE id=?").run(j.Call?.Sid || j.call?.sid || null, id);
      res.json({ ok: true, phone });
    } catch (e) {
      console.error('Call failed:', e.message);
      db.prepare("UPDATE calls SET status='failed', note=? WHERE id=?").run(String(e.message).slice(0, 200), id);
      res.status(502).json({ error: 'We could not place the call. Check the number and try again.' });
    }
  }));

  app.post('/api/voice/status', (req, res) => {
    if (!keyOk(req.query.key)) return res.status(403).end();
    const raw = String(req.body.Status || req.body.CallStatus || '').toLowerCase();
    const s = { completed: 'completed', busy: 'busy', 'no-answer': 'no-answer', failed: 'failed', canceled: 'canceled', 'in-progress': 'answered' }[raw];
    if (s) db.prepare('UPDATE calls SET status=? WHERE id=?').run(s, Number(req.query.callId));
    res.end();
  });
}

// ---- Speech helpers ----
async function stt(pcm) {
  const r = await fetch(`${STT_URL}?key=${getSetting('google_cloud_key')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 8000, languageCode: 'te-IN', alternativeLanguageCodes: ['en-IN', 'hi-IN'], enableAutomaticPunctuation: true }, audio: { content: pcm.toString('base64') } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('STT ' + r.status);
  return clean((j.results || []).map((x) => x.alternatives?.[0]?.transcript || '').join(' '), 500);
}
async function tts(text) {
  const r = await fetch(`${TTS_URL}?key=${getSetting('google_cloud_key')}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
    body: JSON.stringify({ input: { text }, voice: { languageCode: 'te-IN', name: getSetting('tts_voice') || 'te-IN-Standard-A' }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 8000 } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.audioContent) throw new Error('TTS ' + r.status);
  const wav = Buffer.from(j.audioContent, 'base64');
  const at = wav.indexOf('data');
  let pcm = at > 0 ? wav.subarray(at + 8) : wav;
  if (pcm.length % 320) pcm = Buffer.concat([pcm, Buffer.alloc(320 - (pcm.length % 320))]);
  return pcm;
}
const rms = (b) => { let s = 0; const n = b.length >> 1; for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2); s += v * v; } return Math.sqrt(s / Math.max(n, 1)); };

export function attachVoiceSocket(server) {
  const wss = new WebSocketServer({ server, path: '/voice/ws' });
  wss.on('connection', (ws, req) => {
    if (!keyOk(new URL(req.url, 'http://x').searchParams.get('key'))) return ws.close();
    const st = { sid: null, info: null, system: '', history: [], pcm: [], pre: [], speech: false, voicedMs: 0, silentMs: 0, noise: 300, busy: false,
      sending: false, speakingUntil: 0, barge: 0, last: Date.now(), ended: false, timer: null };
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    const speaking = () => st.sending || Date.now() < st.speakingUntil;

    function stopSpeaking() { st.sending = false; st.speakingUntil = 0; clearInterval(st.timer); send({ event: 'clear', stream_sid: st.sid }); }
    async function say(text) {
      let pcm;
      try { pcm = await tts(text); } catch (e) { return console.error(e.message); }
      if (st.ended) return;
      st.sending = true;
      const t0 = Date.now();
      await new Promise((resolve) => {
        let off = 0;
        st.timer = setInterval(() => {
          if (!st.sending || off >= pcm.length || ws.readyState !== 1) { clearInterval(st.timer); resolve(); return; }
          send({ event: 'media', stream_sid: st.sid, media: { payload: pcm.subarray(off, off + FRAME).toString('base64') } });
          off += FRAME;
        }, 100);
      });
      if (st.sending) { st.speakingUntil = t0 + pcm.length / 16 + 200; st.sending = false; }   // 16 bytes per ms at 8 kHz, 16-bit
      st.last = Date.now();
    }
    async function turn(pcm) {
      if (st.busy) return;
      st.busy = true;
      try {
        const text = await stt(pcm);
        if (!text) { await say('క్షమించండి, నాకు వినిపించలేదు. దయచేసి మళ్ళీ చెప్పండి.'); return; }
        st.history.push({ role: 'user', content: text });
        let reply = null;
        try { reply = await aiChat({ system: st.system, messages: st.history.slice(-10), maxTokens: 200 }); } catch (e) { console.error(e.message); }
        if (!reply) reply = `క్షమించండి, ఇప్పుడు నేను ఎక్కువ వివరాలు చెప్పలేను. దయచేసి అమ్మకందారుని ఈ నంబర్‌కు సంప్రదించండి: ${spoken(st.info.phone)}.`;
        reply = clean(reply, 600);
        st.history.push({ role: 'assistant', content: reply });
        await say(reply);
      } catch (e) { console.error('Voice turn failed:', e.message); }
      finally { st.busy = false; st.last = Date.now(); }
    }
    function endUtterance() {
      const pcm = Buffer.concat(st.pcm);
      st.pcm = []; st.pre = []; st.speech = false; st.voicedMs = 0; st.silentMs = 0;
      if (pcm.length >= 6400) turn(pcm);                 // ignore clicks and noise shorter than 0.4 s
    }
    function onMedia(buf) {
      const e = rms(buf), ms = buf.length / 16, thr = Math.max(500, st.noise * 3);
      if (speaking()) {                                  // barge-in: caller talks over the assistant
        st.barge = e > thr * 1.6 ? st.barge + 1 : 0;
        if (st.barge >= 3) { stopSpeaking(); st.barge = 0; st.speech = true; st.pcm = [...st.pre, buf]; st.silentMs = 0; }
        return;
      }
      if (e > thr) {
        st.voicedMs += ms; st.silentMs = 0;
        if (!st.speech && st.voicedMs >= 200) { st.speech = true; st.pcm = [...st.pre]; }
        if (st.speech) st.pcm.push(buf); else st.pre.push(buf);
      } else if (!st.speech) { st.noise = st.noise * 0.95 + e * 0.05; st.voicedMs = 0; st.pre = [...st.pre, buf].slice(-3); }
      else { st.pcm.push(buf); st.silentMs += ms; if (st.silentMs >= 900) endUtterance(); }
      if (st.speech && st.pcm.length * (buf.length / 16) > 15000) endUtterance();
    }

    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.event === 'start') {
        st.sid = m.stream_sid || m.start?.stream_sid;
        const sid = m.start?.call_sid || m.call_sid;
        const cp = String(m.start?.custom_parameters || m.start?.customParameters || '');
        let row = sid && db.prepare('SELECT id FROM calls WHERE call_sid=?').get(sid);
        if (!row && /(\d+)/.test(cp)) row = db.prepare('SELECT id FROM calls WHERE id=?').get(Number(cp.match(/(\d+)/)[1]));
        if (!row) { const c = db.prepare("SELECT id FROM calls WHERE status='calling' AND created_at >= datetime('now','-3 minutes')").all(); if (c.length === 1) row = c[0]; }
        st.info = row && infoFor(row.id);
        if (!st.info) return ws.close();
        const i = st.info;
        st.system = 'You are the AI voice assistant of SellBuyAnywhere, an Indian marketplace, on a phone call with a buyer. Always reply in Telugu using Telugu script; product and shop names may stay in English. ' +
          'Be warm and brief: at most two short sentences, no lists, no markdown, no emojis. You are an AI; say so if asked. Use only these facts. ' +
          `Item: ${i.title}. Price: ${i.price} rupees. Category: ${i.category}. Description: ${i.description || 'none given'}. Seller: ${i.shop || 'private seller'}, ${i.address || ''} ${i.city}. Seller phone: ${spoken(i.phone)}. ` +
          'If asked about stock, discounts, delivery, condition or warranty, say you do not know and suggest asking the seller on the phone number. Never promise anything for the seller. Never ask for card numbers, OTPs or passwords.';
        const who = i.shop ? `${i.shop} షాపులో` : 'అమ్మకందారుని వద్ద';
        // Review this greeting with a native Telugu speaker.
        say(`నమస్కారం! నేను సెల్ బై ఎనీవేర్ ఏఐ అసిస్టెంట్‌ని. మీరు చూసిన ${i.title} గురించి సహాయం చేస్తాను. ఇది ${who} ${i.price} రూపాయలకు ఉంది. మీకు ఏమి తెలుసుకోవాలి?`);
        st.idle = setInterval(async () => {
          if (st.busy || speaking() || Date.now() - st.last < 25000) return;
          clearInterval(st.idle);
          await say('ధన్యవాదాలు! మరొక్కసారి కలుద్దాం. నమస్కారం.');
          ws.close();
        }, 5000);
      } else if (m.event === 'media' && st.info && m.media?.payload) onMedia(Buffer.from(m.media.payload, 'base64'));
      else if (m.event === 'stop') ws.close();
    });
    ws.on('close', () => { st.ended = true; clearInterval(st.timer); clearInterval(st.idle); });
  });
}
export const voiceReady = ready;
