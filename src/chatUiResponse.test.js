const assert = require('node:assert/strict');

const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
  normalizeQuickReplies,
} = require('./chat-ui-response');

assert.deepEqual(normalizeQuickReplies(['1', '2', '3', '4', '5+', 'Ignored']), [
  { id: '1', label: '1' },
  { id: '2', label: '2' },
  { id: '3', label: '3' },
  { id: '4', label: '4' },
  { id: '5', label: '5+' },
]);

assert.deepEqual(normalizeQuickReplies([{
  label: 'Nej, ingen av oss',
  qualificationPatch: {
    bindingEnds: Array(4).fill('Ingen bindningstid'),
    bindingAppliesToAll: true,
    unsafeField: 'ignored',
  },
}]), [{
  id: 'nej-ingen-av-oss',
  label: 'Nej, ingen av oss',
  qualificationPatch: {
    bindingEnds: Array(4).fill('Ingen bindningstid'),
    bindingAppliesToAll: true,
  },
}]);

assert.deepEqual(buildChatResponse({ message: 'Dynamic answer' }), {
  message: 'Dynamic answer',
  quickReplies: [],
  quickReplyMode: 'single',
  quickReplySubmitLabel: '',
  offerCards: [],
  embeddedWidget: null,
});

assert.deepEqual(buildChatResponse({
  message: 'Vilka streamingtjänster betalar du för?',
  quickReplyMode: 'multiple',
  quickReplySubmitLabel: 'Skicka val',
  quickReplies: [{
    label: 'Netflix',
    qualificationPatch: {
      streamingCalculation: 'include',
      streamingServices: ['netflix'],
    },
  }],
}), {
  message: 'Vilka streamingtjänster betalar du för?',
  quickReplies: [{
    id: 'netflix',
    label: 'Netflix',
    qualificationPatch: {
      streamingCalculation: 'include',
      streamingServices: ['netflix'],
    },
  }],
  quickReplyMode: 'multiple',
  quickReplySubmitLabel: 'Skicka val',
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
    pricePerPerson: 299,
    effectiveMonthlyCost: 656,
    effectivePricePerPerson: 164,
    peopleCount: 4,
    monthlySavings: 944,
    bindingMonths: 24,
    giftCardReason: 'New-customer gift-card tier.',
    benefits: ['Travel data', 'EU roaming', 'Extra SIM', 'Unlimited calls'],
    tradeoffs: ['Local calls cost extra.', 'TV4 is not included.'],
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
assert.equal(cards[0].monthlyPriceLabel, 'SEK 299/person');
assert.equal(cards[0].effectiveCostLabel, 'SEK 164/person');
assert.deepEqual(cards[0].benefits, [
  'Streaming replacement',
  'New-customer gift-card tier.',
  'Travel data',
  'Trade-off: Local calls cost extra.',
  'Trade-off: TV4 is not included.',
]);

console.log('chat UI response tests passed');
