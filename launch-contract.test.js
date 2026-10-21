const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getBroadbandPlans, getBroadbandOffers, buildBroadbandCartItem, getPlans, buildMobileCartItem } = require('./offer-service');
const { subscribeToNewsletter, getNewsletterStatus } = require('./newsletter-service');
const { buildAuthoritativeSnapshot } = require('./platform/service');

test('broadband price, commitment and reward agree from catalogue through order authority', () => {
  for (const source of getBroadbandPlans()) {
    const offer = getBroadbandOffers().find((entry) => entry.id === source.id);
    const { cartItem } = buildBroadbandCartItem({ planId: source.id });
    assert.equal(offer.bindingMonths, source.bindingMonths, source.id);
    assert.equal(cartItem.bindingMonths, source.bindingMonths, source.id);
    assert.equal(cartItem.price, source.price);
    assert.equal(cartItem.rewardTotal, Number(source.rewardTotal) || 0);
    const authority = buildAuthoritativeSnapshot({ cartItems: [cartItem] });
    assert.equal(authority.selectedOffer.bindingMonths, source.bindingMonths);
    assert.equal(authority.aggregateGiftCardValueMinor, cartItem.rewardTotal * 100);
  }
});

test('mobile carts preserve catalogue terms and do not accept invented reward allocations', () => {
  for (const plan of getPlans().filter((entry) => !entry.isFamilyPlan)) {
    const { cartItem } = buildMobileCartItem({ planId: plan.id });
    assert.equal(cartItem.bindingMonths, plan.bindingMonths);
    assert.equal(cartItem.rewardTotal, plan.rewardTotal);
    assert.doesNotMatch(cartItem.rewardMixLabel, /X{2,}/i);
    assert.throws(() => buildMobileCartItem({ planId: plan.id, rewards: { Apollo: 999999 } }), { statusCode: 400 });
  }
});

test('newsletter stays closed by default and records consent only after explicit enablement', (t) => {
  const keys = ['NEWSLETTER_SIGNUP_ENABLED', 'DEALETT_DATA_DIR', 'DEMO_MODE'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dealett-newsletter-test-'));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.DEALETT_DATA_DIR = directory;
  delete process.env.NEWSLETTER_SIGNUP_ENABLED;
  assert.equal(getNewsletterStatus().enabled, false);
  assert.throws(() => subscribeToNewsletter({ email: 'test@example.com', consent: true }), { statusCode: 503 });
  assert.equal(fs.readdirSync(directory).length, 0);
  process.env.NEWSLETTER_SIGNUP_ENABLED = 'true';
  process.env.DEMO_MODE = 'true';
  for (const request of [{ email: 'invalid', consent: true }, { email: 'test@example.com' }]) {
    assert.throws(() => subscribeToNewsletter(request), { statusCode: 400 });
  }
  const receipt = subscribeToNewsletter({ email: ' TEST@example.com ', consent: true });
  assert.deepEqual(receipt, { ok: true, simulated: true });
  assert.deepEqual(subscribeToNewsletter({ email: 'test@example.com', consent: true }), receipt);
  const file = path.join(directory, 'newsletter-subscribers.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].consent.granted, true);
  assert.equal(stored[0].consent.purpose, 'newsletter');
  fs.writeFileSync(file, '{corrupt');
  assert.throws(() => subscribeToNewsletter({ email: 'next@example.com', consent: true }), { statusCode: 503 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
});
