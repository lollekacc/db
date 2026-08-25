const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'test-key';

const {
  createChatCompletion,
  createEmptyQualification,
  setOpenAiTransportForTests,
} = require('./chat-service');

const historicalQualification = {
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  priceRange: '300-400',
  streamingCalculation: 'none',
  internationalTravel: 'none',
};

const context = {
  quizHandoff: false,
  quizAnswersStatus: 'unconfirmed',
  historicalQuizQualification: historicalQualification,
  answers: { peopleCount: 1, data: 'high', price: '300-400' },
};

const qualificationOutput = (overrides = {}) => ({
  peopleCount: null,
  people: [],
  operators: [],
  bindingEnds: [],
  mobileUsage: null,
  requiredDataGb: null,
  priceRange: null,
  familyPriceRange: null,
  streamingCalculation: null,
  streamingServices: [],
  streamingMonthlyCosts: { netflix: null, hbo: null, disney: null, amazon: null, tv4: null },
  internationalTravel: null,
  internationalUsage: null,
  extraSimRequired: false,
  sharedDataRequired: false,
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  customerSegment: null,
  familyTotalPrice: null,
  operatorAppliesToAll: false,
  bindingAppliesToAll: false,
  priceAppliesToAll: false,
  ...overrides,
});

let calls = [];
setOpenAiTransportForTests(async (_url, options) => {
  const request = JSON.parse(options.body);
  calls.push(request);
  const analysis = request.text.format.name === 'dealett_customer_need';
  const payload = JSON.parse(request.input.at(-1).content);
  const acceptsHistory = /Använd samma svar/i.test(payload.latestMessage || '');
  const unavailableHistory = payload.context?.unavailableHistoricalQuizRequested === true;
  const output = analysis
    ? {
      topic: 'mobile comparison',
      interactionStage: 'solve',
      desiredOutcome: 'compare mobile plans',
      customerEmotion: 'neutral',
      recommendationRequested: true,
      resetRequested: false,
      groupBindingStatus: 'not_applicable',
      quizAnswerDecision: acceptsHistory ? 'use' : 'unresolved',
      knowledgeQuery: 'mobile plans',
      // Simulate a model trying to copy the visible historical answers.
      qualification: qualificationOutput(historicalQualification),
    }
    : {
      reply: unavailableHistory
        ? 'Jag har inga tidigare svar att använda. Vilken operatör har du idag?'
        : (acceptsHistory ? 'Här är rekommendationen.' : 'Vill du använda de tidigare svaren?'),
      showOfferCards: acceptsHistory && !unavailableHistory,
      quickReplies: acceptsHistory ? [] : [
        { label: 'Använd samma svar', action: 'send_message' },
        { label: 'Börja om', action: 'send_message' },
      ],
      bestMatchReason: 'Bäst matchning.',
      lowestEffectiveCostReason: 'Lägst effektiv kostnad.',
      bestMatchBenefits: [],
      lowestEffectiveCostBenefits: [],
      offerCardCopy: {
        bestMatchLabel: 'Bäst matchning', lowestEffectiveCostLabel: 'Lägst effektiv kostnad',
        dataTitle: 'Surf', monthlyPriceTitle: 'Månadskostnad', bindingTitle: 'Bindning',
        perMonthSuffix: '/mån', bindingMonthsSuffix: ' mån bindningstid',
        rewardLabel: 'Presentkort: XXX kr', ctaLabel: 'Välj erbjudande',
      },
    };
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(output) }),
  };
});

(async () => {
  const gated = await createChatCompletion({
    message: 'Hjälp mig hitta bästa abonnemanget',
    language: 'sv',
    qualification: createEmptyQualification(),
    context,
  });

  assert.equal(calls.length, 2, 'The model should generate the consent request without using historical answers');
  assert.equal(gated.quizAnswersStatus, 'unconfirmed');
  assert.equal(gated.offerCalculation, null);
  assert.equal(gated.qualification.peopleCount, null);
  assert.match(gated.reply, /tidigare svaren/i);
  assert.ok(gated.quickReplies.every((reply) => reply.action === 'send_message'));

  calls = [];
  const accepted = await createChatCompletion({
    message: 'Använd samma svar',
    language: 'sv',
    messages: [{ role: 'assistant', content: gated.reply }],
    qualification: createEmptyQualification(),
    context,
  });

  assert.equal(calls.length, 2);
  assert.equal(accepted.quizAnswersStatus, 'confirmed');
  assert.equal(accepted.qualification.peopleCount, 1);
  assert.deepEqual(accepted.qualification.operators, ['Tele2']);
  assert.ok(accepted.offerCalculation, 'Accepted historical answers should be eligible for calculation');

  calls = [];
  const unavailable = await createChatCompletion({
    message: 'Använd samma svar',
    language: 'sv',
    qualification: createEmptyQualification(),
    context: {},
  });

  const unavailableAnswerPayload = JSON.parse(calls[1].input.at(-1).content);
  assert.equal(unavailableAnswerPayload.context.unavailableHistoricalQuizRequested, true);
  assert.equal(unavailable.quizAnswersStatus, 'none');
  assert.equal(unavailable.qualification.peopleCount, null);
  assert.deepEqual(unavailable.qualification.operators, []);
  assert.equal(unavailable.offerCalculation, null);
  assert.match(unavailable.reply, /inga tidigare svar/i);

  console.log('quiz consent tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
