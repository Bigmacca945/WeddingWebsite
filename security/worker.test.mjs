import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createWeddingWorker } from './worker.mjs';

const origin = 'https://cathanandlaura.pages.dev';
const schema = await readFile(new URL('schema.sql', import.meta.url), 'utf8');
const loginTemplate = await readFile(new URL('login.html', import.meta.url), 'utf8');
const content = {
  '/index.html': { body: 'PRIVATE_WEDDING_HOME', contentType: 'text/html; charset=utf-8' },
  '/rsvp.html': { body: 'PRIVATE_WEDDING_RSVP', contentType: 'text/html; charset=utf-8' },
  '/script.js': { body: 'PRIVATE_WEDDING_SCRIPT', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { body: 'PRIVATE_WEDDING_STYLES', contentType: 'text/css; charset=utf-8' }
};

function fixture(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(schema);
  t.after(() => database.close());
  const env = {
    WEDDING_PASSWORD: 'test-only guest passphrase',
    SESSION_SECRET: 'test-only signing secret, not for deployment',
    AUTH_DB: {
      prepare(sql) {
        return { bind(...values) { return { sql, values }; } };
      },
      async batch(statements) {
        database.exec('BEGIN');
        try {
          const results = statements.map(({ sql, values }) => {
            const statement = database.prepare(sql);
            if (/\bRETURNING\b/.test(sql)) return { success: true, results: statement.all(...values) };
            statement.run(...values);
            return { success: true, results: [] };
          });
          database.exec('COMMIT');
          return results;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      }
    }
  };
  const worker = createWeddingWorker(content, loginTemplate);
  return { database, env, worker };
}

function request(path, options = {}) {
  return new Request(`${origin}${path}`, options);
}

function loginRequest(password, { path = '/login', next = '/', ip = '192.0.2.10', headers = {} } = {}) {
  return request(path, {
    method: 'POST',
    headers: { Origin: origin, 'CF-Connecting-IP': ip, ...headers },
    body: new URLSearchParams({ password, next })
  });
}

async function login(worker, env) {
  const result = await worker.fetch(loginRequest(env.WEDDING_PASSWORD), env);
  assert.equal(result.status, 303);
  return result.headers.get('Set-Cookie').split(';')[0];
}

test('anonymous requests cannot download any wedding asset or use legacy cookies', async t => {
  const { worker, env } = fixture(t);
  for (const path of ['/', '/index.html', '/index', '/rsvp', '/rsvp.html', '/script.js?v=1', '/styles.css', '/_worker.js', '/security/worker.mjs']) {
    const result = await worker.fetch(request(path, { headers: { Cookie: 'weddingInviteUnlocked=true' } }), env);
    assert.equal(result.status, 303, path);
    assert.match(result.headers.get('Location'), /^\/login\?next=/);
    assert.doesNotMatch(await result.text(), /PRIVATE_WEDDING/);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
  }
});

test('login page contains no wedding details or credentials and works without JavaScript', async t => {
  const { worker, env } = fixture(t);
  const result = await worker.fetch(request('/login?next=%22%3E%3Cscript%3E'), env);
  const body = await result.text();
  assert.equal(result.status, 200);
  assert.match(body, /method="post" action="\/login"/);
  assert.match(body, /name="next" value="\/"/);
  assert.doesNotMatch(body, /PRIVATE_WEDDING|test-only|<script>/);
  assert.doesNotMatch(body, /\{\{/);
  const nonce = body.match(/nonce="([a-f0-9]+)"/)[1];
  assert.match(result.headers.get('Content-Security-Policy'), new RegExp(`nonce-${nonce}`));
});

test('correct password issues a secure session and all private routes work', async t => {
  const { worker, env } = fixture(t);
  const signedIn = await worker.fetch(loginRequest(env.WEDDING_PASSWORD, { next: '/rsvp.html' }), env);
  assert.equal(signedIn.headers.get('Location'), '/rsvp.html');
  const setCookie = signedIn.headers.get('Set-Cookie');
  for (const property of ['__Host-wedding_session=', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=86400']) {
    assert.ok(setCookie.includes(property), property);
  }
  assert.doesNotMatch(setCookie, /Domain=/i);
  const headers = { Cookie: setCookie.split(';')[0] };
  for (const [path, expected] of [
    ['/', 'PRIVATE_WEDDING_HOME'], ['/index', 'PRIVATE_WEDDING_HOME'],
    ['/rsvp', 'PRIVATE_WEDDING_RSVP'], ['/rsvp.html', 'PRIVATE_WEDDING_RSVP'],
    ['/script.js?v=1', 'PRIVATE_WEDDING_SCRIPT'], ['/styles.css', 'PRIVATE_WEDDING_STYLES']
  ]) {
    const result = await worker.fetch(request(path, { headers }), env);
    assert.equal(result.status, 200, path);
    assert.equal(await result.text(), expected);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
    assert.equal(result.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
    assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(result.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  }
  for (const path of ['/_worker.js', '/security/worker.mjs', '/constructor', '/__proto__', '/README.md']) {
    assert.equal((await worker.fetch(request(path, { headers }), env)).status, 404);
  }
  const head = await worker.fetch(request('/', { method: 'HEAD', headers }), env);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('incorrect passwords and duplicate password fields never set a cookie', async t => {
  const { worker, env } = fixture(t);
  for (const password of ['', 'wrong', `${env.WEDDING_PASSWORD} `]) {
    const result = await worker.fetch(loginRequest(password), env);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('Set-Cookie'), null);
    assert.doesNotMatch(await result.text(), /PRIVATE_WEDDING|test-only/);
  }
  const body = new URLSearchParams({ password: env.WEDDING_PASSWORD });
  body.append('password', env.WEDDING_PASSWORD);
  const result = await worker.fetch(request('/login', {
    method: 'POST', headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.10' }, body
  }), env);
  assert.equal(result.status, 401);
});

test('malformed, tampered, expired and duplicate sessions are refused', async t => {
  const { worker, env } = fixture(t);
  const valid = await login(worker, env);
  for (const token of [
    '__Host-wedding_session=true',
    '__Host-wedding_session=1234567890.abcd',
    `${valid.slice(0, -1)}${valid.endsWith('a') ? 'b' : 'a'}`,
    `${valid}; ${valid}`,
    `__Host-wedding_session=0000000000.${'a'.repeat(64)}`,
    `__Host-wedding_session=9999999999.${'a'.repeat(64)}`
  ]) {
    assert.equal((await worker.fetch(request('/', { headers: { Cookie: token } }), env)).status, 303);
  }
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86401 * 1000 });
  assert.equal((await worker.fetch(request('/', { headers: { Cookie: valid } }), env)).status, 303);
});

test('sessions cannot cross origins and rotation of either secret revokes them', async t => {
  const { worker, env } = fixture(t);
  const value = await login(worker, env);
  const headers = { Cookie: value };
  const preview = new Request('https://preview.cathanandlaura.pages.dev/', { headers });
  assert.equal((await worker.fetch(preview, env)).status, 303);
  for (const override of [
    { WEDDING_PASSWORD: 'a different test-only password' },
    { SESSION_SECRET: 'a different test-only signing secret' }
  ]) {
    assert.equal((await worker.fetch(request('/', { headers }), { ...env, ...override })).status, 303);
  }
});

test('rate limiter is atomic across worker instances, expires and stores no raw IP', async t => {
  const { worker, env, database } = fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const otherWorker = createWeddingWorker(content, loginTemplate);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    (index % 2 ? worker : otherWorker).fetch(loginRequest('wrong'), env)));
  assert.equal(responses.filter(result => result.status === 401).length, 10);
  assert.equal(responses.filter(result => result.status === 429).length, 2);
  const blocked = await worker.fetch(loginRequest(env.WEDDING_PASSWORD), env);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '900');
  const record = database.prepare('SELECT * FROM login_attempts').get();
  assert.match(record.client_key, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(record).includes('192.0.2.10'));
  assert.equal((await worker.fetch(loginRequest(env.WEDDING_PASSWORD, { ip: '192.0.2.11' }), env)).status, 303);
  t.mock.timers.tick(900 * 1000);
  assert.equal((await worker.fetch(loginRequest(env.WEDDING_PASSWORD), env)).status, 303);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_attempts').get().count, 1);
});

test('cross-origin forms, unexpected methods and insecure POSTs are rejected', async t => {
  const { worker, env } = fixture(t);
  for (const badOrigin of ['https://attacker.example', 'null', '']) {
    assert.equal((await worker.fetch(loginRequest(env.WEDDING_PASSWORD, { headers: { Origin: badOrigin } }), env)).status, 403);
  }
  assert.equal((await worker.fetch(request('/logout'), env)).status, 405);
  assert.equal((await worker.fetch(request('/logout', { method: 'POST', headers: { Origin: 'https://attacker.example' } }), env)).status, 403);
  assert.equal((await worker.fetch(request('/', { method: 'POST' }), env)).status, 405);
  assert.equal((await worker.fetch(request('/login', { method: 'PUT' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('http://cathanandlaura.pages.dev/login', { method: 'POST' }), env)).status, 400);
});

test('redirect targets are restricted to wedding pages and logout clears the cookie', async t => {
  const { worker, env } = fixture(t);
  for (const next of ['https://attacker.example', '//attacker.example', '/\\attacker.example', '/%2f/attacker.example', '/script.js']) {
    const result = await worker.fetch(loginRequest(env.WEDDING_PASSWORD, { next }), env);
    assert.equal(result.headers.get('Location'), '/');
  }
  const result = await worker.fetch(request('/logout', { method: 'POST', headers: { Origin: origin } }), env);
  assert.equal(result.status, 303);
  assert.equal(result.headers.get('Location'), '/login');
  assert.match(result.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('oversized bodies are rejected even without a content length', async t => {
  const { worker, env } = fixture(t);
  assert.equal((await worker.fetch(loginRequest('x'.repeat(3000)), env)).status, 413);
  assert.equal((await worker.fetch(request('/login', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}'
  }), env)).status, 415);
});

test('missing configuration, missing client IP, and database failure all fail closed', async t => {
  const { worker, env } = fixture(t);
  const log = t.mock.method(console, 'error', () => {});
  for (const override of [{ WEDDING_PASSWORD: '' }, { WEDDING_PASSWORD: 'too short' }, { SESSION_SECRET: '' }, { AUTH_DB: null }]) {
    const result = await worker.fetch(request('/'), { ...env, ...override });
    assert.equal(result.status, 503);
    assert.doesNotMatch(await result.text(), /PRIVATE_WEDDING/);
  }
  const missingIp = loginRequest(env.WEDDING_PASSWORD);
  missingIp.headers.delete('CF-Connecting-IP');
  assert.equal((await worker.fetch(missingIp, env)).status, 503);
  const brokenEnv = { ...env, AUTH_DB: { ...env.AUTH_DB, batch() { throw new Error('Database offline'); } } };
  const result = await worker.fetch(loginRequest(env.WEDDING_PASSWORD), brokenEnv);
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /PRIVATE_WEDDING/);
  assert.ok(log.mock.callCount() > 0);
  assert.doesNotMatch(JSON.stringify(log.mock.calls), /test-only/);
});

test('robots forbids indexing and never discloses site content', async t => {
  const { worker, env } = fixture(t);
  const result = await worker.fetch(request('/robots.txt'), env);
  assert.equal(await result.text(), 'User-agent: *\nDisallow: /\n');
});
