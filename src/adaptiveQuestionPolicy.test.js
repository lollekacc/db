const assert = require('node:assert/strict');

const { normalizeQualification } = require('../qualification-service');
const { getAdaptiveQuestionPlan } = require('./adaptive-question-policy');

const recommendationAnalysis = (overrides = {}) => ({
  recommendationRequested: true,
  topic: 'mobile plan comparison',
  desiredOutcome: 'find a suitable mobile plan',
  ...overrides,
});

const incomplete = normalizeQualification({});

const priceComplaint = getAdaptiveQuestionPlan({
  message: 'Jag betalar alldeles för mycket för mitt abonnemang',
  analysis: recommendationAnalysis({ desiredOutcome: 'lower my monthly cost' }),
  qualification: incomplete,
});
assert.equal(priceComplaint.qualificationField, 'priceRange');
assert.equal(priceComplaint.focus, 'current_monthly_price');
assert.notEqual(priceComplaint.qualificationField, 'bindingEnds');

const travelQuestion = getAdaptiveQuestionPlan({
  message: 'Jag reser mycket',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
});
assert.equal(travelQuestion.qualificationField, 'internationalTravel');
assert.equal(travelQuestion.focus, 'travel_region');

const streamingQuestion = getAdaptiveQuestionPlan({
  message: 'Jag betalar också för Netflix och HBO Max',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
});
assert.equal(streamingQuestion.qualificationField, 'streamingCalculation');
assert.equal(streamingQuestion.focus, 'paid_streaming');

const genericStart = getAdaptiveQuestionPlan({
  message: 'Hjälp mig hitta ett bättre abonnemang',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
});
assert.equal(genericStart.qualificationField, 'peopleCount');
assert.match(genericStart.guidance, /exact number/i);
assert.match(genericStart.guidance, /never use ranges/i);

const onlyBindingMissing = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'none',
  internationalTravel: 'none',
});
const bindingQuestion = getAdaptiveQuestionPlan({
  message: 'Okej',
  analysis: recommendationAnalysis(),
  qualification: onlyBindingMissing,
});
assert.equal(bindingQuestion.qualificationField, 'bindingEnds');

const outsideEu = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'none',
  internationalTravel: 'outside_eu',
});
assert.deepEqual(outsideEu.missingFields, ['internationalUsage']);
const outsideEuQuestion = getAdaptiveQuestionPlan({
  message: 'Jag reser utanför EU',
  analysis: recommendationAnalysis(),
  qualification: outsideEu,
});
assert.equal(outsideEuQuestion.qualificationField, 'internationalUsage');

const noDiscoveryForSupport = getAdaptiveQuestionPlan({
  message: 'Min faktura är fel',
  analysis: recommendationAnalysis({ recommendationRequested: false }),
  qualification: incomplete,
});
assert.equal(noDiscoveryForSupport, null);

const resolved = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'include',
  streamingServices: ['netflix'],
  internationalTravel: 'eu',
});
assert.equal(resolved.readyForOffer, true);
assert.deepEqual(resolved.missingFields, []);

console.log('adaptive question policy tests passed');
