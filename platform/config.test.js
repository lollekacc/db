const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadPlatformConfig, parseOrigins } = require('./config');

test('default CORS origins allow the deployed website and local development', () => {
  const expected = ['https://lollekacc.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://[::1]:5500'];
  assert.deepEqual(parseOrigins(), expected);
  assert.deepEqual(loadPlatformConfig({ DEMO_MODE: 'true' }).corsOrigins, expected);
  assert.equal(parseOrigins().includes('https://untrusted.example'), false);
});

test('explicit CORS configuration stays authoritative and rejects wildcards', () => {
  assert.deepEqual(parseOrigins('https://custom.example/'), ['https://custom.example']);
  assert.throws(() => parseOrigins('*'), /without wildcards/);
  assert.throws(() => parseOrigins('https://lollekacc.github.io/df'), /scheme and authority/);
});
