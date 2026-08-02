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
assert.equal(individual.lowestMonthlyPrice.operator, 'Tele2');
assert.equal(individual.bestValue.planMonthlyPrice, 249);
assert.equal(individual.bestValue.effectiveMonthlyCost, 249);

const family = calculate({
  peopleCount: 4,
  operators: Array(4).fill('Annan / ingen'),
  bindingEnds: Array(4).fill('Ingen bindningstid'),
  exactMonthlyPrice: 350,
});
assert.equal(family.options.length, 4);
assert.equal(family.bestValue.operator, 'Tele2');
assert.equal(family.bestValue.planMonthlyPrice, 756);
assert.equal(family.lowestMonthlyPrice.operator, 'Tele2');
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
assert.equal(teliaStreaming.bestValue.planMonthlyPrice, 1196);
assert.equal(teliaStreaming.bestValue.averageMonthlyPlanCost, 1306);
assert.equal(teliaStreaming.bestValue.streamingSavings, 650);
assert.equal(teliaStreaming.bestValue.effectiveMonthlyCost, 656);
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
assert.deepEqual(outsideEuCalls.options.map((option) => option.operator), ['Tre']);
assert.equal(outsideEuCalls.bestValue.operator, 'Tre');

const outsideEuData = calculate({
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
});
assert.deepEqual(new Set(outsideEuData.options.map((option) => option.operator)), new Set(['Tele2', 'Tre']));

const sharedData = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  requiredDataGb: 20,
});
assert.equal(sharedData.options.find((option) => option.operator === 'Telenor').dataType, 'unlimited');
assert.equal(sharedData.options.find((option) => option.operator === 'Tre').dataType, 'unlimited');
assert.equal(sharedData.options.find((option) => option.operator === 'Tele2').dataAmount, 30);

console.log('offer-calculator tests passed');
