const assert = require('node:assert/strict');

const { calculateCost } = require('./cost-calculator');

const result = calculateCost({
  newMonthlyCost: 500,
  remainingOldCosts: 1200,
  giftCardValue: 2400,
  currentMonthlyCost: 700,
  selectedNeeds: [
    { key: 'streaming:netflix', covered: true, monthlyCost: 100 },
    { key: 'outside_eu_data', covered: false, occurrencesPerYear: 1, costPerOccurrence: 500 },
  ],
});

assert.equal(result.newCostForTerm, 12000);
assert.equal(result.baseOfferCostForTerm, 10800);
assert.equal(result.uncoveredNeedsCostForTerm, 1000);
assert.equal(result.matchingNeedsSavingsForTerm, 2400);
assert.equal(result.totalCostForTerm, 9400);
assert.equal(result.effectiveMonthlyCost, 391.67);
assert.equal(result.currentNeedsCostForTerm, 3400);
assert.equal(result.currentCostForTerm, 20200);
assert.equal(result.savingsForTerm, 10800);
assert.equal(result.effectiveMonthlySavings, 450);

const unknown = calculateCost({
  newMonthlyCost: 300,
  selectedNeeds: [{ key: 'extra_sim', covered: false }],
});
assert.equal(unknown.knownTotalCostForTerm, 7200);
assert.equal(unknown.totalCostForTerm, null);
assert.deepEqual(unknown.unknownUncoveredNeeds, ['extra_sim']);

console.log('cost calculator tests passed');
