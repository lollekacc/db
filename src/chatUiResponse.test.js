const assert = require('node:assert/strict');

const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
  normalizeEmbeddedWidget,
  normalizeQuickReplies,
} = require('./chat-ui-response');

assert.deepEqual(normalizeQuickReplies(['1', '2', '3', '4', '5+', 'Ignored']), [
  { id: '1', label: '1', action: 'send_message' },
  { id: '2', label: '2', action: 'send_message' },
  { id: '3', label: '3', action: 'send_message' },
  { id: '4', label: '4', action: 'send_message' },
  { id: '5', label: '5+', action: 'send_message' },
]);

assert.deepEqual(normalizeQuickReplies([{
  label: 'Open support',
  action: 'open_contact',
}]), [{
  id: 'open-support',
  label: 'Open support',
  action: 'open_contact',
}]);

assert.deepEqual(buildChatResponse({ message: 'Dynamic answer' }), {
  message: 'Dynamic answer',
  quickReplies: [],
  quickReplyMode: 'single',
  quickReplySubmitLabel: '',
  offerCards: [],
  embeddedWidget: null,
});

const streamingWidget = {
  type: 'streaming_prices',
  services: [
    { id: 'netflix', label: 'Netflix', priceLabel: 'Pris per månad', pricePlaceholder: 'kr/mån' },
    { id: 'hbo', label: 'HBO Max', priceLabel: 'Pris per månad', pricePlaceholder: 'kr/mån' },
    { id: 'disney', label: 'Disney+', priceLabel: 'Pris per månad', pricePlaceholder: 'kr/mån' },
    { id: 'unknown', label: 'Unknown', priceLabel: 'Price', pricePlaceholder: 'SEK' },
  ],
  noneLabel: 'Inga av dessa',
  submitLabel: 'Fortsätt',
  missingPriceLabel: 'Pris saknas',
};
assert.equal(normalizeEmbeddedWidget(streamingWidget).services.length, 3);
assert.deepEqual(buildChatResponse({
  message: 'Vilka tjänster betalar du för?',
  embeddedWidget: streamingWidget,
}).embeddedWidget, normalizeEmbeddedWidget(streamingWidget));

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
    action: 'send_message',
  }],
  quickReplyMode: 'multiple',
  quickReplySubmitLabel: 'Skicka val',
  offerCards: [],
  embeddedWidget: null,
});

const cards = buildOfferCardsFromOfferCalculation({
  validOfferAvailable: true,
  bestMatch: {
    planId: 'telia-best',
    operator: 'Telia',
    title: 'Unlimited streaming',
    data: 'Unlimited',
    planMonthlyPrice: 1196,
    effectiveMonthlyCost: 656,
    monthlySavings: 944,
    peopleCount: 2,
    pricePerPerson: 598,
    bindingMonths: 24,
  },
  lowestEffectiveCost: {
    planId: 'tre-low',
    operator: 'Tre',
    title: 'Unlimited',
    data: 'Unlimited',
    planMonthlyPrice: 876,
    effectiveMonthlyCost: 876,
    monthlySavings: 724,
    peopleCount: 2,
    pricePerPerson: 438,
    bindingMonths: 24,
  },
}, {
  language: 'en',
  copy: {
    bestMatchReason: 'The included services replace current costs.',
    lowestEffectiveCostReason: 'This has the lowest effective cost.',
    bestMatchBenefits: [
      'SEK 1,196/month for two people',
      'SEK 598/person/month',
      'Save SEK 944/month compared with today',
      '24 months binding',
      'Streaming replacement',
    ],
    lowestEffectiveCostBenefits: ['Lower effective cost'],
    offerCardCopy: {
      bestMatchLabel: 'Best match',
      lowestEffectiveCostLabel: 'Lowest effective cost',
      dataTitle: 'Data',
      monthlyPriceTitle: 'Monthly price',
      perPersonPriceTitle: 'Price per person',
      totalPriceTitle: 'Total price',
      bindingTitle: 'Binding',
      perMonthSuffix: '/month',
      perPersonSuffix: '/person/month',
      bindingMonthsSuffix: ' months binding',
      rewardLabel: 'Gift card: XXX SEK',
      ctaLabel: 'Choose offer',
    },
  },
});

assert.equal(cards.length, 2);
assert.deepEqual(cards.map((card) => card.resultLabel), ['Best match', 'Lowest effective cost']);
assert.equal(cards[0].reason, 'The included services replace current costs.');
assert.equal(cards[0].rewardLabel, 'Gift card: XXX SEK');
assert.equal(cards[0].monthlyPriceTitle, 'Price per person');
assert.equal(cards[0].monthlyPriceLabel, 'SEK 598/person/month');
assert.equal(cards[0].monthlyPriceSubLabel, 'Total price: SEK 1,196/month');
assert.deepEqual(cards[0].benefits, [
  'Save SEK 944/month compared with today',
  'Streaming replacement',
]);

console.log('chat UI response tests passed');
