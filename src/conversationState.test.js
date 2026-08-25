const assert = require('node:assert/strict');

const { mergeQualificationState } = require('./conversation-state');

const merged = mergeQualificationState({
  peopleCount: 2,
  operators: ['Telia', 'Telia'],
  bindingEnds: [],
  streamingMonthlyCosts: { netflix: 100 },
  operatorAppliesToAll: true,
}, {
  mobileUsage: 'high',
  bindingEnds: ['2027-01-01', '2027-02-01'],
  streamingMonthlyCosts: { hbo: 50 },
  bindingAppliesToAll: true,
});

assert.equal(merged.peopleCount, 2);
assert.equal(merged.mobileUsage, 'high');
assert.deepEqual(merged.operators, ['Telia', 'Telia']);
assert.deepEqual(merged.bindingEnds, ['2027-01-01', '2027-02-01']);
assert.deepEqual(merged.streamingMonthlyCosts, { netflix: 100, hbo: 50 });
assert.equal(merged.operatorAppliesToAll, true);
assert.equal(merged.bindingAppliesToAll, false);

console.log('conversation state tests passed');
