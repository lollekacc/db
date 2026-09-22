const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFeaturedCartItem, getFeaturedOffers } = require('./featured-offers');
const { buildAuthoritativeSnapshot } = require('./platform/service');
const { createServer } = require('./server');

const expected = [
  ['featured-family-4', 'Telia', 4, 1166, 4000],
  ['featured-family-3', 'Tele2', 3, 737, 3000],
  ['featured-duo-2', 'Tre', 2, 578, 2000],
  ['featured-single-1', 'Telenor', 1, 449, 1000],
];
for (const [id, operator, persons, price, reward] of expected) {
  test(`${id} uses authoritative package quantities, pricing and rewards`, () => {
    const { cartItem, state } = buildFeaturedCartItem({ offerId: id, persons: 99, price: 1, rewardTotal: 999999 });
    assert.equal(cartItem.operator, operator);
    assert.equal(cartItem.persons, persons);
    assert.equal(cartItem.phoneLines, persons);
    assert.equal(cartItem.price, price);
    assert.equal(cartItem.rewardTotal, reward);
    assert.equal(cartItem.minimumTotalCost, price * 24);
    assert.equal(state.persons, persons);
    assert.equal(cartItem.addon?.quantity || 0, persons - 1);
    const snapshot = buildAuthoritativeSnapshot({ cartItems: [{ ...cartItem, persons: 99, price: 1, monthlyPrice: 1, rewardTotal: 999999 }] });
    assert.equal(snapshot.totalSubscriptionCount, persons);
    assert.equal(snapshot.aggregateMonthlyValueMinor, price * 100);
    assert.equal(snapshot.aggregateGiftCardValueMinor, reward * 100);
    assert.equal(snapshot.selectedOffer.sourcePlanId, cartItem.sourcePlanId);
  });
}

test('unknown fixed offer cannot fall back to another package', () => {
  assert.throws(() => buildFeaturedCartItem({ offerId: 'missing' }), { statusCode: 404 });
  assert.equal(getFeaturedOffers().filter(offer => offer.available).length, 4);
});

test('public endpoints load fixed offers and reject invalid purchases', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const offers = await (await fetch(`${base}/api/featured-offers`)).json();
    assert.equal(offers.length, 4);
    for (const [offerId, , persons, price] of expected) {
      const response = await fetch(`${base}/api/featured-offers/cart-item`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offerId }),
      });
      assert.equal(response.status, 200);
      const { cartItem } = await response.json();
      assert.equal(cartItem.persons, persons);
      assert.equal(cartItem.price, price);
    }
    const missing = await fetch(`${base}/api/featured-offers/cart-item`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"offerId":"unknown"}',
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
