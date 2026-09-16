const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'test-key';

const { setOpenAiTransportForTests } = require('./chat-service');
const { createServer } = require('./server');

const schemaQualification = (qualification) => ({
  peopleCount: qualification.peopleCount,
  operators: qualification.operators,
  bindingEnds: qualification.bindingEnds,
  mobileUsage: qualification.mobileUsage,
  requiredDataGb: qualification.requiredDataGb,
  priceRange: qualification.priceRange,
  familyPriceRange: qualification.familyPriceRange || null,
  streamingCalculation: qualification.streamingCalculation,
  streamingServices: qualification.streamingServices,
  streamingMonthlyCosts: {
    netflix: qualification.streamingMonthlyCosts.netflix || null,
    hbo: qualification.streamingMonthlyCosts.hbo || null,
    disney: qualification.streamingMonthlyCosts.disney || null,
    amazon: qualification.streamingMonthlyCosts.amazon || null,
    tv4: qualification.streamingMonthlyCosts.tv4 || null,
  },
  internationalTravel: qualification.internationalTravel,
  internationalUsage: qualification.internationalUsage,
  extraSimRequired: qualification.extraSimRequired,
  sharedDataRequired: qualification.sharedDataRequired,
  exactMonthlyPrice: qualification.exactMonthlyPrice,
  exactMonthlyPrices: qualification.exactMonthlyPrices,
  customerSegment: qualification.customerSegment,
  familyTotalPrice: qualification.familyTotalPrice,
  operatorAppliesToAll: qualification.operatorAppliesToAll,
  bindingAppliesToAll: qualification.bindingAppliesToAll,
  priceAppliesToAll: qualification.priceAppliesToAll,
});

setOpenAiTransportForTests(async (_url, options) => {
  const request = JSON.parse(options.body);
  const schemaName = request.text.format.name;
  let output;
  if (schemaName === 'dealett_customer_need') {
    const payload = JSON.parse(request.input.at(-1).content);
    output = {
      topic: 'mobile recommendation',
      interactionStage: 'solve',
      desiredOutcome: 'Find a suitable mobile recommendation',
      customerEmotion: 'neutral',
      recommendationRequested: true,
      resetRequested: false,
      groupBindingStatus: 'not_applicable',
      quizAnswerDecision: 'unresolved',
      knowledgeQuery: 'mobile plans',
      qualification: schemaQualification(payload.currentQualification),
    };
  } else {
    output = {
      reply: 'A dynamic explanation of the two calculated results.',
      showOfferCards: true,
      quickReplies: [{ label: 'Show all four operators', action: 'send_message' }],
      bestMatchReason: 'Best fit for the supplied needs.',
      lowestEffectiveCostReason: 'Lowest effective cost among valid options.',
      bestMatchBenefits: ['Matches all supplied requirements'],
      lowestEffectiveCostBenefits: ['Lowest effective cost'],
      offerCardCopy: {
        bestMatchLabel: 'Best match', lowestEffectiveCostLabel: 'Lowest effective cost',
        dataTitle: 'Data', monthlyPriceTitle: 'Monthly price', bindingTitle: 'Binding',
        perMonthSuffix: '/month', bindingMonthsSuffix: ' months binding',
        rewardLabel: 'Gift card: XXX SEK', ctaLabel: 'Choose offer',
      },
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(output) }),
  };
});

const postJson = async (baseUrl, route, body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, result.error || `${route} failed`);
  return result;
};

const scenarios = [
  {
    name: 'family streaming replacement',
    expectedPlanIds: ['telia-unlimited-plus-streaming-bundle', 'tre-unlimited'],
    qualification: {
      peopleCount: 4,
      operators: Array(4).fill('Annan / ingen'),
      bindingEnds: Array(4).fill('Ingen bindningstid'),
      mobileUsage: 'high',
      exactMonthlyPrice: 400,
      streamingCalculation: 'include',
      streamingServices: ['netflix', 'hbo', 'disney'],
      streamingMonthlyCosts: { netflix: 250, hbo: 200, disney: 200 },
      internationalTravel: 'none',
    },
  },
  {
    name: 'international data and calls',
    expectedPlanIds: ['tre-unlimited', 'tele2-unlimited-plus'],
    qualification: {
      peopleCount: 2,
      operators: Array(2).fill('Annan / ingen'),
      bindingEnds: Array(2).fill('Ingen bindningstid'),
      mobileUsage: 'high',
      exactMonthlyPrice: 500,
      streamingCalculation: 'none',
      streamingServices: [],
      streamingMonthlyCosts: {},
      internationalTravel: 'outside_eu',
      internationalUsage: 'calls',
    },
  },
  {
    name: 'international data uses the second strict match',
    expectedPlanIds: ['tele2-unlimited-plus', 'tre-unlimited'],
    qualification: {
      peopleCount: 1,
      operators: ['Annan / ingen'],
      bindingEnds: ['Ingen bindningstid'],
      mobileUsage: 'high',
      exactMonthlyPrice: 500,
      streamingCalculation: 'none',
      streamingServices: [],
      streamingMonthlyCosts: {},
      internationalTravel: 'outside_eu',
      internationalUsage: 'data',
    },
  },
  {
    name: 'international calls with streaming fallback',
    expectedPlanIds: ['tre-unlimited', 'telia-unlimited-plus-streaming-bundle'],
    qualification: {
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
    },
  },
  {
    name: 'flexible needs use best available fallbacks when no strict match exists',
    expectedPlanIds: ['tele2-unlimited-plus', 'tre-unlimited'],
    qualification: {
      peopleCount: 1,
      operators: ['Annan / ingen'],
      bindingEnds: ['Ingen bindningstid'],
      mobileUsage: 'high',
      exactMonthlyPrice: 500,
      streamingCalculation: 'none',
      streamingServices: [],
      streamingMonthlyCosts: {},
      internationalTravel: 'outside_eu',
      internationalUsage: 'calls',
      extraSimRequired: true,
    },
  },
];

(async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const scenario of scenarios) {
      const quiz = await postJson(baseUrl, '/api/offers/calculate', { qualification: scenario.qualification });
      const chat = await postJson(baseUrl, '/api/chat', {
        message: 'Explain my mobile recommendation',
        language: 'en',
        qualification: scenario.qualification,
      });
      assert.deepEqual(chat.offerCalculation, quiz, `${scenario.name}: calculations differ`);
      const featuredPlanIds = quiz.featuredOffers.map((offer) => offer.planId);
      const chatPlanIds = chat.offerCards.map((card) => card.planId);
      assert.deepEqual(featuredPlanIds, scenario.expectedPlanIds, `${scenario.name}: wrong featured pair`);
      assert.equal(featuredPlanIds.length, 2, `${scenario.name}: calculation did not return two offers`);
      assert.equal(new Set(featuredPlanIds).size, 2, `${scenario.name}: calculation duplicated an offer`);
      assert.deepEqual(
        [quiz.bestMatch?.planId, quiz.secondaryOffer?.planId],
        featuredPlanIds,
        `${scenario.name}: legacy aliases differ from the authoritative pair`
      );
      assert.deepEqual(chatPlanIds, featuredPlanIds, `${scenario.name}: chat did not use featuredOffers`);
      assert.equal(chatPlanIds.length, 2, `${scenario.name}: chat did not render two cards`);
      assert.equal(new Set(chatPlanIds).size, 2, `${scenario.name}: chat duplicated an offer card`);
    }
    console.log('recommendation parity tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
