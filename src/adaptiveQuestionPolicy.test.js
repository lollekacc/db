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
  'operators',
  'bindingEnds',
  'priceRange',
  'mobileUsage',
  'internationalTravel',
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
assert.equal(afterDeferral.qualificationField, 'operators');
assert.equal(afterDeferral.selectionReason, 'canonical_order');

const afterPeopleCount = normalizeQualification({ peopleCount: 1 });
const combinedOperatorBindingQuestion = getAdaptiveQuestionPlan({
  message: 'Ett abonnemang',
  analysis: recommendationAnalysis(),
  qualification: afterPeopleCount,
});
assert.equal(combinedOperatorBindingQuestion.qualificationField, 'operators');
assert.equal(combinedOperatorBindingQuestion.focus, 'current_operator_and_binding');
assert.deepEqual(combinedOperatorBindingQuestion.combinedQualificationFields, [
  'operators',
  'bindingEnds',
]);
assert.match(combinedOperatorBindingQuestion.guidance, /one combined question/i);
assert.match(combinedOperatorBindingQuestion.guidance, /mobile operator/i);
assert.match(combinedOperatorBindingQuestion.guidance, /binding time ends/i);

const operatorAlreadyKnown = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
});
const bindingOnlyFollowUp = getAdaptiveQuestionPlan({
  message: 'Tele2',
  analysis: recommendationAnalysis(),
  qualification: operatorAlreadyKnown,
});
assert.equal(bindingOnlyFollowUp.qualificationField, 'bindingEnds');
assert.equal(bindingOnlyFollowUp.focus, 'binding_status');
assert.deepEqual(bindingOnlyFollowUp.combinedQualificationFields, []);

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
  pendingBindingEnd: null,
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
assert.match(bindingQuestion.guidance, /current mobile subscription/i);
assert.match(bindingQuestion.guidance, /streaming service/i);

const completedBindingQualification = normalizeQualification({
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['2026-12-01'],
  mobileUsage: 'high',
  exactMonthlyPrice: 499,
  streamingCalculation: 'none',
  internationalTravel: 'none',
});
const pendingBindingFlow = normalizeQuestionFlowState({
  inProgress: true,
  activeQuestionField: 'bindingEnds',
  attempts: { bindingEnds: 2 },
  pendingBindingEnd: {
    date: '2027-02-27',
    monthsRemaining: 6,
    targetIndex: 0,
    appliesToAll: false,
  },
});
const bindingConfirmation = getAdaptiveQuestionPlan({
  message: 'Jag kan inte svara just nu',
  analysis: recommendationAnalysis(),
  qualification: completedBindingQualification,
  flowState: pendingBindingFlow,
});
assert.equal(bindingConfirmation.qualificationField, 'bindingEnds');
assert.equal(bindingConfirmation.selectionReason, 'binding_date_confirmation');
assert.equal(bindingConfirmation.pendingBindingEnd.date, '2027-02-27');
assert.match(bindingConfirmation.guidance, /2027-02-27/);
assert.equal(bindingConfirmation.attemptNumber, 3);
const blockedBindingConfirmation = buildNextQuestionFlowState({
  previousFlowState: pendingBindingFlow,
  adaptiveQuestionPlan: bindingConfirmation,
  qualification: completedBindingQualification,
});
assert.equal(blockedBindingConfirmation.blockedQuestionField, 'bindingEnds');
assert.equal(blockedBindingConfirmation.inProgress, false);
assert.equal(getAdaptiveQuestionPlan({
  message: 'Okej',
  analysis: recommendationAnalysis(),
  qualification: completedBindingQualification,
  flowState: blockedBindingConfirmation,
}), null);

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
assert.match(outsideEuQuestion.guidance, /local calls and mobile data/i);
assert.match(outsideEuQuestion.guidance, /do not ask which one matters most/i);

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
