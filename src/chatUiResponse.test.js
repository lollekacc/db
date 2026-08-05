const assert = require('node:assert/strict');

const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
  normalizeQuickReplies,
} = require('./chat-ui-response');

assert.deepEqual(normalizeQuickReplies(['Compare', 'Compare', '', 'Show all']), [
  { id: 'compare', label: 'Compare' },
  { id: 'compare', label: 'Compare' },
  { id: 'show-all', label: 'Show all' },
]);

assert.deepEqual(buildChatResponse({ message: 'Dynamic answer' }), {
  message: 'Dynamic answer',
  quickReplies: [],
  offerCards: [],
  embeddedWidget: null,
});

const cards = buildOfferCardsFromOfferCalculation({
  validOfferAvailable: true,
  bestValue: {
    planId: 'telia-best',
    operator: 'Telia',
    title: 'Unlimited streaming',
    data: 'Unlimited',
    planMonthlyPrice: 1196,
    effectiveMonthlyCost: 656,
    monthlySavings: 944,
    bindingMonths: 24,
  },
  lowestMonthlyPrice: {
    planId: 'tre-low',
    operator: 'Tre',
    title: 'Unlimited',
    data: 'Unlimited',
    planMonthlyPrice: 876,
    effectiveMonthlyCost: 876,
    monthlySavings: 724,
    bindingMonths: 24,
  },
}, {
  language: 'en',
  copy: {
    bestValueReason: 'The included services replace current costs.',
    lowestPriceReason: 'This has the lowest bill.',
    bestValueBenefits: ['Streaming replacement'],
    lowestPriceBenefits: ['Lower subscription price'],
  },
});

assert.equal(cards.length, 2);
assert.deepEqual(cards.map((card) => card.resultLabel), ['Best value', 'Lowest monthly price']);
assert.equal(cards[0].reason, 'The included services replace current costs.');
assert.equal(cards[0].rewardLabel, 'Gift card: XXX SEK');
assert.deepEqual(cards[0].benefits, ['Streaming replacement']);

console.log('chat UI response tests passed');
