const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = 'test-key';
const { createChatCompletion, setOpenAiTransportForTests } = require('./chat-service');
const { calculateOfferOptions, buildCartItemFromCalculatedOffer } = require('./offer-calculator');
const { normalizeQualification } = require('./qualification-service');

let analyzed = {};
let replyPayload;
setOpenAiTransportForTests(async (_url, options) => {
  const request = JSON.parse(options.body);
  let output;
  if (request.text.format.name === 'dealett_customer_need') {
    assert.ok(request.text.format.schema.required.includes('offerPreference'));
    assert.match(request.input[0].content, /Treat streaming, watching streaming, and streamar as interest in streaming services/);
    assert.ok(request.text.format.schema.properties.qualification.required.includes('monthlyBudget'));
    output = {
      interactionStage: 'solve', recommendationRequested: true,
      offerPreference: 'preview', resetRequested: false,
      quizAnswerDecision: 'unresolved', qualification: {}, ...analyzed,
    };
  } else {
    replyPayload = JSON.parse(request.input.at(-1).content);
    output = {
      reply: 'Här är exempelerbjudanden, inte en skräddarsydd jämförelse. Besparing och möjlighet att byta är inte kontrollerade.',
      showOfferCards: false, quickReplies: [],
      bestMatchBenefits: [], lowestEffectiveCostBenefits: [],
      offerCardCopy: {
        dataTitle: 'Surf', monthlyPriceTitle: 'Pris', totalPriceTitle: 'Totalt',
        perPersonPriceTitle: 'Per person', perPersonSuffix: '/person/mån',
        perMonthSuffix: '/mån', bindingTitle: 'Bindningstid', bindingMonthsSuffix: ' månader',
        ctaLabel: 'Välj erbjudande',
      },
    };
  }
  return { ok: true, json: async () => ({ output_text: JSON.stringify(output) }) };
});

const assertPreview = (response) => {
  assert.equal(response.offerCalculation.recommendationMode, 'preview');
  assert.equal(response.offerCalculation.personalized, false);
  assert.equal(response.embeddedWidget, null);
  assert.equal(response.flowState.activeQuestionField, null);
  assert.equal(replyPayload.adaptiveQuestionPlan, null);
  assert.equal(replyPayload.exactMobileRecommendationCalculation.recommendationMode, 'preview');
  for (const offer of response.offerCalculation.featuredOffers) {
    assert.equal(offer.monthlySavings, null);
    assert.equal(offer.effectiveMonthlyCost, null);
    assert.equal(offer.switchNowPeopleCount, 0);
  }
  for (const card of response.offerCards) {
    assert.equal(card.recommendationType, 'example_offer');
    assert.match(card.resultLabel, /inte skräddarsytt/);
    assert.equal(card.effectiveCostLabel, '');
  }
};

(async () => {
  for (const message of ['tack, jag vill ha abonnemang', 'Jag vill ha ett abonnemang', 'Vi vill ha abonnemang', 'I want a subscription']) {
    for (const interactionStage of ['understand', 'solve']) {
      analyzed = { interactionStage, offerPreference: null, qualification: {} };
      const result = await createChatCompletion({ message });
      assert.equal(result.qualification.peopleCount, null);
      assert.equal(result.offerCalculation, null);
      assert.deepEqual(result.offerCards, []);
      assert.equal(result.flowState.activeQuestionField, 'peopleCount');
      assert.deepEqual(result.quickReplies.map((reply) => reply.label), Array.from({ length: 10 }, (_, index) => String(index + 1)));
      assert.ok(result.quickReplies.every((reply) => reply.action === 'send_message'));
      assert.equal(replyPayload.adaptiveQuestionPlan.qualificationField, 'peopleCount');
    }
  }

  const familyQuestion = 'Vi är fyra i familjen och har idag olika operatörer. Två använder mycket surf och streamar mycket, en använder nästan inget och en reser ganska ofta utomlands. Vi vill helst samla allt på en faktura och hålla oss under 1 500 kr i månaden. Vi behöver inga nya telefoner. Vilket abonnemang eller familjeupplägg passar oss bäst, och vilket alternativ ger mest värde totalt?';
  const familyNeeds = {
    peopleCount: 4,
    mobileUsage: 'high',
    streamingCalculation: 'include',
    monthlyBudget: { amount: 1500, scope: 'total', inclusive: false },
    people: [
      { dataNeed: 'high' }, { dataNeed: 'high' }, { dataNeed: 'low' }, {},
    ],
  };
  analyzed = { offerPreference: 'preview', qualification: familyNeeds };
  const family = await createChatCompletion({ message: familyQuestion });
  assertPreview(family);
  assert.equal(family.offerCards.length, 2);
  assert.ok(family.offerCalculation.featuredOffers.every((offer) => offer.peopleCount === 4 && offer.planMonthlyPrice < 1500));
  assert.equal(family.qualification.monthlyBudget.amount, 1500);
  assert.equal(family.qualification.exactMonthlyPrice, null);
  assert.deepEqual(family.qualification.operators, []);
  assert.deepEqual(family.qualification.bindingEnds, []);
  assert.equal(family.qualification.internationalTravel, null);
  assert.deepEqual(family.qualification.streamingServices, []);
  assert.equal(family.qualification.streamingCalculation, 'include');
  const streamingAlternative = family.offerCalculation.featuredOffers.find((offer) => offer.operator === 'Telia');
  assert.ok(streamingAlternative);
  assert.equal(streamingAlternative.sourcePlanId, 'telia-unlimited-plus-streaming-bundle');
  assert.equal(streamingAlternative.streamingSavings, 0);
  assert.equal(streamingAlternative.effectiveMonthlyCost, null);
  assert.equal(streamingAlternative.recommendationType, 'best_streaming_alternative');
  const previewStreaming = (overrides) => calculateOfferOptions(normalizeQualification({
    ...familyNeeds, recommendationMode: 'preview', ...overrides,
  }));
  const rejectedStreaming = previewStreaming({ streamingCalculation: 'none' });
  assert.ok(rejectedStreaming.featuredOffers.every((offer) => offer.recommendationType !== 'best_streaming_alternative'));
  const constrainedStreaming = previewStreaming({ monthlyBudget: { amount: 900, scope: 'total', inclusive: false } });
  assert.ok(constrainedStreaming.featuredOffers.every((offer) => offer.planMonthlyPrice < 900));
  assert.ok(constrainedStreaming.featuredOffers.every((offer) => offer.operator !== 'Telia'));
  const namedStreaming = previewStreaming({ streamingServices: ['netflix'] });
  assert.ok(namedStreaming.featuredOffers.some((offer) => offer.includedStreamingServices.includes('Netflix')));
  assert.ok(namedStreaming.featuredOffers.every((offer) => offer.streamingSavings === 0));
  for (const activeQuestionField of ['priceRange', 'bindingEnds', 'streamingPrices', 'internationalTravel']) {
    const resumed = await createChatCompletion({
      message: familyQuestion,
      flowState: { inProgress: true, activeQuestionField, attempts: { [activeQuestionField]: 2 } },
    });
    assertPreview(resumed);
    assert.equal(resumed.offerCards.length, 2);
  }

  const known = { peopleCount: 3, mobileUsage: 'high', monthlyBudget: { amount: 1500, scope: 'total', inclusive: false } };
  analyzed = { offerPreference: 'preview', qualification: known };
  const first = await createChatCompletion({ message: 'Jag vill ha abonnemang för 3 personer med obegränsad surf under 1500 kr.' });
  assertPreview(first);
  assert.equal(first.offerCards.length, 2);
  assert.equal(first.qualification.readyForOffer, false);
  assert.equal(first.qualification.exactMonthlyPrice, null);
  assert.deepEqual(first.qualification.exactMonthlyPrices, []);
  assert.ok(first.qualification.missingFields.includes('priceRange'));
  assert.deepEqual(first.offerCalculation.featuredOffers.map((offer) => offer.planMonthlyPrice), [727, 737]);
  assert.ok(first.offerCalculation.featuredOffers.every((offer) => offer.peopleCount === 3 && offer.dataType === 'unlimited' && offer.planMonthlyPrice < 1500));

  analyzed = {};
  for (const field of ['priceRange', 'operators', 'bindingEnds', 'mobileUsage', 'streamingCalculation', 'internationalTravel']) {
    const result = await createChatCompletion({
      message: 'Jag vill inte svara, visa bara erbjudanden utifrån det du vet.',
      qualification: known,
      flowState: { inProgress: true, activeQuestionField: field, attempts: { [field]: 2 } },
    });
    assertPreview(result);
    assert.equal(result.offerCards.length, 2);
    assert.equal(result.qualification.monthlyBudget.amount, 1500);
  }

  analyzed = { offerPreference: null };
  const continued = await createChatCompletion({ message: 'Visa alternativen igen', qualification: first.qualification });
  assertPreview(continued);
  assert.equal(continued.offerCards.length, 2);

  analyzed = { offerPreference: 'personalized' };
  const refined = await createChatCompletion({ message: 'Nu vill jag göra en personlig jämförelse', qualification: first.qualification });
  assert.equal(refined.qualification.recommendationMode, 'refined');
  assert.equal(refined.offerCalculation, null);
  assert.ok(refined.flowState.activeQuestionField);

  analyzed = {};
  const generic = await createChatCompletion({ message: 'Hej ge mig ett offer nu!' });
  assertPreview(generic);
  assert.equal(generic.offerCards.length, 2);
  assert.equal(generic.qualification.peopleCount, null);
  assert.equal(generic.offerCalculation.assumedPeopleCount, 1);
  assert.deepEqual(generic.qualification.operators, []);
  assert.deepEqual(generic.qualification.bindingEnds, []);

  const withQuiz = await createChatCompletion({
    message: 'Ge mig bara ett exempel utan frågor',
    context: { quizAnswersStatus: 'unconfirmed', historicalQuizQualification: { peopleCount: 8 } },
  });
  assertPreview(withQuiz);
  assert.equal(withQuiz.qualification.peopleCount, null);
  assert.equal(replyPayload.context.quizConsentRequired, false);

  analyzed = { qualification: { monthlyBudget: { amount: 100, scope: 'total', inclusive: false } } };
  const impossible = await createChatCompletion({ message: 'Jag vill ha allt för under 100 kr', qualification: first.qualification });
  assertPreview(impossible);
  assert.equal(impossible.offerCalculation.validOfferAvailable, false);
  assert.deepEqual(impossible.offerCards, []);

  analyzed = { qualification: { monthlyBudget: { amount: null, scope: 'total', inclusive: false } } };
  const noBudget = await createChatCompletion({ message: 'Ta bort budgeten', qualification: first.qualification });
  assert.equal(noBudget.qualification.monthlyBudget, null);
  assert.equal(noBudget.offerCards.length, 2);

  const calculate = (overrides = {}) => calculateOfferOptions(normalizeQualification({ ...known, recommendationMode: 'preview', ...overrides }));
  const exclusive = calculate({ monthlyBudget: { amount: 727, scope: 'total', inclusive: false } });
  assert.equal(exclusive.featuredOffers.length, 0);
  const inclusive = calculate({ monthlyBudget: { amount: 727, scope: 'total', inclusive: true } });
  assert.equal(inclusive.featuredOffers.length, 1);
  const perPerson = calculate({ monthlyBudget: { amount: 250, scope: 'per_person', inclusive: false } });
  assert.equal(perPerson.featuredOffers.length, 2);
  assert.ok(perPerson.featuredOffers.every((offer) => offer.pricePerPerson < 250));
  const partialPeople = calculate({ people: [{ dataNeed: 'high', currentMonthlyCost: 100, remainingBindingMonths: 24 }] });
  assert.ok(partialPeople.featuredOffers.every((offer) => offer.peopleCount === 3));
  const cart = buildCartItemFromCalculatedOffer({ qualification: first.qualification, planId: first.offerCards[0].planId });
  assert.equal(cart.cartItem.persons, 3);
  assert.equal(cart.cartItem.monthlyPrice, 727);

  analyzed = { interactionStage: 'greeting', recommendationRequested: false, offerPreference: null };
  const greeting = await createChatCompletion({ message: 'Hej' });
  assert.equal(greeting.offerCalculation, null);
  assert.deepEqual(greeting.offerCards, []);
  analyzed = { interactionStage: 'close', recommendationRequested: false, offerPreference: null };
  const stop = await createChatCompletion({ message: 'Sluta', qualification: first.qualification });
  assert.equal(stop.offerCalculation, null);
  assert.deepEqual(stop.offerCards, []);
  console.log('chat preview tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
