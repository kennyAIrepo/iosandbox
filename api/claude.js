/**
 * hopeOS — Claude (Anthropic) proxy.
 * The browser POSTs an Anthropic Messages body here; this function adds the
 * secret key server-side and forwards it. The key NEVER reaches the browser.
 *
 * Env var (set in Vercel → Settings → Environment Variables): ANTHROPIC_API_KEY
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'POST only' } });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY is not set on the server' } });
    return;
  }
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      // req.body is the parsed JSON object (Vercel parses application/json).
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (e) {
    res.status(502).json({ error: { message: 'proxy error: ' + e.message } });
  }
}
