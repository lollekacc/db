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
  familyPriceRange: null,
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
      interactionStage: 'solve',
      desiredOutcome: 'Find the best-value mobile plan for travel outside the EU',
      customerEmotion: 'neutral',
      recommendationRequested: true,
      recommendationProduct: 'mobile',
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
  assert.equal(calls[1].text.verbosity, 'low');
  assert.equal(calls[1].max_output_tokens, 700);
  const answerPrompt = calls[1].input.find((item) => item.role === 'system')?.content || '';
  assert.match(answerPrompt, /question must be one short sentence and contain exactly one question/i);
  assert.match(answerPrompt, /recommendation must be no more than 100 words/i);
  assert.match(answerPrompt, /offer cards carry the detail/i);
  assert.match(answerPrompt, /only when the customer explicitly asks/i);
  assert.match(answerPrompt, /understand the desired outcome, solve or route it, verify the outcome/i);
  assert.match(answerPrompt, /For a greeting with no stated need/i);
  assert.match(answerPrompt, /When Dealett cannot do what the customer asks/i);
  assert.match(answerPrompt, /acknowledge the specific concern/i);
  const answerPayload = JSON.parse(calls[1].input.at(-1).content);
  assert.equal(answerPayload.interactionStage, 'solve');
  assert.equal(answerPayload.customerEmotion, 'neutral');
  assert.match(answerPayload.desiredOutcome, /best-value mobile plan/i);
  assert.doesNotMatch(answerPrompt, /explain both best total value and lowest monthly price, including the 24-month formula/i);
  assert.equal(result.source, 'openai');
  assert.match(result.reply, /Tele2 is the best value/);
  assert.equal(result.offerCards.length, 2);
  assert.equal(result.offerCalculation.options.length, 4);
  assert.deepEqual(
    new Set(result.offerCalculation.options.map((option) => option.operator)),
    new Set(['Telia', 'Tele2', 'Telenor', 'Tre'])
  );
  assert.equal(result.qualification.streamingMonthlyCosts.netflix, 179);

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    const output = request.text.format.name === 'dealett_customer_need'
      ? {
        topic: 'streaming costs in mobile comparison',
        interactionStage: 'understand',
        desiredOutcome: 'Include paid streaming services in the existing comparison',
        customerEmotion: 'neutral',
        recommendationRequested: true,
        recommendationProduct: 'mobile',
        knowledgeQuery: 'streaming bundles',
        qualification: { ...analysisQualification, streamingServices: [] },
      }
      : {
        reply: 'Vilka streamingtjänster betalar du för?',
        quickReplies: ['Netflix', 'Disney+', 'HBO Max', 'TV4 Play', 'Amazon Prime'],
        bestValueReason: '',
        lowestPriceReason: '',
        bestValueBenefits: [],
        lowestPriceBenefits: [],
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify(output) }),
    };
  });

  const streamingQuestion = await createChatCompletion({
    message: 'om jag betalar för streaming tjänster också',
    language: 'sv',
    messages: [{ role: 'assistant', content: result.reply }],
    qualification: result.qualification,
    page: { path: 'mobilabonnemang.html' },
  });

  assert.equal(streamingQuestion.quickReplyMode, 'multiple');
  assert.equal(streamingQuestion.quickReplySubmitLabel, 'Skicka val');
  assert.equal(streamingQuestion.offerCards.length, 0);
  assert.deepEqual(
    streamingQuestion.quickReplies.map((reply) => reply.qualificationPatch.streamingServices[0]),
    ['netflix', 'disney', 'hbo', 'tv4', 'amazon']
  );

  const source = fs.readFileSync(require.resolve('./chat-service'), 'utf8');
  assert.doesNotMatch(source, /fallbackReply|detectIntent|inferQualificationFromText|DEALETT_CHAT_FORCE_FALLBACK/);
  console.log('dynamic chat tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
