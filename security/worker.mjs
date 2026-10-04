const SESSION_SECONDS = 24 * 60 * 60;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 10;
const MAX_BODY_BYTES = 2048;
const COOKIE_NAME = '__Host-wedding_session';
const encoder = new TextEncoder();
const PAGE_PATHS = new Set(['/', '/index', '/index.html', '/rsvp', '/rsvp.html']);
const ALIASES = new Map([['/', '/index.html'], ['/index', '/index.html'], ['/rsvp', '/rsvp.html']]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' https://www.theduke.co.nz https://images.unsplash.com data:",
  "frame-src https://open.spotify.com",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');

function response(body, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store',
    'Vary': 'Cookie',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
    'Content-Security-Policy': CSP
  });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(body, { status, headers });
}

function redirect(location, extraHeaders = {}) {
  return response(null, 303, { Location: location, ...extraHeaders });
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value) {
  return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
}

function importKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function sign(key, message) {
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

function safeNext(value) {
  return PAGE_PATHS.has(value) ? value : '/';
}

function cookie(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function loginPage(template, next, message = '', status = 200, extraHeaders = {}) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const html = template
    .replaceAll('{{NONCE}}', nonce)
    .replace('{{NEXT}}', escapeHtml(safeNext(next)))
    .replace('{{MESSAGE}}', escapeHtml(message));
  return response(html, status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    ...extraHeaders
  });
}

async function sessionIsValid(request, key, now, origin) {
  const tokens = (request.headers.get('Cookie') || '').split(';')
    .map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE_NAME}=`));
  if (tokens.length !== 1) return false;
  const match = tokens[0].slice(COOKIE_NAME.length + 1).match(/^(\d{10})\.([a-f0-9]{64})$/);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires <= now || expires > now + SESSION_SECONDS) return false;
  return crypto.subtle.verify('HMAC', key, fromHex(match[2]), encoder.encode(`session:v1:${origin}:${expires}`));
}

async function readForm(request) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    return { error: response('Unsupported form format.', 415) };
  }
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    return { error: response('Form is too large.', 413) };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: response('Missing form.', 400) };
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return { error: response('Form is too large.', 413) };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { fields: new URLSearchParams(new TextDecoder().decode(bytes)) };
}

async function consumeAttempt(database, clientKey, now) {
  // D1 serializes this atomic upsert across Worker instances; in-memory/KV counters do not.
  const results = await database.batch([
    database.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now),
    database.prepare(`
      INSERT INTO login_attempts (client_key, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(client_key) DO UPDATE SET attempts = MIN(login_attempts.attempts + 1, ?)
      RETURNING attempts, expires_at
    `).bind(clientKey, now + ATTEMPT_WINDOW_SECONDS, MAX_ATTEMPTS + 1)
  ]);
  const row = results[1]?.results?.[0];
  if (!results.every(result => result.success) || !row ||
      !Number.isInteger(row.attempts) || !Number.isInteger(row.expires_at)) {
    throw new Error('Login limiter returned an invalid result.');
  }
  return row;
}

export function createWeddingWorker(siteContent, loginTemplate) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.protocol !== 'https:') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return response('HTTPS is required.', 400);
        }
        url.protocol = 'https:';
        return redirect(url.href);
      }

      try {
        const result = await handle(request, env, url);
        return request.method === 'HEAD'
          ? new Response(null, { status: result.status, headers: result.headers })
          : result;
      } catch (error) {
        // Never fall back to serving wedding assets when authentication infrastructure fails.
        console.error('Wedding authentication unavailable.', {
          type: error instanceof Error ? error.name : 'UnknownError'
        });
        return response(request.method === 'HEAD' ? null : 'The private website is temporarily unavailable. Please try again later.', 503,
          { 'Retry-After': '60' });
      }
    }
  };

  async function handle(request, env, url) {
    if (url.pathname === '/robots.txt' && ['GET', 'HEAD'].includes(request.method)) {
      return response('User-agent: *\nDisallow: /\n');
    }
    if (typeof env.WEDDING_PASSWORD !== 'string' || env.WEDDING_PASSWORD.length < 16 ||
        env.WEDDING_PASSWORD.length > 256 ||
        typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32 ||
        !env.AUTH_DB || typeof env.AUTH_DB.batch !== 'function') {
      console.error('Missing or invalid wedding authentication configuration.');
      return response('The private website is not ready yet. Please try again later.', 503);
    }

    const masterKey = await importKey(encoder.encode(env.SESSION_SECRET));
    // Rotating either secret invalidates all previously issued guest sessions.
    const sessionKey = await importKey(await sign(masterKey, `session-key:v1:${env.WEDDING_PASSWORD}`));
    const now = Math.floor(Date.now() / 1000);

    if (url.pathname === '/login') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        return loginPage(loginTemplate, url.searchParams.get('next'));
      }
      if (request.method !== 'POST') return response('Method not allowed.', 405, { Allow: 'GET, HEAD, POST' });
      if (request.headers.get('Origin') !== url.origin) return response('Invalid request origin.', 403);
      const parsed = await readForm(request);
      if (parsed.error) return parsed.error;
      const next = safeNext(parsed.fields.get('next'));
      const address = request.headers.get('CF-Connecting-IP');
      if (!address) {
        console.error('Cloudflare client address is missing; login refused.');
        return response('Login is temporarily unavailable.', 503);
      }
      const clientKey = hex(await sign(masterKey, `login-client:v1:${address}`));
      const attempt = await consumeAttempt(env.AUTH_DB, clientKey, now);
      if (attempt.attempts > MAX_ATTEMPTS) {
        return loginPage(loginTemplate, next, 'Too many attempts. Please wait 15 minutes before trying again.', 429,
          { 'Retry-After': String(Math.max(1, attempt.expires_at - now)) });
      }
      const passwords = parsed.fields.getAll('password');
      const password = passwords.length === 1 ? passwords[0] : '';
      const expected = await sign(masterKey, `password:v1:${env.WEDDING_PASSWORD}`);
      const valid = password.length <= 256 &&
        await crypto.subtle.verify('HMAC', masterKey, expected, encoder.encode(`password:v1:${password}`));
      if (!valid) {
        return loginPage(loginTemplate, next, 'That password is not correct. Please try again.', 401);
      }
      const expires = now + SESSION_SECONDS;
      const signature = hex(await sign(sessionKey, `session:v1:${url.origin}:${expires}`));
      return redirect(next, { 'Set-Cookie': cookie(`${expires}.${signature}`) });
    }

    if (url.pathname === '/logout') {
      if (request.method !== 'POST') return response('Method not allowed.', 405, { Allow: 'POST' });
      if (request.headers.get('Origin') !== url.origin) return response('Invalid request origin.', 403);
      return redirect('/login', { 'Set-Cookie': cookie('', 0) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return response('Method not allowed.', 405, { Allow: 'GET, HEAD' });
    }
    if (!await sessionIsValid(request, sessionKey, now, url.origin)) {
      return redirect(`/login?next=${encodeURIComponent(safeNext(url.pathname))}`);
    }
    const asset = siteContent[ALIASES.get(url.pathname) || url.pathname];
    if (!asset || typeof asset.body !== 'string' || typeof asset.contentType !== 'string') {
      return response('Not found.', 404);
    }
    return response(asset.body, 200, { 'Content-Type': asset.contentType });
  }
}
