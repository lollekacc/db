const assert = require('node:assert/strict');

const { normalizeQualification } = require('../qualification-service');
const {
  CANONICAL_QUESTION_ORDER,
  buildNextQuestionFlowState,
  getAdaptiveQuestionPlan,
  normalizeQuestionFlowState,
} = require('./adaptive-question-policy');

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
assert.match(travelQuestion.guidance, /Do not imply/i);

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
assert.deepEqual(CANONICAL_QUESTION_ORDER.slice(0, 6), [
  'peopleCount',
  'priceRange',
  'mobileUsage',
  'internationalTravel',
  'internationalUsage',
  'streamingCalculation',
]);

const initialFlow = buildNextQuestionFlowState({
  adaptiveQuestionPlan: genericStart,
  qualification: incomplete,
});
assert.equal(initialFlow.inProgress, true);
assert.equal(initialFlow.activeQuestionField, 'peopleCount');
assert.equal(initialFlow.attempts.peopleCount, 1);

const resumedQuestion = getAdaptiveQuestionPlan({
  message: 'Okej',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
  flowState: initialFlow,
});
assert.equal(resumedQuestion.qualificationField, 'peopleCount');
assert.equal(resumedQuestion.selectionReason, 'resume_active');
assert.equal(resumedQuestion.attemptNumber, 2);
assert.match(resumedQuestion.guidance, /Rephrase/i);

const jumpedQuestion = getAdaptiveQuestionPlan({
  message: 'Hur fungerar det om jag reser utanför EU?',
  analysis: recommendationAnalysis({ topic: 'travel outside EU' }),
  qualification: incomplete,
  flowState: initialFlow,
});
assert.equal(jumpedQuestion.qualificationField, 'internationalTravel');
assert.equal(jumpedQuestion.selectionReason, 'customer_jump');

const tangentQuestion = getAdaptiveQuestionPlan({
  message: 'Min faktura verkar vara fel',
  analysis: recommendationAnalysis({
    recommendationRequested: false,
    interactionStage: 'solve',
    topic: 'incorrect invoice',
  }),
  qualification: incomplete,
  flowState: initialFlow,
});
assert.equal(tangentQuestion.qualificationField, 'peopleCount');
assert.equal(tangentQuestion.selectionReason, 'resume_active');
assert.equal(tangentQuestion.resumedAfterTangent, true);

const closedFlow = getAdaptiveQuestionPlan({
  message: 'Tack, vi avslutar där',
  analysis: recommendationAnalysis({
    recommendationRequested: false,
    interactionStage: 'close',
  }),
  qualification: incomplete,
  flowState: initialFlow,
});
assert.equal(closedFlow, null);

const secondFlow = buildNextQuestionFlowState({
  previousFlowState: initialFlow,
  adaptiveQuestionPlan: resumedQuestion,
  qualification: incomplete,
});
const thirdQuestion = getAdaptiveQuestionPlan({
  message: 'Jag kan inte svara på det',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
  flowState: secondFlow,
});
assert.equal(thirdQuestion.attemptNumber, 3);
assert.match(thirdQuestion.guidance, /exact recommendation must wait/i);
const deferredFlow = buildNextQuestionFlowState({
  previousFlowState: secondFlow,
  adaptiveQuestionPlan: thirdQuestion,
  qualification: incomplete,
});
assert.deepEqual(deferredFlow.deferredFields, ['peopleCount']);
const afterDeferral = getAdaptiveQuestionPlan({
  message: 'Okej, fortsätt',
  analysis: recommendationAnalysis(),
  qualification: incomplete,
  flowState: deferredFlow,
});
assert.equal(afterDeferral.qualificationField, 'priceRange');
assert.equal(afterDeferral.selectionReason, 'canonical_order');

assert.deepEqual(normalizeQuestionFlowState({
  inProgress: true,
  activeQuestionField: 'invalid',
  attempts: { peopleCount: 99, invalid: 2 },
  deferredFields: ['invalid', 'priceRange', 'priceRange'],
}), {
  version: 1,
  inProgress: true,
  activeQuestionField: null,
  blockedQuestionField: null,
  attempts: { peopleCount: 3 },
  deferredFields: ['priceRange'],
});

const lastRequiredField = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  streamingCalculation: 'none',
  internationalTravel: 'none',
});
assert.deepEqual(lastRequiredField.missingFields, ['priceRange']);
const nearlyBlockedFlow = normalizeQuestionFlowState({
  inProgress: true,
  activeQuestionField: 'priceRange',
  attempts: { priceRange: 2 },
});
const finalPriceAttempt = getAdaptiveQuestionPlan({
  message: 'Jag vet fortfarande inte',
  analysis: recommendationAnalysis(),
  qualification: lastRequiredField,
  flowState: nearlyBlockedFlow,
});
assert.equal(finalPriceAttempt.attemptNumber, 3);
const blockedFlow = buildNextQuestionFlowState({
  previousFlowState: nearlyBlockedFlow,
  adaptiveQuestionPlan: finalPriceAttempt,
  qualification: lastRequiredField,
});
assert.equal(blockedFlow.inProgress, false);
assert.equal(blockedFlow.activeQuestionField, null);
assert.equal(blockedFlow.blockedQuestionField, 'priceRange');
const noLoopAfterBlock = getAdaptiveQuestionPlan({
  message: 'Jag vet inte',
  analysis: recommendationAnalysis(),
  qualification: lastRequiredField,
  flowState: blockedFlow,
});
assert.equal(noLoopAfterBlock, null);
assert.deepEqual(buildNextQuestionFlowState({
  previousFlowState: blockedFlow,
  adaptiveQuestionPlan: noLoopAfterBlock,
  qualification: lastRequiredField,
}), blockedFlow);

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
  streamingMonthlyCosts: { netflix: 179 },
  internationalTravel: 'eu',
});
assert.equal(resolved.readyForOffer, true);
assert.deepEqual(resolved.missingFields, []);

const missingStreamingPrices = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'include',
  streamingServices: ['netflix', 'disney'],
  streamingMonthlyCosts: { netflix: 179 },
  internationalTravel: 'none',
});
assert.deepEqual(missingStreamingPrices.missingFields, ['streamingPrices']);
const streamingPriceQuestion = getAdaptiveQuestionPlan({
  message: 'Jag valde streamingtjänsterna',
  analysis: recommendationAnalysis(),
  qualification: missingStreamingPrices,
});
assert.equal(streamingPriceQuestion.focus, 'streaming_monthly_prices');
assert.deepEqual(streamingPriceQuestion.missingStreamingPrices, ['disney']);

console.log('adaptive question policy tests passed');
