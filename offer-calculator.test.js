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
assert.equal(individual.bestMatch.operator, 'Tre');
assert.equal(individual.lowestEffectiveCost.operator, 'Tre');
assert.equal('bestValue' in individual, false);
assert.equal('lowestMonthlyPrice' in individual, false);
assert.equal(individual.bestMatch.effectiveMonthlyCost, 329);

const family = calculate({
  peopleCount: 4,
  operators: Array(4).fill('Annan / ingen'),
  bindingEnds: Array(4).fill('Ingen bindningstid'),
  exactMonthlyPrice: 350,
});
assert.equal(family.options.length, 4);
assert.equal(family.bestMatch.operator, 'Tre');
assert.equal(family.bestMatch.planMonthlyPrice, 876);
assert.equal(family.lowestEffectiveCost.operator, 'Tre');
assert.ok(family.options.every((option) => option.familyEligible));

const streaming = calculate({
  peopleCount: 4,
  operators: Array(4).fill('Annan / ingen'),
  bindingEnds: Array(4).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  exactMonthlyPrice: 400,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'hbo', 'disney'],
  streamingMonthlyCosts: { netflix: 250, hbo: 200, disney: 200 },
});
assert.equal(streaming.bestMatch.operator, 'Telia');
assert.equal(streaming.bestMatch.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
assert.equal(streaming.bestMatch.planMonthlyPrice, 1296);
assert.equal(streaming.bestMatch.streamingSavings, 650);
assert.equal(streaming.bestMatch.effectiveMonthlyCost, 646);

const internationalData = calculate({
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
});
assert.deepEqual(internationalData.options.map((option) => option.operator), ['Tele2', 'Tre']);
assert.equal(internationalData.bestMatch.operator, 'Tele2');
assert.equal(internationalData.bestMatch.match.internationalDataCountries, 170);
assert.equal(internationalData.lowestEffectiveCost.operator, 'Tele2');

const internationalCalls = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.deepEqual(internationalCalls.options.map((option) => option.operator), ['Tre']);
assert.equal(internationalCalls.bestMatch.operator, 'Tre');
assert.ok(internationalCalls.bestMatch.match.matchedCapabilities.includes('local_calls_abroad'));
assert.equal(internationalCalls.secondaryOffer.operator, 'Tele2');
assert.equal(internationalCalls.secondaryOffer.recommendationType, 'lowest_cost_alternative');
assert.deepEqual(internationalCalls.secondaryOffer.relaxedRequirements, [
  'outside_eu_data',
  'international_calls',
]);

const internationalCallsMustHave = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
  needImportance: {
    outsideEuData: 'must_have',
    internationalCalls: 'must_have',
  },
});
assert.equal(internationalCallsMustHave.bestMatch.operator, 'Tre');
assert.equal(internationalCallsMustHave.secondaryOffer, null);

const internationalCallsWithStreaming = calculate({
  peopleCount: 1,
  operators: ['Annan / ingen'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'hbo', 'disney'],
  streamingMonthlyCosts: { netflix: 179, hbo: 129, disney: 119 },
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(internationalCallsWithStreaming.bestMatch.operator, 'Tre');
assert.equal(internationalCallsWithStreaming.secondaryOffer.operator, 'Telia');
assert.equal(
  internationalCallsWithStreaming.secondaryOffer.sourcePlanId,
  'telia-unlimited-plus-streaming-bundle'
);
assert.equal(
  internationalCallsWithStreaming.secondaryOffer.recommendationType,
  'best_streaming_alternative'
);
assert.ok(internationalCallsWithStreaming.secondaryOffer.streamingSavings > 0);

const extraSim = calculate({
  mobileUsage: 'high',
  extraSimRequired: true,
});
assert.deepEqual(extraSim.options.map((option) => option.operator), ['Tele2', 'Telenor']);
assert.equal(extraSim.bestMatch.planId, 'tele2-unlimited-plus');
assert.equal(extraSim.lowestEffectiveCost.planId, 'tele2-unlimited-plus');
assert.equal(extraSim.bestMatch.extraSim.dataGb, 50);
assert.equal(extraSim.options.find((option) => option.operator === 'Telenor').extraSim.available, true);

const bindingOverlap = calculate({
  people: [{
    currentOperator: 'Tele2',
    currentMonthlyCost: 150,
    remainingBindingMonths: 12,
    noticePeriodMonths: 1,
    dataNeed: 'medium',
    keepNumberPreference: 'scheduled_port',
  }],
  operators: ['Tele2'],
  bindingEnds: ['2027-08-27'],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  priceRange: null,
});
assert.equal(bindingOverlap.bestMatch.remainingOldCosts, 1800);
assert.equal(bindingOverlap.bestMatch.new24MonthPlanCost, 7896);
assert.equal(bindingOverlap.bestMatch.total24MonthCost, 9696);
assert.equal(bindingOverlap.bestMatch.effectiveMonthlyCost, 404);
assert.equal(bindingOverlap.bestMatch.switchAction, 'delay_switch');

const unavailable = calculate({
  mobileUsage: 'high',
  extraSimRequired: true,
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(unavailable.validOfferAvailable, false);
assert.equal(unavailable.bestMatch, null);

console.log('offer calculator tests passed');
