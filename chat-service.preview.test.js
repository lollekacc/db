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
  const known = { peopleCount: 3, mobileUsage: 'high', monthlyBudget: { amount: 1500, scope: 'total', inclusive: false } };
  analyzed = { qualification: known };
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
