const assert = require('node:assert/strict');
const fs = require('node:fs');

process.env.OPENAI_API_KEY = 'test-key';

const {
  createChatCompletion,
  setOpenAiTransportForTests,
} = require('./chat-service');

const analysisQualification = {
  peopleCount: 1,
  operators: ['Tele2'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'high',
  requiredDataGb: 50,
  priceRange: null,
  streamingCalculation: 'include',
  streamingServices: ['netflix'],
  streamingMonthlyCosts: { netflix: 179, hbo: null, disney: null, amazon: null, tv4: null },
  internationalTravel: 'outside_eu',
  internationalUsage: 'data',
  exactMonthlyPrice: 499,
  exactMonthlyPrices: [],
  customerSegment: 'private',
  familyTotalPrice: null,
  operatorAppliesToAll: false,
  bindingAppliesToAll: false,
  priceAppliesToAll: false,
};

const calls = [];
setOpenAiTransportForTests(async (_url, options) => {
  const request = JSON.parse(options.body);
  calls.push(request);
  const name = request.text.format.name;
  const output = name === 'dealett_customer_need'
    ? {
      topic: 'mobile plan comparison for international travel',
      recommendationRequested: true,
      knowledgeQuery: 'mobile roaming international data streaming',
      qualification: analysisQualification,
    }
    : {
      reply: 'Tele2 is the best value for these needs, while Tre has the lowest qualifying monthly price.',
      quickReplies: ['Show all four operators'],
      bestValueReason: 'Its international data fits the stated travel need at the best effective cost.',
      lowestPriceReason: 'It is the lowest-priced plan that still meets every stated requirement.',
      bestValueBenefits: ['International data', 'Required data amount'],
      lowestPriceBenefits: ['Lowest qualifying plan price'],
    };
  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(output) }),
  };
});

(async () => {
  const result = await createChatCompletion({
    message: 'I travel outside the EU and use lots of data. What gives me the best value?',
    language: 'en',
    messages: [],
    qualification: {},
    page: { path: 'mobilabonnemang.html' },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text.format.type, 'json_schema');
  assert.equal(calls[1].text.format.type, 'json_schema');
  assert.equal(calls[0].model, 'gpt-5.6-luna');
  assert.equal(calls[0].reasoning.effort, 'none');
  assert.equal(calls[1].model, 'gpt-5.6-terra');
  assert.equal(calls[1].reasoning.effort, 'low');
  assert.equal(result.source, 'openai');
  assert.match(result.reply, /Tele2 is the best value/);
  assert.equal(result.offerCards.length, 2);
  assert.equal(result.offerCalculation.options.length, 4);
  assert.deepEqual(
    new Set(result.offerCalculation.options.map((option) => option.operator)),
    new Set(['Telia', 'Tele2', 'Telenor', 'Tre'])
  );
  assert.equal(result.qualification.streamingMonthlyCosts.netflix, 179);

  const source = fs.readFileSync(require.resolve('./chat-service'), 'utf8');
  assert.doesNotMatch(source, /fallbackReply|detectIntent|inferQualificationFromText|DEALETT_CHAT_FORCE_FALLBACK/);
  console.log('dynamic chat tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
