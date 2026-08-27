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
  assert.match(answerPrompt, /decisive reason/i);
  assert.match(answerPrompt, /Do not restate the operator, data allowance, exact prices/i);
  assert.match(answerPrompt, /only scripted conversational message/i);
  assert.match(answerPrompt, /deterministic `adaptiveQuestionPlan` controls the default order/i);
  const answerPayload = JSON.parse(calls[1].input.at(-1).content);
  assert.equal(answerPayload.interactionStage, 'solve');
  assert.equal(answerPayload.customerEmotion, 'neutral');
  assert.match(answerPayload.desiredOutcome, /best-value mobile plan/i);
  assert.doesNotMatch(answerPrompt, /explain both best total value and lowest monthly price, including the 24-month formula/i);
  assert.equal(result.source, 'openai');
  assert.match(result.reply, /Tele2 is the best value/);
  assert.equal(result.offerCards.length, 2);
  assert.deepEqual(result.offerCards.map((card) => card.planId), [
    result.offerCalculation.bestMatch.planId,
    result.offerCalculation.secondaryOffer.planId,
  ]);
  assert.equal(result.offerCalculation.secondaryOffer.operator, 'Telia');
  assert.equal(result.offerCalculation.secondaryOffer.recommendationType, 'best_streaming_alternative');
  assert.deepEqual(result.offerCalculation.secondaryOffer.relaxedRequirements, ['outside_eu_data']);
  assert.equal(result.offerCalculation.options.length, 2);
  assert.deepEqual(
    new Set(result.offerCalculation.options.map((option) => option.operator)),
    new Set(['Tele2', 'Tre'])
  );
  assert.equal(result.qualification.streamingMonthlyCosts.netflix, 179);

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
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
    qualification: {
      ...result.qualification,
      streamingCalculation: 'unknown',
      streamingServices: [],
    },
    page: { path: 'mobilabonnemang.html' },
  });

  assert.deepEqual(streamingQuestion.quickReplies, []);
  assert.equal(streamingQuestion.embeddedWidget.type, 'streaming_prices');
  assert.equal(streamingQuestion.flowState.inProgress, true);
  assert.equal(streamingQuestion.flowState.activeQuestionField, 'streamingServices');
  assert.deepEqual(
    streamingQuestion.embeddedWidget.services.map((service) => service.label),
    ['Netflix', 'HBO Max', 'Disney+']
  );
  assert.equal(streamingQuestion.offerCards.length, 0);
  const streamingAnswerPayload = JSON.parse(calls.at(-1).input.at(-1).content);
  assert.equal(streamingAnswerPayload.adaptiveQuestionPlan.focus, 'streaming_services');
  assert.equal(streamingAnswerPayload.questionFlowState.activeQuestionField, 'streamingServices');

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const output = request.text.format.name === 'dealett_customer_need'
      ? {
        topic: 'streaming prices in mobile comparison',
        interactionStage: 'understand',
        desiredOutcome: 'Continue the mobile comparison with streaming costs',
        customerEmotion: 'neutral',
        recommendationRequested: true,
        resetRequested: false,
        groupBindingStatus: 'not_applicable',
        quizAnswerDecision: 'unresolved',
        knowledgeQuery: 'streaming bundles',
        qualification: {
          ...analysisQualification,
          streamingCalculation: 'none',
          streamingServices: [],
          streamingMonthlyCosts: { netflix: null, hbo: null, disney: null, amazon: null, tv4: null },
        },
      }
      : {
        reply: 'Vad betalar du för HBO Max per månad?',
        showOfferCards: false,
        quickReplies: [{ label: 'Vet inte', action: 'send_message' }],
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

  const missingStreamingPriceQuestion = await createChatCompletion({
    message: 'Netflix: 179 kr/mån, HBO Max: Pris saknas',
    language: 'sv',
    qualification: result.qualification,
    flowState: streamingQuestion.flowState,
    context: {
      source: 'streaming_price_widget',
      qualificationPatch: {
        streamingCalculation: 'include',
        streamingServices: ['netflix', 'hbo'],
        streamingMonthlyCosts: { netflix: 179 },
      },
    },
  });
  assert.equal(missingStreamingPriceQuestion.qualification.streamingCalculation, 'include');
  assert.deepEqual(missingStreamingPriceQuestion.qualification.streamingServices, ['netflix', 'hbo']);
  assert.equal(missingStreamingPriceQuestion.qualification.streamingMonthlyCosts.netflix, 179);
  assert.deepEqual(missingStreamingPriceQuestion.qualification.missingFields, ['streamingPrices']);
  assert.deepEqual(missingStreamingPriceQuestion.quickReplies, []);
  assert.equal(missingStreamingPriceQuestion.embeddedWidget, null);
  const missingPriceAnswerPayload = JSON.parse(calls.at(-1).input.at(-1).content);
  assert.equal(missingPriceAnswerPayload.adaptiveQuestionPlan.focus, 'streaming_monthly_prices');
  assert.deepEqual(missingPriceAnswerPayload.adaptiveQuestionPlan.missingStreamingPrices, ['hbo']);

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const output = request.text.format.name === 'dealett_customer_need'
      ? {
        topic: 'travel outside the EU',
        interactionStage: 'understand',
        desiredOutcome: 'Continue the mobile comparison for travel outside the EU',
        customerEmotion: 'neutral',
        recommendationRequested: true,
        resetRequested: false,
        groupBindingStatus: 'not_applicable',
        quizAnswerDecision: 'unresolved',
        knowledgeQuery: 'outside EU roaming',
        qualification: {
          ...analysisQualification,
          streamingCalculation: 'none',
          streamingServices: [],
          streamingMonthlyCosts: { netflix: null, hbo: null, disney: null, amazon: null, tv4: null },
          internationalTravel: 'outside_eu',
          internationalUsage: 'data',
        },
      }
      : {
        reply: 'Behöver du bara surf, eller både lokala samtal och surf utanför EU/EES?',
        showOfferCards: false,
        quickReplies: [{ label: 'AI-generated choice', action: 'send_message' }],
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

  const outsideEuUsageQuestion = await createChatCompletion({
    message: 'Jag reser utanför EU',
    language: 'sv',
    qualification: {
      ...analysisQualification,
      streamingCalculation: 'none',
      streamingServices: [],
      streamingMonthlyCosts: {},
      internationalTravel: null,
      internationalUsage: null,
    },
  });
  assert.equal(outsideEuUsageQuestion.qualification.internationalTravel, 'outside_eu');
  assert.equal(outsideEuUsageQuestion.qualification.internationalUsage, null);
  assert.deepEqual(outsideEuUsageQuestion.qualification.missingFields, ['internationalUsage']);
  assert.equal(outsideEuUsageQuestion.flowState.activeQuestionField, 'internationalUsage');
  assert.deepEqual(outsideEuUsageQuestion.quickReplies.map((reply) => reply.label), [
    'Bara surf',
    'Lokala samtal och surf',
  ]);

  setOpenAiTransportForTests(async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const output = request.text.format.name === 'dealett_customer_need'
      ? {
        topic: 'travel outside the EU',
        interactionStage: 'solve',
        desiredOutcome: 'Compare plans with local calls and data abroad',
        customerEmotion: 'neutral',
        recommendationRequested: true,
        resetRequested: false,
        groupBindingStatus: 'not_applicable',
        quizAnswerDecision: 'unresolved',
        knowledgeQuery: 'outside EU local calls and data',
        qualification: {
          ...analysisQualification,
          ...outsideEuUsageQuestion.qualification,
          internationalUsage: 'calls',
        },
      }
      : {
        reply: 'Då jämför jag alternativ där både lokala samtal och surf ingår.',
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

  const outsideEuCallsAnswer = await createChatCompletion({
    message: 'Lokala samtal och surf',
    language: 'sv',
    qualification: outsideEuUsageQuestion.qualification,
    flowState: outsideEuUsageQuestion.flowState,
  });
  assert.equal(outsideEuCallsAnswer.qualification.internationalUsage, 'calls');
  assert.deepEqual(
    outsideEuCallsAnswer.offerCalculation.options.map((option) => option.operator),
    ['Tre']
  );
  assert.equal(outsideEuCallsAnswer.offerCalculation.secondaryOffer.operator, 'Tele2');
  assert.equal(
    outsideEuCallsAnswer.offerCalculation.secondaryOffer.recommendationType,
    'lowest_cost_alternative'
  );

  const outsideEuDataAnswer = await createChatCompletion({
    message: 'Bara surf',
    language: 'sv',
    qualification: outsideEuUsageQuestion.qualification,
    flowState: outsideEuUsageQuestion.flowState,
  });
  assert.equal(outsideEuDataAnswer.qualification.internationalUsage, 'data');
  assert.equal(outsideEuDataAnswer.offerCalculation.bestMatch.operator, 'Tele2');
  assert.deepEqual(
    new Set(outsideEuDataAnswer.offerCalculation.options.map((option) => option.operator)),
    new Set(['Tele2', 'Tre'])
  );

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
