// One AI layer for the whole site. Admin picks the provider (Meta Llama, Google Gemini or Claude) in Admin > Settings.
import { db, getSetting } from './db.js';
import { clean } from './util.js';

const KEY_OF = { llama: 'llama_api_key', gemini: 'gemini_api_key', anthropic: 'anthropic_api_key' };
export const aiProvider = () => (KEY_OF[getSetting('ai_provider')] ? getSetting('ai_provider') : 'llama');
export const aiEnabled = () => !!getSetting(KEY_OF[aiProvider()]);

async function post(url, headers, body) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error(`Could not reach the AI service (${e.cause?.code || e.message}).`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AI ${r.status}: ${String(j.error?.message || j.message || j.error || '').slice(0, 160)}`);
  return j;
}

// messages: [{role:'user'|'assistant', content}], image: {mime, base64} attaches to the last user message
export async function aiChat({ system = '', messages, image = null, maxTokens = 700, temperature = 0.3 }) {
  if (!aiEnabled()) return null;
  const p = aiProvider();
  const key = getSetting(KEY_OF[p]);
  const msgs = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user');

  if (p === 'anthropic') {
    const out = msgs.map((m, i) => (image && i === lastUser
      ? { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } }, { type: 'text', text: m.content }] } : m));
    const j = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model: getSetting('anthropic_model'), max_tokens: maxTokens, temperature, system, messages: out });
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (p === 'gemini') {
    const contents = msgs.map((m, i) => ({ role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }, ...(image && i === lastUser ? [{ inlineData: { mimeType: image.mime, data: image.base64 } }] : [])] }));
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${getSetting('gemini_model')}:generateContent`, { 'x-goog-api-key': key },
      { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature, maxOutputTokens: maxTokens + 1000 } });
    return (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
  }
  const out = [{ role: 'system', content: system }, ...msgs.map((m, i) => (image && i === lastUser
    ? { role: 'user', content: [{ type: 'text', text: m.content }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] } : m))];
  const model = image ? getSetting('llama_vision_model') || getSetting('llama_model') : getSetting('llama_model');
  const j = await post(`${getSetting('llama_api_url').replace(/\/$/, '')}/chat/completions`, { Authorization: `Bearer ${key}` },
    { model, messages: out, temperature, max_tokens: maxTokens });
  const c = j.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('') : '';
}

export function parseJson(text) {
  if (!text) return null;
  const a = text.search(/[{[]/);
  if (a < 0) return null;
  const close = text[a] === '{' ? '}' : ']';
  try { return JSON.parse(text.slice(a, text.lastIndexOf(close) + 1)); } catch { return null; }
}
const LANG = { te: 'Telugu (use Telugu script)', en: 'English' };
const lang = (l) => LANG[l] || LANG.en;

// ---- Search helpers ----
const cache = new Map();
export async function aiSuggestions(q, city) {
  const key = `${q.toLowerCase()}|${city.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600000) return hit.data;
  const text = await aiChat({
    system: 'You help shoppers in India find where products are sold. Reply with ONLY a JSON array of up to 6 objects {"name": string, "area": string, "note": string}. ' +
      'name is a real, well-known shop or market type for the product in the given city, area is a neighbourhood, note is one short sentence. If unsure return fewer items or []. Never invent phone numbers.',
    messages: [{ role: 'user', content: `Product: ${q}\nCity: ${city || 'India'}` }] });
  const data = (Array.isArray(parseJson(text)) ? parseJson(text) : []).slice(0, 6).map((x) => ({ name: clean(x.name, 80), area: clean(x.area, 80), note: clean(x.note, 160) }));
  cache.set(key, { at: Date.now(), data });
  return data;
}
export async function aiToEnglish(q) {   // Telugu voice/text search -> English keywords
  const t = await aiChat({ system: 'Translate the shopper search into 1 to 4 English keywords. Reply with only the keywords.', messages: [{ role: 'user', content: q }], maxTokens: 40 });
  return clean((t || '').replace(/["\n.]/g, ' '), 60);
}
export async function aiImageToQuery(buffer, mime) {
  const t = await aiChat({ system: 'You identify products in photos for a marketplace search.', maxTokens: 40,
    messages: [{ role: 'user', content: 'Name the product in this photo in 1 to 4 words, as a shopper would search for it. Reply with only the name.' }],
    image: { mime, base64: buffer.toString('base64') } });
  return t === null ? null : clean(t.replace(/["\n.]/g, ' '), 60);
}

// ---- Posting help ----
export async function aiDescribe({ title, category, city, l }) {
  const t = await aiChat({ maxTokens: 300, temperature: 0.5,
    system: `You write short, honest classified ad descriptions for an Indian marketplace in ${lang(l)}. 2 to 4 sentences, plain text, no emojis, no invented specifications or prices. If details are missing, keep it general and invite buyers to call.`,
    messages: [{ role: 'user', content: `Item: ${title}\nCategory: ${category || ''}\nCity: ${city || ''}` }] });
  return t === null ? null : clean(t, 900);
}
export async function aiModerate({ title, description }) {
  try {
    const t = await aiChat({ maxTokens: 80, temperature: 0,
      system: 'You moderate classified ads in India. Reply with ONLY JSON {"ok":true|false,"reason":"..."}. ok=false only for clearly prohibited content: weapons, illegal drugs, stolen goods, adult content, fake documents, betting, scams, or abusive text.',
      messages: [{ role: 'user', content: `Title: ${title}\nDescription: ${description}` }] });
    const j = parseJson(t);
    return j && j.ok === false ? { ok: false, reason: clean(j.reason, 160) } : { ok: true };
  } catch { return { ok: true }; }
}

// ---- Ask AI about one listing ----
export async function aiAsk(listing, question, history, l) {
  const facts = `Title: ${listing.title}\nPrice: Rs ${listing.price}\nCategory: ${listing.category}\nCity: ${listing.city}\nDescription: ${listing.description || 'none'}\nSeller: ${listing.shop_name || 'private seller'}`;
  return aiChat({ maxTokens: 300,
    system: `You answer a buyer's questions about ONE listing on an Indian marketplace, in ${lang(l)}. Be brief (max 3 sentences). Use only these facts. If the answer is not in the facts (condition, warranty, discount, availability, delivery), say you do not know and suggest asking the seller. Never promise anything for the seller.\n${facts}`,
    messages: [...(history || []).slice(-6), { role: 'user', content: question }] });
}

// ---- Site-wide assistant (search + how-to) ----
export async function aiAssistant(history, l, settings) {
  const last = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const words = [...new Set(last.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))].slice(0, 5);
  let found = [];
  if (words.length) {
    const where = words.map(() => '(l.title LIKE ? OR l.description LIKE ? OR l.category LIKE ?)').join(' OR ');
    const args = words.flatMap((w) => [`%${w}%`, `%${w}%`, `%${w}%`]);
    found = db.prepare(`SELECT l.id,l.title,l.price,l.city FROM listings l WHERE l.status='active' AND (${where}) ORDER BY l.id DESC LIMIT 5`).all(...args);
  }
  const ctx = found.length ? found.map((x) => `#${x.id} ${x.title}, Rs ${x.price}, ${x.city}`).join('\n') : 'none';
  const reply = await aiChat({ maxTokens: 400, temperature: 0.4,
    system: `You are the friendly AI helper of ${settings.site}, an Indian marketplace for buying and selling. Reply in ${lang(l)} unless the user writes in another language, then match theirs. Keep answers short (max 4 sentences), no markdown.\n` +
      `Site facts: free ads at /post; Premium ad costs Rs ${settings.premium_price} and shows first on the homepage for ${settings.premium_days} days; browse local shops at /shops; open your own shop at /open-shop (AI voice setup, plans from Rs ${settings.plan_basic_price}); pricing at /pricing; contact at /contact; terms at /page/terms; privacy at /page/privacy; refunds at /page/refund; safety tips at /page/rules.\n` +
      `When pointing to a page, write its path like /post. Ads that match the user's message (mention them only if relevant):\n${ctx}\nNever invent listings, prices or policies not given here.`,
    messages: history.slice(-10) });
  return reply === null ? null : { reply: clean(reply, 1200), listings: found };
}

// ---- Open a shop by talking ----
const REQUIRED = ['shopName', 'ownerName', 'phone', 'email', 'city'];
export async function aiShopIntake({ history, fields, l, cities, plans }) {
  const msgs = history.length ? history : [{ role: 'user', content: 'Hello, I want to open a shop.' }];
  const t = await aiChat({ maxTokens: 400, temperature: 0.2,
    system: `You are a friendly voice assistant helping a shopkeeper in India open a shop on SellBuyAnywhere. Speak ${lang(l)}, in short natural sentences suited to being read aloud, never more than 2 sentences.\n` +
      `Ask ONE question at a time. Collect: shopName, ownerName, phone (10-digit Indian mobile), email, city (one of: ${cities.join(', ')}), address (optional), description (optional, one line on what the shop sells), plan (optional: ${plans}; default basic).\n` +
      `Current saved fields as JSON: ${JSON.stringify(fields)}. Read the user's latest answer and update fields. Clean spoken data: remove spaces from phone numbers; for emails turn "at the rate", "at", "ఎట్" into @, "dot", "డాట్" into ., remove spaces, lowercase.\n` +
      `When shopName, ownerName, phone, email and city are all filled, say you have everything and ask them to check the details on screen and press pay. If they say a value is wrong, fix it.\n` +
      `Reply with ONLY JSON: {"reply": "what to say next", "fields": {"shopName":"","ownerName":"","phone":"","email":"","city":"","address":"","description":"","plan":""}} including only fields you want to set or change.`,
    messages: msgs });
  if (t === null) return null;
  const j = parseJson(t) || {};
  const out = { ...fields };
  const f = j.fields || {};
  for (const k of ['shopName', 'ownerName', 'phone', 'email', 'city', 'address', 'description', 'plan']) if (typeof f[k] === 'string' && f[k].trim()) out[k] = clean(f[k], 300);
  return { reply: clean(j.reply || '', 600) || (l === 'te' ? 'మీ షాప్ పేరు ఏమిటి?' : 'What is your shop name?'), fields: out, required: REQUIRED };
}
