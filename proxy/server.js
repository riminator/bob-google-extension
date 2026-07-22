// proxy/server.js — Bob LLM proxy for cloud deployment
// Deployed once to Render / Railway / Fly.io / any Node host.
// Receives { messages, apiKey } from the Chrome extension and forwards the
// request to the Bob Inference API without the Origin: chrome-extension://
// header that Cloudflare would otherwise block.
//
// Security model:
//   - PROXY_SECRET env var: a shared secret the extension must send in
//     X-Proxy-Secret. Without it anyone can hit your deployed URL.
//     Set it to any random string (e.g. `openssl rand -hex 24`).
//   - The user's Bob API key is never logged and never stored — it travels
//     request-in / response-out only.

'use strict';
const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3333;

// ── Required env vars ──
const BOB_API_URL     = process.env.BOB_API_URL     || 'https://api.us-east.bob.ibm.com/inference/v1/chat/completions';
const BOB_MODEL       = process.env.BOB_MODEL       || 'premium-shell';
const BOB_INSTANCE_ID = process.env.BOB_INSTANCE_ID || '';
const BOB_TEAM_ID     = process.env.BOB_TEAM_ID     || '';
const BOB_KEY_TYPE    = process.env.BOB_KEY_TYPE    || 'inference'; // 'inference' → "Apikey", 'general' → "Bearer"
// PROXY_SECRET: set this in your hosting dashboard. The extension sends it in X-Proxy-Secret.
// Leave empty to disable the check (not recommended for a public deployment).
const PROXY_SECRET    = process.env.PROXY_SECRET    || '';

// ── Middleware ──
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '256kb' }));

// ── GET /health ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// ── POST /chat ──
// Body: { messages: [...], apiKey: "sk-..." }
// Returns: { answer: "...", actions: [...] }
app.post('/chat', async (req, res) => {
  // Secret check
  if (PROXY_SECRET) {
    const incoming = req.headers['x-proxy-secret'] || '';
    if (incoming !== PROXY_SECRET) {
      return res.status(401).json({ error: 'Invalid proxy secret.' });
    }
  }

  const { messages, apiKey } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }

  const authPrefix = BOB_KEY_TYPE === 'general' ? 'Bearer' : 'Apikey';

  let response;
  try {
    response = await fetch(BOB_API_URL, {
      method: 'POST',
      headers: {
        'Authorization':  `${authPrefix} ${apiKey}`,
        'Content-Type':   'application/json',
        'User-Agent':     'bobshell/1.0.6',
        'x-instance-id':  BOB_INSTANCE_ID,
        'x-team-id':      BOB_TEAM_ID,
      },
      body: JSON.stringify({
        model:       BOB_MODEL,
        messages,
        temperature: 0.3,
        max_tokens:  1024,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach Bob API: ${err.message}` });
  }

  const text = await response.text();

  if (!response.ok) {
    return res.status(response.status).json({
      error: `Bob API returned ${response.status}: ${text.slice(0, 200)}`,
    });
  }

  let llmJson;
  try { llmJson = JSON.parse(text); }
  catch { return res.status(502).json({ error: 'Bob API returned non-JSON' }); }

  const raw = llmJson.choices?.[0]?.message?.content || '{}';

  let parsed;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    parsed = JSON.parse(jsonMatch[1].trim());
  } catch {
    parsed = { answer: raw, actions: [] };
  }

  res.json(parsed);
});

// ── 404 catchall ──
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Bob LLM proxy listening on port ${PORT}`);
  if (!PROXY_SECRET) {
    console.warn('WARNING: PROXY_SECRET is not set. Anyone can use this proxy.');
  }
});
