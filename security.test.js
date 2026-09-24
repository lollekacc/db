const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('./server');
const { createPlatformRuntime } = require('./platform/runtime');
const { RollingWindowRateLimiter } = require('./platform/rate-limiter');
const { resolveAuthContext, buildDemoUsers } = require('./platform/permissions');
const { sendPlatformError } = require('./platform/http');

const runtime = () => createPlatformRuntime({ environment: { DEMO_MODE: 'true', PUBLIC_CHAT_RATE_LIMIT: '1' } });

test('public server blocks private files, malformed paths, and hostile browser origins', async (t) => {
  const server = createServer({ platformRuntime: runtime() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/.git/config', '/%2egit/config', '/.env', '/AGENTS.md', '/package.json', '/scripts/check-js.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal((await fetch(base + '/%ZZ')).status, 400);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal((await fetch(base + '/assets/bankid.js')).status, 200);
  for (const path of ['/api/newsletter', '/api/public/v1/conversations']) {
    const denied = await fetch(base + path, { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
  }
  for (let index = 0; index < 2; index++) {
    const response = await fetch(base + '/api/public/v1/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `192.0.2.${index}` }, body: '{}' });
    assert.equal(response.status, index === 0 ? 201 : 429);
  }
});

test('submission abuse is limited before processing', async (t) => {
  const limiter = new RollingWindowRateLimiter();
  for (let index = 0; index < 120; index++) limiter.consume('submission:127.0.0.1', 120);
  const server = createServer({ platformRuntime: runtime(), legacyLimiter: limiter });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('demo identities reject remote and forwarded requests', () => {
  for (const request of [
    { socket: { remoteAddress: '192.0.2.1' }, headers: {} },
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.1' } },
    { socket: { remoteAddress: '::1' }, headers: { forwarded: 'for=192.0.2.1' } },
  ]) assert.throws(() => resolveAuthContext(request, { demoMode: true }, buildDemoUsers(), 'admin'), { code: 'DEMO_ACCESS_DENIED' });
});

test('limiter bounds memory and recovers after expiry', () => {
  const limiter = new RollingWindowRateLimiter({ maxEntries: 1, windowMs: 100 });
  assert.equal(limiter.consume('a', 2, 0).allowed, true);
  assert.equal(limiter.consume('b', 2, 1).allowed, false);
  assert.equal(limiter.entries.size, 1);
  assert.equal(limiter.consume('b', 2, 101).allowed, true);
});

test('coded server errors never expose internal messages', () => {
  let body;
  sendPlatformError({ headers: {} }, { writeHead() {}, end(value) { body = JSON.parse(value); } }, { corsOrigins: [] }, 'test-id', Object.assign(new Error('secret database details'), { code: 'DATABASE_ERROR', statusCode: 500 }));
  assert.equal(body.error.message, 'An unexpected server error occurred');
  assert.equal(body.error.details, null);
});
