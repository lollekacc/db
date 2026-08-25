const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'test-key';

const {
  createChatCompletion,
  createEmptyQualification,
  setOpenAiTransportForTests,
} = require('../chat-service');

const scenarios = [
  {
    input: 'hej',
    context: { initialGreeting: true },
    analysis: {
      topic: 'greeting',
      interactionStage: 'greeting',
      desiredOutcome: null,
      customerEmotion: 'neutral',
      recommendationRequested: false,
      knowledgeQuery: 'Dealett help categories',
    },
    answer: {
      reply: 'Hej! Vad vill du ha hjälp med idag?',
      quickReplies: ['Jämför mobilabonnemang', 'Jämför bredband', 'Hjälp med befintligt abonnemang', 'Något annat'],
    },
  },
  {
    input: 'Nej, det löste inte mitt problem. Fakturan är fortfarande fel.',
    analysis: {
      topic: 'incorrect invoice',
      interactionStage: 'dissatisfied',
      desiredOutcome: 'Get an incorrect invoice investigated and corrected',
      customerEmotion: 'frustrated',
      recommendationRequested: false,
      knowledgeQuery: 'invoice support contact',
    },
    answer: {
      reply: 'Jag förstår att fakturan fortfarande är fel. Jag kan inte ändra den i chatten, men du kan skicka ett personligt supportärende via kontaktsidan så att den kan granskas—vill du öppna den?',
      quickReplies: ['Öppna kontaktsidan', 'Nej tack'],
    },
  },
  {
    input: 'Kan du återbetala pengarna direkt?',
    analysis: {
      topic: 'refund request',
      interactionStage: 'solve',
      desiredOutcome: 'Receive an immediate refund',
      customerEmotion: 'anxious',
      recommendationRequested: false,
      knowledgeQuery: 'refund account support contact',
    },
    answer: {
      reply: 'Jag kan inte genomföra en återbetalning eller öppna ditt konto i chatten. Ett personligt supportärende är rätt väg för en granskning—vill du öppna kontaktsidan?',
      quickReplies: ['Öppna kontaktsidan', 'Nej tack'],
    },
  },
  {
    input: 'hur mår du?',
    messages: [{ role: 'assistant', content: 'Hur många abonnemang vill du jämföra?' }],
    analysis: {
      topic: 'small talk',
      interactionStage: 'understand',
      desiredOutcome: 'Have a normal conversation',
      customerEmotion: 'neutral',
      recommendationRequested: true,
      knowledgeQuery: '',
    },
    answer: {
      reply: 'Jag mår bra, tack! Vad vill du prata om?',
      quickReplies: [],
    },
  },
];

let activeScenario = null;
const capturedRequests = [];

setOpenAiTransportForTests(async (_url, options) => {
  const request = JSON.parse(options.body);
  capturedRequests.push(request);
  const schemaName = request.text.format.name;
  const output = schemaName === 'dealett_customer_need'
    ? {
      ...activeScenario.analysis,
      resetRequested: false,
      quizAnswerDecision: 'unresolved',
      qualification: {
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
        streamingMonthlyCosts: {
          netflix: null,
          hbo: null,
          disney: null,
          amazon: null,
          tv4: null,
        },
        internationalTravel: null,
        internationalUsage: null,
        exactMonthlyPrice: null,
        exactMonthlyPrices: [],
        customerSegment: null,
        familyTotalPrice: null,
        operatorAppliesToAll: false,
        bindingAppliesToAll: false,
        priceAppliesToAll: false,
      },
    }
    : {
      ...activeScenario.answer,
      showOfferCards: false,
      quickReplies: (activeScenario.answer.quickReplies || [])
        .map((label) => ({ label, action: 'send_message' })),
      bestValueReason: '',
      lowestPriceReason: '',
      bestValueBenefits: [],
      lowestPriceBenefits: [],
      offerCardCopy: {
        bestValueLabel: '', lowestPriceLabel: '', dataTitle: '', monthlyPriceTitle: '',
        bindingTitle: '', perMonthSuffix: '', bindingMonthsSuffix: '', rewardLabel: '', ctaLabel: '',
      },
    };

  return {
    ok: true,
    status: 200,
    json: async () => ({ output_text: JSON.stringify(output) }),
  };
});

(async () => {
  for (const scenario of scenarios) {
    activeScenario = scenario;
    capturedRequests.length = 0;
    const result = await createChatCompletion({
      message: scenario.input,
      language: 'sv',
      messages: scenario.messages || [],
      qualification: createEmptyQualification(),
      context: scenario.context || {},
      page: { path: 'mobilabonnemang.html' },
    });

    assert.equal(capturedRequests.length, 2);
    const analysisPrompt = capturedRequests[0].input[0].content;
    const answerPrompt = capturedRequests[1].input[0].content;
    const answerPayload = JSON.parse(capturedRequests[1].input.at(-1).content);

    assert.match(analysisPrompt, /A greeting alone is not a recommendation request/i);
    assert.match(analysisPrompt, /desiredOutcome.*what the customer wants now/i);
    assert.match(answerPrompt, /write the best response freely/i);
    assert.match(answerPrompt, /cannot perform a requested action/i);
    assert.equal(answerPayload.interactionStage, scenario.analysis.interactionStage);
    assert.equal(answerPayload.desiredOutcome, scenario.analysis.desiredOutcome);
    assert.equal(answerPayload.customerEmotion, scenario.analysis.customerEmotion);
    assert.equal(result.reply, scenario.answer.reply);
    assert.equal(result.offerCalculation, null);
  }

  assert.match(scenarios[0].answer.reply, /Vad vill du ha hjälp med/i);
  assert.doesNotMatch(scenarios[0].answer.reply, /Hur många abonnemang/i);
  assert.match(scenarios[1].answer.reply, /kan inte ändra/i);
  assert.match(scenarios[1].answer.reply, /supportärende/i);
  assert.match(scenarios[2].answer.reply, /kan inte genomföra en återbetalning/i);
  assert.match(scenarios[2].answer.reply, /kontaktsidan/i);
  assert.doesNotMatch(scenarios[3].answer.reply, /Hur många abonnemang/i);
  assert.match(scenarios[3].answer.reply, /mår bra/i);

  console.log('customer service behavior tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
