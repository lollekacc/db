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
  extraSimRequired: false,
  sharedDataRequired: false,
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
      resetRequested: false,
      groupBindingStatus: 'not_applicable',
      quizAnswerDecision: 'unresolved',
      knowledgeQuery: 'mobile roaming international data streaming',
      qualification: analysisQualification,
    }
    : {
      reply: 'Tele2 is the best value for these needs, while Tre has the lowest qualifying monthly price.',
      showOfferCards: true,
      quickReplies: [{ label: 'Show all four operators', action: 'send_message' }],
      bestMatchReason: 'Its international data fits the stated travel need at the best effective cost.',
      lowestEffectiveCostReason: 'It is the lowest-priced plan that still meets every stated requirement.',
      bestMatchBenefits: ['International data', 'Required data amount'],
      lowestEffectiveCostBenefits: ['Lowest qualifying plan price'],
      offerCardCopy: {
        bestMatchLabel: 'Best match', lowestEffectiveCostLabel: 'Lowest effective cost',
        dataTitle: 'Data', monthlyPriceTitle: 'Monthly price', bindingTitle: 'Binding',
        perMonthSuffix: '/month', bindingMonthsSuffix: ' months binding',
        rewardLabel: 'Gift card: XXX SEK', ctaLabel: 'Choose offer',
      },
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
  assert.match(answerPrompt, /write every customer-facing response/i);
  assert.match(answerPrompt, /Ask only one focused question/i);
  assert.match(answerPrompt, /exact calculation/i);
  assert.match(answerPrompt, /only scripted conversational message/i);
  const answerPayload = JSON.parse(calls[1].input.at(-1).content);
  assert.equal(answerPayload.interactionStage, 'solve');
  assert.equal(answerPayload.customerEmotion, 'neutral');
  assert.match(answerPayload.desiredOutcome, /best-value mobile plan/i);
  assert.doesNotMatch(answerPrompt, /explain both best total value and lowest monthly price, including the 24-month formula/i);
  assert.equal(result.source, 'openai');
  assert.match(result.reply, /Tele2 is the best value/);
  assert.equal(result.offerCards.length, 2);
  assert.equal(result.offerCalculation.options.length, 2);
  assert.deepEqual(
    new Set(result.offerCalculation.options.map((option) => option.operator)),
    new Set(['Tele2', 'Tre'])
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
        resetRequested: false,
        groupBindingStatus: 'not_applicable',
        quizAnswerDecision: 'unresolved',
        knowledgeQuery: 'streaming bundles',
        qualification: { ...analysisQualification, streamingServices: [] },
      }
      : {
        reply: 'Vilka streamingtjänster betalar du för?',
        showOfferCards: false,
        quickReplies: ['Netflix', 'Disney+', 'HBO Max', 'TV4 Play', 'Amazon Prime']
          .map((label) => ({ label, action: 'send_message' })),
        bestMatchReason: '',
        lowestEffectiveCostReason: '',
        bestMatchBenefits: [],
        lowestEffectiveCostBenefits: [],
        offerCardCopy: {
          bestMatchLabel: '', lowestEffectiveCostLabel: '', dataTitle: '', monthlyPriceTitle: '',
          bindingTitle: '', perMonthSuffix: '', bindingMonthsSuffix: '', rewardLabel: '', ctaLabel: '',
        },
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

  assert.equal(streamingQuestion.quickReplyMode, 'single');
  assert.equal(streamingQuestion.quickReplySubmitLabel, '');
  assert.equal(streamingQuestion.offerCards.length, 0);
  assert.ok(streamingQuestion.quickReplies.every((reply) => reply.action === 'send_message'));

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    const analysis = request.text.format.name === 'dealett_customer_need';
    const output = analysis
      ? {
        topic: 'group mobile comparison',
        interactionStage: 'understand',
        desiredOutcome: 'Continue the group comparison',
        customerEmotion: 'neutral',
        recommendationRequested: true,
        resetRequested: false,
        groupBindingStatus: 'none_have_binding',
        quizAnswerDecision: 'unresolved',
        knowledgeQuery: 'mobile plans',
        qualification: {
          ...analysisQualification,
          peopleCount: 2,
          operators: ['Tele2', 'Telia'],
          bindingEnds: [],
          exactMonthlyPrice: null,
          exactMonthlyPrices: [200, 300],
        },
      }
      : {
        reply: 'Tack, då fortsätter jag jämförelsen.',
        showOfferCards: false,
        quickReplies: [],
        bestMatchReason: '',
        lowestEffectiveCostReason: '',
        bestMatchBenefits: [],
        lowestEffectiveCostBenefits: [],
        offerCardCopy: {
          bestMatchLabel: '', lowestEffectiveCostLabel: '', dataTitle: '', monthlyPriceTitle: '',
          bindingTitle: '', perMonthSuffix: '', bindingMonthsSuffix: '', rewardLabel: '', ctaLabel: '',
        },
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ output_text: JSON.stringify(output) }),
    };
  });

  const groupAnswer = await createChatCompletion({
    message: 'Nej',
    language: 'sv',
    messages: [{ role: 'assistant', content: 'Har någon av er bindningstid kvar?' }],
    qualification: {
      peopleCount: 2,
      operators: ['Tele2', 'Telia'],
      mobileUsage: 'high',
    },
  });

  assert.deepEqual(groupAnswer.qualification.bindingEnds, ['Ingen bindningstid', 'Ingen bindningstid']);
  assert.equal(groupAnswer.qualification.bindingAppliesToAll, true);
  assert.deepEqual(groupAnswer.qualification.exactMonthlyPrices, [200, 300]);
  assert.deepEqual(groupAnswer.qualification.people.map((person) => person.currentMonthlyCost), [200, 300]);

  const source = fs.readFileSync(require.resolve('./chat-service'), 'utf8');
  assert.doesNotMatch(source, /fallbackReply|detectIntent|inferQualificationFromText|DEALETT_CHAT_FORCE_FALLBACK/);
  console.log('dynamic chat tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
