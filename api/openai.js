/**
 * hopeOS — OpenAI Whisper proxy (speech → text).
 * The browser POSTs raw audio bytes (content-type application/octet-stream) plus
 * a few x- headers; this function rebuilds the multipart form server-side, adds
 * the secret key, and forwards to OpenAI. The key never reaches the browser.
 *
 * Env var: OPENAI_API_KEY
 */

async function rawBody(req) {
  // Vercel's Node runtime leaves binary/unknown content-types as a Buffer on
  // req.body; fall back to reading the stream if it didn't.
  if (req.body) return Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server' });
    return;
  }
  try {
    const audio = await rawBody(req);
    const fd = new FormData();
    fd.append('file', new Blob([audio], { type: req.headers['x-audio-type'] || 'audio/webm' }), 'audio.webm');
    fd.append('model', req.headers['x-model'] || 'gpt-4o-transcribe');
    fd.append('language', req.headers['x-language'] || 'en');

    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },   // fetch sets multipart boundary from the FormData
      body: fd,
    });
    const text = await upstream.text();
    res.setHeader('content-type', upstream.headers.get('content-type') || 'application/json');
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(502).json({ error: 'proxy error: ' + e.message });
  }
}
