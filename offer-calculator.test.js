const assert = require('node:assert/strict');

const { calculateOfferOptions } = require('./offer-calculator');
const { normalizeQualification } = require('./qualification-service');

const qualify = (overrides = {}) => normalizeQualification({
  peopleCount: 1,
  operators: ['Annan / ingen'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'medium',
  exactMonthlyPrice: 500,
  streamingCalculation: 'none',
  streamingServices: [],
  streamingMonthlyCosts: {},
  internationalTravel: 'none',
  ...overrides,
});

const calculate = (overrides) => calculateOfferOptions(qualify(overrides));

const individual = calculate({});
assert.equal(individual.options.length, 4);
assert.equal(individual.bestValue.operator, 'Tele2');
assert.equal(individual.lowestMonthlyPrice.operator, 'Tre');
assert.notEqual(individual.bestValue.planId, individual.lowestMonthlyPrice.planId);
assert.equal(individual.bestValue.planMonthlyPrice, 329);
assert.equal(individual.bestValue.effectiveMonthlyCost, 329);
assert.equal(individual.bestValue.giftCard, 'XXX');
assert.equal(individual.bestValue.giftCardLabel, 'XXX kr');
assert.equal(individual.bestValue.giftCardTier, 'maximum');
assert.equal(individual.bestValue.giftCardEligible, true);
assert.ok(individual.options.every((option) => option.eligibleForOffer));
assert.ok(individual.options.every((option) => option.tradeoffs.length > 0));
assert.match(individual.lowestMonthlyPrice.tradeoffs[0], /lägsta ordinarie pris/i);

const family = calculate({
  peopleCount: 4,
  operators: Array(4).fill('Annan / ingen'),
  bindingEnds: Array(4).fill('Ingen bindningstid'),
  exactMonthlyPrice: 350,
});
assert.equal(family.options.length, 4);
assert.equal(family.bestValue.operator, 'Tele2');
assert.equal(family.bestValue.planMonthlyPrice, 836);
assert.equal(family.lowestMonthlyPrice.operator, 'Tre');
assert.notEqual(family.bestValue.planId, family.lowestMonthlyPrice.planId);
assert.ok(family.options.every((option) => option.familyEligible));

const teliaStreaming = calculate({
  peopleCount: 4,
  operators: Array(4).fill('Annan / ingen'),
  bindingEnds: Array(4).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  exactMonthlyPrice: 400,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'hbo', 'disney'],
  streamingMonthlyCosts: { netflix: 250, hbo: 200, disney: 200 },
});
assert.equal(teliaStreaming.bestValue.operator, 'Telia');
assert.equal(teliaStreaming.bestValue.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
assert.equal(teliaStreaming.bestValue.planMonthlyPrice, 1416);
assert.equal(teliaStreaming.bestValue.averageMonthlyPlanCost, 1416);
assert.equal(teliaStreaming.bestValue.streamingSavings, 650);
assert.equal(teliaStreaming.bestValue.effectiveMonthlyCost, 766);
assert.equal(teliaStreaming.bestValue.current24MonthCost, 38_400);
assert.equal(teliaStreaming.bestStreamingFit.operator, 'Telia');
assert.equal(teliaStreaming.bestStreamingFit.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
assert.equal(teliaStreaming.lowestMonthlyPrice.operator, 'Tre');
assert.equal(teliaStreaming.lowestMonthlyPrice.planMonthlyPrice, 876);

const includedOnly = calculate({
  peopleCount: 1,
  operators: ['Annan / ingen'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'tv4'],
  streamingMonthlyCosts: { netflix: 160, tv4: 500 },
});
const teliaIncludedOnly = includedOnly.options.find((option) => option.operator === 'Telia');
assert.equal(teliaIncludedOnly.streamingSavings, 500);
assert.deepEqual(teliaIncludedOnly.replacedStreamingServices.map((service) => service.key), ['tv4']);

const noCustomerCost = calculate({
  mobileUsage: 'high',
  streamingCalculation: 'include',
  streamingServices: ['netflix'],
  streamingMonthlyCosts: {},
});
assert.equal(noCustomerCost.options.find((option) => option.operator === 'Telia').streamingSavings, 0);
assert.notEqual(noCustomerCost.bestValue.operator, 'Telia');

const outsideEuCalls = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(outsideEuCalls.options.length, 4);
assert.equal(outsideEuCalls.bestValue.operator, 'Tre');
assert.equal(outsideEuCalls.bestTravelFit.operator, 'Tre');
assert.equal(outsideEuCalls.bestTravelFit.travelMatch, true);
assert.ok(outsideEuCalls.options.filter((option) => option.travelMatch).every((option) => option.operator === 'Tre'));
assert.ok(outsideEuCalls.options.find((option) => option.operator === 'Tele2').tradeoffs.some((tradeoff) => (
  tradeoff.includes('Lokala samtal')
)));

const outsideEuData = calculate({
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
});
assert.equal(outsideEuData.options.length, 4);
assert.equal(outsideEuData.bestTravelFit.travelMatch, true);
assert.deepEqual(
  new Set(outsideEuData.options.filter((option) => option.travelMatch).map((option) => option.operator)),
  new Set(['Tre'])
);

const streamingTravelTradeoff = calculate({
  mobileUsage: 'high',
  priceRange: '400-500',
  exactMonthlyPrice: null,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'hbo', 'disney'],
  streamingMonthlyCosts: { netflix: 150, hbo: 150, disney: 150 },
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(streamingTravelTradeoff.bestValue.operator, 'Telia');
assert.equal(streamingTravelTradeoff.bestValue.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
assert.equal(streamingTravelTradeoff.bestValue.streamingSavings, 450);
assert.equal(streamingTravelTradeoff.bestValue.travelMatch, false);
assert.ok(streamingTravelTradeoff.bestValue.tradeoffs.some((tradeoff) => tradeoff.includes('Utanför EU/EES')));
assert.equal(streamingTravelTradeoff.bestStreamingFit.operator, 'Telia');
assert.equal(streamingTravelTradeoff.bestStreamingFit.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
assert.equal(streamingTravelTradeoff.bestTravelFit.operator, 'Tre');
assert.equal(streamingTravelTradeoff.bestTravelFit.travelMatch, true);
assert.ok(streamingTravelTradeoff.bestTravelFit.tradeoffs.some((tradeoff) => tradeoff.includes('streamingkostnader')));

const familyStreamingTravelTradeoff = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  mobileUsage: 'low',
  priceRange: 'under300',
  exactMonthlyPrice: null,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'hbo', 'disney'],
  streamingMonthlyCosts: { netflix: 150, hbo: 150, disney: 150 },
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(familyStreamingTravelTradeoff.bestTravelFit.operator, 'Tre');
assert.equal(familyStreamingTravelTradeoff.bestStreamingFit.operator, 'Telia');
assert.notEqual(
  familyStreamingTravelTradeoff.bestTravelFit.planId,
  familyStreamingTravelTradeoff.bestStreamingFit.planId
);

const sharedData = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  requiredDataGb: 20,
});
assert.equal(sharedData.options.find((option) => option.operator === 'Telenor').dataType, 'unlimited');
assert.equal(sharedData.options.find((option) => option.operator === 'Tre').dataType, 'unlimited');
assert.equal(sharedData.options.find((option) => option.operator === 'Tele2').dataAmount, 30);

const longBindingBadSwitch = calculate({
  peopleCount: 1,
  people: [{
    currentOperator: 'Tele2',
    currentMonthlyCost: 150,
    remainingBindingMonths: 12,
    noticePeriodMonths: 1,
    dataNeed: 'medium',
    keepNumberPreference: 'scheduled_port',
  }],
  operators: ['Tele2'],
  bindingEnds: ['Vet inte'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.equal(longBindingBadSwitch.validOfferAvailable, false);
assert.equal(longBindingBadSwitch.bestValue, null);
assert.match(longBindingBadSwitch.noOfferReason, /Tele2 kräver högst 2 månader/);

const shortBindingReady = calculate({
  peopleCount: 1,
  people: [{
    currentOperator: 'Tele2',
    currentMonthlyCost: 700,
    remainingBindingMonths: 2,
    noticePeriodMonths: 1,
    dataNeed: 'high',
    keepNumberPreference: 'port_number',
    numberOwnerConfirmed: true,
  }],
  operators: ['Tele2'],
  bindingEnds: ['Vet inte'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.notEqual(shortBindingReady.bestValue.switchAction, 'delay_switch');
assert.equal(shortBindingReady.bestValue.eligibleForOffer, true);
assert.equal(shortBindingReady.bestValue.remainingOldCosts, 1400);
assert.ok(shortBindingReady.bestValue.total24MonthResult > 0);

const threeMonthsRemaining = calculate({
  peopleCount: 1,
  people: [{
    currentOperator: 'Annan / ingen',
    currentMonthlyCost: 700,
    remainingBindingMonths: 3,
    dataNeed: 'high',
    keepNumberPreference: 'port_number',
  }],
  operators: ['Annan / ingen'],
  bindingEnds: ['Vet inte'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.ok(!threeMonthsRemaining.options.some((option) => option.operator === 'Tele2'));
assert.deepEqual(
  new Set(threeMonthsRemaining.options.map((option) => option.operator)),
  new Set(['Telia', 'Telenor', 'Tre'])
);
assert.ok(threeMonthsRemaining.options.every((option) => option.salesWindowMonths === 3));

const fourMonthsRemaining = calculate({
  peopleCount: 1,
  people: [{
    currentOperator: 'Annan / ingen',
    currentMonthlyCost: 700,
    remainingBindingMonths: 4,
    dataNeed: 'high',
    keepNumberPreference: 'scheduled_port',
  }],
  operators: ['Annan / ingen'],
  bindingEnds: ['Vet inte'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.equal(fourMonthsRemaining.validOfferAvailable, false);

const unknownBinding = calculate({
  peopleCount: 1,
  operators: ['Telia'],
  bindingEnds: ['Vet inte'],
  exactMonthlyPrice: 700,
});
assert.equal(unknownBinding.validOfferAvailable, false);
assert.match(unknownBinding.noOfferReason, /säljfönster/);

const sameOperatorGiftCard = calculate({ operators: ['Tele2'] });
assert.equal(sameOperatorGiftCard.options.find((option) => option.operator === 'Tele2').giftCardTier, 'lower');
assert.equal(sameOperatorGiftCard.options.find((option) => option.operator === 'Tele2').giftCardEligible, true);
assert.ok(sameOperatorGiftCard.options
  .filter((option) => option.operator !== 'Tele2')
  .every((option) => option.giftCardTier === 'maximum'));

const mixedFamily = calculate({
  peopleCount: 3,
  people: [
    { currentOperator: 'Tele2', currentMonthlyCost: 600, remainingBindingMonths: 0, dataNeed: 'high', keepNumberPreference: 'port_number' },
    { currentOperator: 'Telia', currentMonthlyCost: 150, remainingBindingMonths: 14, dataNeed: 'high', keepNumberPreference: 'scheduled_port' },
    { currentOperator: 'Tre', currentMonthlyCost: 150, remainingBindingMonths: 18, dataNeed: 'high', keepNumberPreference: 'scheduled_port' },
  ],
  operators: ['Tele2', 'Telia', 'Tre'],
  bindingEnds: ['Ingen bindningstid', 'Vet inte', 'Vet inte'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.equal(mixedFamily.bestValue.switchAction, 'switch_some_now');
assert.equal(mixedFamily.bestValue.switchNowPeopleCount, 1);
assert.equal(mixedFamily.bestValue.delayedPeopleCount, 2);
assert.equal(mixedFamily.bestValue.pricePerPerson, mixedFamily.bestValue.planMonthlyPrice);
assert.equal(mixedFamily.options.find((option) => option.operator === 'Tele2').giftCardTier, 'lower');
assert.ok(mixedFamily.options
  .filter((option) => option.operator !== 'Tele2')
  .every((option) => option.giftCardTier === 'maximum'));

const allOperatorsVisible = calculate({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  exactMonthlyPrice: 700,
  mobileUsage: 'high',
});
assert.equal(allOperatorsVisible.options.length, 4);
assert.ok(allOperatorsVisible.bestValue.total24MonthCost > 0);
assert.ok(allOperatorsVisible.lowestMonthlyPrice);

console.log('offer-calculator tests passed');
