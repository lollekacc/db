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
      knowledgeQuery: 'mobile plans',
      qualification: schemaQualification(payload.currentQualification),
    };
  } else {
    output = {
      reply: 'A dynamic explanation of the two calculated results.',
      quickReplies: ['Show all four operators'],
      bestValueReason: 'Lowest real effective cost for the supplied needs.',
      lowestPriceReason: 'Lowest monthly plan price among valid options.',
      bestValueBenefits: ['Matches all supplied requirements'],
      lowestPriceBenefits: ['Lowest subscription bill'],
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
      assert.equal(chat.offerCards.length, 2);
      assert.deepEqual(chat.offerCards.map((card) => card.resultLabel), ['Best value', 'Lowest monthly price']);
    }
    console.log('recommendation parity tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
