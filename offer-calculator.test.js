const assert = require('node:assert/strict');

const { calculateOfferOptions } = require('./offer-calculator');
const { getPlanCatalog } = require('./offer-service');
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

const catalog = getPlanCatalog();
const treCatalog = catalog.operators.find((operator) => operator.id === 'tre');
const brandedTrePlans = treCatalog.plans.filter((plan) => plan.roaming?.serviceName === '3Världen');
assert.deepEqual(brandedTrePlans.map((plan) => plan.id), ['tre-6gb', 'tre-25gb', 'tre-unlimited']);
assert.ok(brandedTrePlans.every((plan) => (
  plan.roaming.internationalDataCountries === 100 &&
  plan.roaming.maximumConsecutiveDays === 30
)));
assert.ok(catalog.operators
  .filter((operator) => operator.id !== 'tre')
  .flatMap((operator) => operator.plans)
  .every((plan) => !plan.roaming?.serviceName));

const assertFeaturedPlanIds = (calculation, expectedPlanIds) => {
  const planIds = calculation.featuredOffers.map((offer) => offer.planId);
  assert.equal(planIds.length, 2);
  assert.equal(new Set(planIds).size, 2);
  assert.deepEqual(planIds, expectedPlanIds);
  assert.deepEqual(
    [calculation.bestMatch?.planId, calculation.secondaryOffer?.planId],
    expectedPlanIds
  );
};

const individual = calculate({});
assert.equal(individual.options.length, 4);
assert.equal(individual.bestMatch.operator, 'Tre');
assert.equal(individual.lowestEffectiveCost.operator, 'Tre');
assert.equal('bestValue' in individual, false);
assert.equal('lowestMonthlyPrice' in individual, false);
assert.equal(individual.bestMatch.effectiveMonthlyCost, 329);
assert.equal(individual.bestMatch.international.serviceName, '3Världen');
assert.ok(individual.bestMatch.benefits.includes('3Världen ingår'));
assertFeaturedPlanIds(individual, ['tre-25gb', 'telenor-25gb']);
assert.equal(individual.featuredOffers[1].strictMatch, true);
assert.equal(individual.featuredOffers[1].recommendationType, 'next_best_match');

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

for (const remainingBindingMonths of [0, 24]) {
  const mixedDataNeeds = calculate({
    peopleCount: 2,
    operators: ['Annan / ingen', 'Annan / ingen'],
    bindingEnds: ['Ingen bindningstid', 'Ingen bindningstid'],
    people: [
      { dataNeed: 'low', currentMonthlyCost: 500, remainingBindingMonths: 0 },
      { dataNeed: 'high', requiredDataGb: null, currentMonthlyCost: 100, remainingBindingMonths },
    ],
  });
  assert.equal(mixedDataNeeds.featuredOffers.length, 2);
  assert.ok(mixedDataNeeds.featuredOffers.some((offer) => offer.dataType === 'unlimited'));
  if (remainingBindingMonths === 24) {
    assert.equal(mixedDataNeeds.bestMatch.dataType, 'limited');
    assert.equal(mixedDataNeeds.secondaryOffer.dataType, 'unlimited');
  }
}

const unlimitedWithSmallerPersonAllowances = calculate({
  peopleCount: 2,
  operators: ['Annan / ingen', 'Annan / ingen'],
  bindingEnds: ['Ingen bindningstid', 'Ingen bindningstid'],
  mobileUsage: 'high',
  people: [{ dataNeed: 'low', requiredDataGb: 10 }, { dataNeed: 'medium', requiredDataGb: 20 }],
});
assert.ok(unlimitedWithSmallerPersonAllowances.featuredOffers.some((offer) => offer.dataType === 'unlimited'));

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
assertFeaturedPlanIds(streaming, [
  'telia-unlimited-plus-streaming-bundle',
  'tre-unlimited',
]);

const internationalData = calculate({
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
});
assert.deepEqual(internationalData.options.map((option) => option.operator), ['Tele2', 'Tre']);
assert.equal(internationalData.bestMatch.operator, 'Tele2');
assert.equal(internationalData.bestMatch.match.internationalDataCountries, 170);
assert.equal(internationalData.lowestEffectiveCost.operator, 'Tele2');
assertFeaturedPlanIds(internationalData, ['tele2-unlimited-plus', 'tre-unlimited']);
assert.ok(internationalData.featuredOffers.every((offer) => offer.strictMatch));
assert.equal(internationalData.secondaryOffer.international.serviceName, '3Världen');
assert.equal(internationalData.secondaryOffer.international.internationalDataGb, 60);

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
assert.deepEqual(internationalCalls.secondaryOffer.relaxedRequirements, ['international_calls']);
assertFeaturedPlanIds(internationalCalls, ['tre-unlimited', 'tele2-unlimited-plus']);

const internationalCallsWithTwoStrictPlans = calculate({
  mobileUsage: 'medium',
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assertFeaturedPlanIds(internationalCallsWithTwoStrictPlans, ['tre-25gb', 'tre-unlimited']);
assert.ok(internationalCallsWithTwoStrictPlans.featuredOffers.every((offer) => offer.strictMatch));

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
assertFeaturedPlanIds(internationalCallsMustHave, ['tre-unlimited', 'tele2-unlimited-plus']);
assert.equal(internationalCallsMustHave.secondaryOffer.strictMatch, false);
assert.deepEqual(internationalCallsMustHave.secondaryOffer.relaxedRequirements, [
  'international_calls',
]);
assert.deepEqual(internationalCallsMustHave.secondaryOffer.unmetMustHaveRequirements, [
  'international_calls',
]);

const worldwideFamilyCalls = calculate({
  peopleCount: 2,
  operators: Array(2).fill('Annan / ingen'),
  bindingEnds: Array(2).fill('Ingen bindningstid'),
  mobileUsage: 'high',
  internationalTravel: 'outside_eu',
  internationalUsage: 'family_calls',
});
assert.deepEqual(worldwideFamilyCalls.options.map((option) => option.operator), ['Telenor']);
assert.equal(worldwideFamilyCalls.bestMatch.sourcePlanId, 'telenor-unlimited-plus');
assert.ok(worldwideFamilyCalls.bestMatch.match.matchedCapabilities.includes('worldwide_family_calls'));

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
assertFeaturedPlanIds(internationalCallsWithStreaming, [
  'tre-unlimited',
  'telia-unlimited-plus-streaming-bundle',
]);
assert.equal(internationalCallsWithStreaming.secondaryOffer.strictMatch, false);
assert.deepEqual(internationalCallsWithStreaming.secondaryOffer.relaxedRequirements, [
  'outside_eu_data',
  'international_calls',
]);

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

const flexibleFallback = calculate({
  mobileUsage: 'high',
  extraSimRequired: true,
  internationalTravel: 'outside_eu',
  internationalUsage: 'calls',
});
assert.equal(flexibleFallback.validOfferAvailable, true);
assert.equal(flexibleFallback.strictOfferAvailable, false);
assert.equal(flexibleFallback.options.length, 0);
assertFeaturedPlanIds(flexibleFallback, ['tele2-unlimited-plus', 'tre-unlimited']);
assert.ok(flexibleFallback.featuredOffers.every((offer) => offer.strictMatch === false));
assert.deepEqual(flexibleFallback.featuredOffers[0].relaxedRequirements, [
  'international_calls',
]);
assert.deepEqual(flexibleFallback.featuredOffers[1].relaxedRequirements, ['extra_sim']);

console.log('offer calculator tests passed');
