const assert = require('node:assert/strict');

const { selectBestMatches } = require('./best-match');

const candidate = (overrides) => ({
  id: overrides.operator,
  operatorId: overrides.operator.toLowerCase(),
  operator: overrides.operator,
  planMonthlyPrice: 500,
  effectiveMonthlyCost: 500,
  bindingMonths: 24,
  international: {},
  extraSim: {},
  replacedStreamingServices: [],
  streamingSavings: 0,
  ...overrides,
});

const tele2 = candidate({
  operator: 'Tele2',
  international: { outsideEuData: true, outsideEuLocalCalls: false, countries: 170, internationalDataGb: 60 },
  extraSim: { included: true, dataGb: 50 },
});
const tre = candidate({
  operator: 'Tre',
  effectiveMonthlyCost: 450,
  international: { outsideEuData: true, outsideEuLocalCalls: true, countries: 100, internationalDataGb: 0 },
});
const telia = candidate({ operator: 'Telia', effectiveMonthlyCost: 400 });
const telenor = candidate({
  operator: 'Telenor',
  effectiveMonthlyCost: 600,
  extraSim: { available: true, included: false, dataGb: null },
});

assert.equal(selectBestMatches([tele2, tre, telia], {
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
}).bestMatch.operator, 'Tele2');

assert.equal(selectBestMatches([tele2, tre, telia], {
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
}).bestMatch.operator, 'Tre');

const extraSimMatches = selectBestMatches([tele2, tre, telia, telenor], {
  extraSimRequired: true,
});
assert.deepEqual(extraSimMatches.eligible.map((option) => option.operator), ['Tele2', 'Telenor']);
assert.equal(extraSimMatches.bestMatch.operator, 'Tele2');

assert.equal(selectBestMatches([tele2, tre, telia], {}).lowestEffectiveCost.operator, 'Telia');

console.log('best match tests passed');
