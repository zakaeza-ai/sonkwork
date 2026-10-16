// Vercel serverless function: reads an envelope photo or a banknote photo with Gemini.
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   GEMINI_API_KEY   required — from Google AI Studio
//   GEMINI_MODELS    optional — comma list tried in order when one runs out of quota
//                    default: gemini-3.6-flash,gemini-2.5-flash,gemini-2.5-flash-lite,gemma-4-31b-it,gemma-4-26b-a4b-it
//   ALLOWED_ORIGINS  optional — comma list of sites allowed to call this, e.g. https://zakaeza-ai.github.io

const PROMPTS = {
  envelope:
    'รูปนี้คือหน้าซองใส่เงินช่วยงานของไทย (งานแต่ง งานบวช งานศพ งานบุญ) ส่วนใหญ่เขียนด้วยลายมือ ' +
    'อ่านชื่อผู้ให้ซอง (รวมคำนำหน้า เช่น นาย นาง คุณ ถ้ามี) ที่อยู่หรือข้อความอื่น และจำนวนเงินถ้าเขียนไว้หน้าซอง ' +
    'ถ้าเขียนว่าเป็นญาติหรือรู้จักทางไหน เช่น ญาติฝ่ายแม่ เพื่อนเจ้าบ่าว ให้ใส่ใน relation ' +
    'ตอบเป็น JSON เท่านั้น: {"name": string, "note": string, "relation": string, "amount": number|null, "sure": boolean} ' +
    'ถ้าอ่านไม่ออกให้ name เป็น "" และ sure เป็น false',
  cash:
    'รูปนี้มีธนบัตรและอาจมีเหรียญเงินบาทไทยวางอยู่ นับจำนวนธนบัตรแต่ละชนิด ' +
    '(1000 สีเทาน้ำตาล, 500 สีม่วง, 100 สีแดง, 50 สีน้ำเงิน, 20 สีเขียว) และรวมมูลค่าเหรียญทั้งหมดเป็นบาท ' +
    'ระวังอย่านับธนบัตรที่ซ้อนกันซ้ำ ' +
    'ตอบเป็น JSON เท่านั้น: {"1000": int, "500": int, "100": int, "50": int, "20": int, "coins": number, "sure": boolean}',
};

function cors(req, res) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return !origin || !allowed.length || allowed.includes(origin);
}

module.exports = async function handler(req, res) {
  const ok = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!ok) return res.status(403).json({ error: 'origin not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const { kind, image } = body;
  if (!PROMPTS[kind] || typeof image !== 'string') return res.status(400).json({ error: 'bad request' });
  if (image.length > 3_500_000) return res.status(413).json({ error: 'image too large' });

  const models = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL ||
    'gemini-3.6-flash,gemini-2.5-flash,gemini-2.5-flash-lite,gemma-4-31b-it,gemma-4-26b-a4b-it')
    .split(',').map(s => s.trim()).filter(Boolean);

  let lastStatus = 502, lastError = 'read failed';
  for (const model of models) {
    const isGemma = model.startsWith('gemma');
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [
              { inline_data: { mime_type: 'image/jpeg', data: image } },
              { text: PROMPTS[kind] },
            ] }],
            generationConfig: isGemma ? { temperature: 0 } : { responseMimeType: 'application/json', temperature: 0 },
          }),
        }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastStatus = r.status === 429 ? 429 : 502;
        lastError = model + ': ' + (data?.error?.message || r.status);
        continue; // quota used up or model not available → try the next one
      }
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { lastError = model + ': no json'; continue; }
      const out = JSON.parse(m[0]);
      res.setHeader('X-Model', model);
      return res.status(200).json(out);
    } catch (e) {
      lastError = model + ': ' + (e.message || 'failed');
    }
  }
  console.error('all models failed:', lastError);
  return res.status(lastStatus).json({ error: lastError });
};
