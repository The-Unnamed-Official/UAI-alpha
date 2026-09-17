/**
 * UnAI Cloudflare Worker
 *
 * Keeps the Groq API key off the public website and streams responses back
 * to index.html using Groq's OpenAI-compatible Chat Completions API.
 *
 * Required secret:
 *   GROQ_API_KEY
 *
 * Optional environment variables:
 *   ALLOWED_ORIGINS=https://your-site.example,https://username.github.io
 *   UNAI_SYSTEM_PROMPT=You are UnAI...
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const ALLOWED_MODELS = new Set([
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b'
]);

// Basic per-isolate burst protection. For stronger public abuse protection,
// also enable Cloudflare's platform rate limiting / WAF for this route.
const rateBuckets = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 24;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

function parseOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = parseOrigins(env);
  const allowOrigin = allowed.length === 0
    ? '*'
    : (allowed.includes(origin) ? origin : 'null');
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'vary': 'Origin'
  };
}

function originAllowed(request, env) {
  const allowed = parseOrigins(env);
  if (!allowed.length) return true;
  const origin = request.headers.get('origin');
  return !!origin && allowed.includes(origin);
}

function rateLimited(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const t = Date.now();
  const current = rateBuckets.get(ip);
  if (!current || t - current.startedAt > RATE_WINDOW_MS) {
    rateBuckets.set(ip, { startedAt: t, count: 1 });
    return false;
  }
  current.count += 1;
  if (current.count > RATE_LIMIT) return true;

  // Avoid unbounded isolate memory growth.
  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (t - value.startedAt > RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  return false;
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) throw new Error('messages must be an array');
  if (input.length < 1) throw new Error('at least one message is required');
  if (input.length > 50) throw new Error('conversation is too long');

  let totalChars = 0;
  const messages = [];
  for (const message of input) {
    if (!message || !['user', 'assistant', 'system'].includes(message.role)) continue;
    const content = String(message.content ?? '');
    if (!content.trim()) continue;
    if (content.length > 24_000) throw new Error('one message is too large');
    totalChars += content.length;
    if (totalChars > 140_000) throw new Error('conversation payload is too large');
    messages.push({ role: message.role, content });
  }
  if (!messages.some(m => m.role === 'user')) throw new Error('a user message is required');
  return messages;
}

function buildSystemPrompt(env, customInstructions) {
  const base = String(env.UNAI_SYSTEM_PROMPT || [
    'You are UnAI, short for Unnamed Artificial Intelligence.',
    'Be accurate, useful, direct, and clear.',
    'Use Markdown when it improves readability.',
    'Do not claim to have completed actions you did not actually perform.'
  ].join(' ')).slice(0, 12_000);

  const custom = String(customInstructions || '').trim().slice(0, 8_000);
  return custom ? `${base}\n\nUser preferences:\n${custom}` : base;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'UnAI', models: [...ALLOWED_MODELS] }, 200, cors);
    }

    if (url.pathname !== '/api/chat') {
      return json({ error: 'Not found' }, 404, cors);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    if (!originAllowed(request, env)) {
      return json({ error: 'Origin not allowed' }, 403, cors);
    }

    if (rateLimited(request)) {
      return json({ error: 'Too many requests. Please wait a moment and try again.' }, 429, {
        ...cors,
        'retry-after': '60'
      });
    }

    if (!env.GROQ_API_KEY) {
      return json({ error: 'Server is missing GROQ_API_KEY.' }, 500, cors);
    }

    const length = Number(request.headers.get('content-length') || 0);
    if (length > 350_000) {
      return json({ error: 'Request body is too large.' }, 413, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Request body must be valid JSON.' }, 400, cors);
    }

    const model = ALLOWED_MODELS.has(body.model) ? body.model : 'openai/gpt-oss-20b';
    let messages;
    try {
      messages = sanitizeMessages(body.messages);
    } catch (err) {
      return json({ error: err.message }, 400, cors);
    }

    messages.unshift({
      role: 'system',
      content: buildSystemPrompt(env, body.customInstructions)
    });

    const temperature = Math.max(0, Math.min(1.5, Number(body.temperature ?? 0.7)));
    const wantsStream = body.stream !== false;

    let upstream;
    try {
      upstream = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${env.GROQ_API_KEY}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          stream: wantsStream,
          max_completion_tokens: 4096
        })
      });
    } catch (err) {
      return json({ error: 'Could not reach the AI provider.' }, 502, cors);
    }

    if (!upstream.ok) {
      let detail = `Groq returned HTTP ${upstream.status}`;
      try {
        const data = await upstream.json();
        detail = data?.error?.message || data?.error || detail;
      } catch {}
      return json({ error: detail }, upstream.status, cors);
    }

    const headers = new Headers(cors);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.set('content-type', upstream.headers.get('content-type') || (wantsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'));

    return new Response(upstream.body, {
      status: 200,
      headers
    });
  }
};
