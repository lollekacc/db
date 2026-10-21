const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('./server');
const { isPublicPreview } = require('./public-preview');

const listen = async (t, options = {}) => {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
};
test('preview is the default and rejects all order and personal-data routes before runtime access', async t => {
  for (const value of [undefined, '', 'true', 'FALSE', '0']) assert.equal(isPublicPreview({ PUBLIC_PREVIEW: value }), true);
  assert.equal(isPublicPreview({ PUBLIC_PREVIEW: 'false' }), false);
  const runtime = { config: { demoMode: true, corsOrigins: ['http://localhost:3000'] }, get service() { throw new Error('Preview must never access customer services'); } };
  const base = await listen(t, { publicPreview: true, platformRuntime: runtime });
  const environment = await (await fetch(`${base}/api/public/v1/environment`)).json();
  assert.equal(environment.publicPreview, true);
  assert.equal(environment.demoMode, false);
  assert.equal(environment.ordersEnabled, false);
  for (const route of ['/api/orders', '/api/public/v1/orders', '/api/bankid/start', '/api/bankid/collect', '/api/bankid/cancel', '/api/newsletter', '/api/chat', '/api/chat-feedback', '/api/public/v1/conversations', '/api/public/v1/conversations/anything/messages', '/api/translate']) {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-User': 'admin' }, body: '{invalid' });
    assert.equal(response.status, 423, route);
    assert.match((await response.json()).code, /^(ORDERS_DISABLED|PREVIEW_ONLY)$/);
  }
  for (const route of ['/api/admin/v1/session', '/api/customer/v1/session', '/api/partner/v1/session']) {
    assert.equal((await fetch(base + route, { headers: { 'X-Demo-User': 'admin' } })).status, 423, route);
  }
  assert.deepEqual(await (await fetch(`${base}/api/newsletter/status`)).json(), { enabled: false });
});
test('preview serves the catalogue and blocks private files and unknown routes', async t => {
  const base = await listen(t, { publicPreview: true });
  for (const route of ['/api/mobile/plans', '/api/broadband/offers', '/api/featured-offers']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.ok((await response.json()).length);
  }
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
  for (const route of ['/.env', '/.git/config', '/scripts/check-js.js']) assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + '/api/new-write-endpoint', { method: 'POST' })).status, 423);
  assert.equal((await fetch(base + '/api/mobile/plans', { method: 'POST' })).status, 423);
});

test('preview capabilities and health work with conversation-only storage without accessing the platform', async t => {
  const runtime = {
    config: { demoMode: false, corsOrigins: ['https://preview.dealett.se'] },
    get repository() { throw new Error('Preview must not depend on the live database'); },
    get service() { throw new Error('Preview must not access customer services'); },
  };
  const base = await listen(t, { publicPreview: true, conversationStorageOnly: true, platformRuntime: runtime });
  for (const [route, expected] of [
    ['/api/public/v1/environment', { publicPreview: true, ordersEnabled: false, demoMode: false, chatEnabled: false }],
    ['/api/public/v1/health/live', { ok: true, status: 'live', publicPreview: true, ordersEnabled: false }],
    ['/api/public/v1/health/ready', { ok: true, status: 'ready', publicPreview: true, ordersEnabled: false }],
  ]) {
    const response = await fetch(base + route, { headers: { Origin: 'https://preview.dealett.se' } });
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://preview.dealett.se');
    const body = await response.json();
    for (const [key, value] of Object.entries(expected)) assert.equal(body[key], value, `${route} ${key}`);
  }
  for (const route of ['/api/orders', '/api/public/v1/orders']) {
    const response = await fetch(base + route, { method: 'POST', body: '{invalid' });
    assert.equal(response.status, 423, route);
    assert.equal((await response.json()).code, 'ORDERS_DISABLED');
  }
});
test('orders remain disabled outside preview when live enablement or runtime is missing', async t => {
  const base = await listen(t, { publicPreview: false, platformRuntime: { config: { demoMode: false, corsOrigins: ['http://localhost:3000'] } } });
  const previous = process.env.LIVE_ORDERS_ENABLED;
  delete process.env.LIVE_ORDERS_ENABLED;
  t.after(() => { if (previous === undefined) delete process.env.LIVE_ORDERS_ENABLED; else process.env.LIVE_ORDERS_ENABLED = previous; });
  for (const route of ['/api/orders', '/api/public/v1/orders']) assert.equal((await fetch(base + route, { method: 'POST', body: '{}' })).status, 423);
});
