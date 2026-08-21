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
  const output = analysis
    ? {
      topic: 'mobile comparison',
      interactionStage: 'solve',
      desiredOutcome: 'compare mobile plans',
      customerEmotion: 'neutral',
      recommendationRequested: true,
      knowledgeQuery: 'mobile plans',
      // Simulate a model trying to copy the visible historical answers.
      qualification: qualificationOutput(historicalQualification),
    }
    : {
      reply: 'Här är rekommendationen.',
      quickReplies: [],
      bestValueReason: 'Bäst värde.',
      lowestPriceReason: 'Lägst pris.',
      bestValueBenefits: [],
      lowestPriceBenefits: [],
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

  assert.equal(calls.length, 1, 'Historical answers must be gated before answer generation or calculation');
  assert.equal(gated.quizAnswersStatus, 'unconfirmed');
  assert.equal(gated.offerCalculation, null);
  assert.equal(gated.qualification.peopleCount, null);
  assert.match(gated.reply, /använder dem inte utan ditt godkännande/i);
  assert.deepEqual(gated.quickReplies.map((reply) => reply.action), [
    'useHistoricalQuizAnswers',
    'startFreshWithoutQuiz',
  ]);

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

  console.log('quiz consent tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
