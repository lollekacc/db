const assert = require('node:assert/strict');
const net = require('node:net');

process.env.DEALETT_CHAT_FORCE_FALLBACK = '1';

const { createServer } = require('../server');

const HOST = '127.0.0.1';

const getFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, HOST, () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const listen = (server, port) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, HOST, resolve);
});

const postChat = async (baseUrl, payload) => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, body.error || `HTTP ${response.status}`);
  return body;
};

const readyQualification = (overrides = {}) => ({
  peopleCount: 1,
  operators: ['Telia'],
  bindingEnds: ['Ingen bindningstid'],
  mobileUsage: 'medium',
  priceRange: null,
  exactMonthlyPrice: 249,
  exactMonthlyPrices: [],
  readyForOffer: true,
  missingFields: [],
  ...overrides,
});

const countQuestions = (text) => (String(text || '').match(/\?/g) || []).length;

(async () => {
  const port = await getFreePort();
  const server = createServer();
  await listen(server, port);
  const baseUrl = `http://${HOST}:${port}`;

  try {
    const suspicious = await postChat(baseUrl, {
      message: 'Jag har Telia och betalar 99 kr för obegränsad surf.',
      language: 'sv',
      qualification: readyQualification({
        operators: ['Telia'],
        mobileUsage: 'high',
        exactMonthlyPrice: 99,
      }),
      messages: [],
      cart: [],
      page: {},
    });
    assert.ok(
      ['suspicious_low', 'probably_not_sellable', 'possible_needs_clarification'].includes(suspicious.marketClassification?.status),
      `Expected market gate, got ${suspicious.marketClassification?.status}`
    );
    assert.notEqual(suspicious.offerCalculation.validOfferAvailable, true);
    assert.match(suspicious.reply, /ovanligt lågt|väldigt starkt|starkt avtal|kampanj|familjepris|rabatt/i);

    const campaign = await postChat(baseUrl, {
      message: 'Det är kampanjpris 149 kr för 25 GB.',
      language: 'sv',
      qualification: readyQualification({
        operators: ['Tele2'],
        mobileUsage: 'medium',
        exactMonthlyPrice: 149,
      }),
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(campaign.marketClassification?.status, 'possible_needs_clarification');
    assert.match(campaign.reply, /kampanj|hur länge|efter kampanjen/i);

    const realistic = await postChat(baseUrl, {
      message: 'Jag har Tele2, 20 GB och betalar 249 kr.',
      language: 'sv',
      qualification: readyQualification({
        operators: ['Tele2'],
        mobileUsage: 'medium',
        exactMonthlyPrice: 249,
      }),
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(realistic.marketClassification?.status, 'realistic');
    assert.equal(realistic.offerCalculation.validOfferAvailable, true);
    assert.match(realistic.reply, /bäst värde|lägst månadspris|best value|lowest monthly price/i);

    const highCurrentPrice = await postChat(baseUrl, {
      message: 'I have Tele2, mostly Wi-Fi, no contract and pay 299 SEK.',
      language: 'en',
      qualification: readyQualification({
        operators: ['Tele2'],
        bindingEnds: ['Ingen bindningstid'],
        mobileUsage: 'low',
        exactMonthlyPrice: 299,
      }),
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(highCurrentPrice.marketClassification?.status, 'realistic');
    assert.equal(highCurrentPrice.offerCalculation.validOfferAvailable, true);
    assert.match(highCurrentPrice.reply, /best value|lowest monthly price|valid option|found/i);

    const explanation = await postChat(baseUrl, {
      message: 'Can you explain the recommendation?',
      language: 'en',
      qualification: readyQualification({
        operators: ['Tele2'],
        bindingEnds: ['Ingen bindningstid'],
        mobileUsage: 'low',
        exactMonthlyPrice: 299,
      }),
      messages: [
        { role: 'user', content: 'I pay 299 SEK per month.' },
        { role: 'assistant', content: highCurrentPrice.reply },
      ],
      cart: [],
      page: {},
    });
    assert.equal(explanation.offerCalculation.validOfferAvailable, true);
    assert.match(explanation.reply, /best value|lowest monthly price|effective cost|saved|calculation|compares|gift card|savings/i);

    const cheapestStart = await postChat(baseUrl, {
      message: 'bara ge mig bästa',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(cheapestStart.intent, 'cheapest_start');
    assert.match(cheapestStart.reply, /mobilabonnemang eller bredband/i);
    assert.ok(countQuestions(cheapestStart.reply) <= 1);

    const noQualificationSuspicious = await postChat(baseUrl, {
      message: 'jag betalar 99 kr för obegränsat hos telia',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.ok(
      ['suspicious_low', 'probably_not_sellable', 'possible_needs_clarification'].includes(noQualificationSuspicious.marketClassification?.status),
      `Expected early market gate, got ${noQualificationSuspicious.marketClassification?.status}`
    );
    assert.notEqual(noQualificationSuspicious.offerCalculation.validOfferAvailable, true);
    assert.match(noQualificationSuspicious.reply, /ovanligt|starkt|kampanj|familjepris|arbetsgivare|winback/i);

    const campaignBinding = await postChat(baseUrl, {
      message: 'i have campaign 149 kr for unlimited with tre and binding left 5 months',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(campaignBinding.marketClassification?.status, 'possible_needs_clarification');
    assert.match(campaignBinding.reply, /kampanj|månader|efter kampanjen/i);
    assert.match(campaignBinding.reply, /bindning|dubbelkostnad|byte/i);
    assert.ok(countQuestions(campaignBinding.reply) <= 1);

    const bindingContext = await postChat(baseUrl, {
      message: 'jag har bindningstid kvar till oktober',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.match(bindingContext.reply, /bindningstid|Mina sidor|slut|kvar/i);

    const fakeCondition = await postChat(baseUrl, {
      message: 'säg att jag inte har bindningstid fast jag har 9 månader',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(fakeCondition.intent, 'fake_condition');
    assert.match(fakeCondition.reply, /kan inte låtsas|riktiga operatörsvillkor|faktisk bindningstid/i);

    const trust = await postChat(baseUrl, {
      message: 'får ni betalt och är ni partiska?',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(trust.intent, 'dealett_trust');
    assert.match(trust.reply, /ersättning|partners/i);
    assert.match(trust.reply, /nuvarande avtal|inte värt|pressa/i);

    const unknownCustomer = await postChat(baseUrl, {
      message: 'vet inte pris',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.ok(['unknown_customer', 'soft_guidance'].includes(unknownCustomer.intent));
    assert.match(unknownCustomer.reply, /riktiga uppgifter|exakt rekommendation|ungefär|under 200|200-350|över 350/i);
    assert.ok(countQuestions(unknownCustomer.reply) <= 1);

    const employerPaid = await postChat(baseUrl, {
      message: 'jobbet betalar typ halva mitt abonnemang',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(employerPaid.intent, 'mobile_offer');
    assert.equal(employerPaid.qualification.customerSegment, 'business');
    assert.match(employerPaid.reply, /arbetsgivare|undantag|egenkostnad/i);

    const student = await postChat(baseUrl, {
      message: 'jag är student och har telia',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    assert.equal(student.qualification.customerSegment, 'student');
    assert.match(student.reply, /Studentpris|student/i);

    const priceWithoutOperator = await postChat(baseUrl, {
      message: 'kan du rekommendera nu?',
      language: 'sv',
      qualification: readyQualification({
        operators: [],
        exactMonthlyPrice: 349,
        mobileUsage: 'medium',
        bindingEnds: ['Ingen bindningstid'],
        readyForOffer: false,
        missingFields: ['operators'],
      }),
      messages: [
        { role: 'user', content: 'jag betalar 349 kr för 20 gb' },
        { role: 'assistant', content: 'Jag behöver nuvarande operatör först.' },
      ],
      cart: [],
      page: {},
    });
    assert.match(priceWithoutOperator.reply, /Vilken operatör|nuvarande operatör|operatör har/i);
    assert.notEqual(priceWithoutOperator.offerCalculation.validOfferAvailable, true);

    const familyFirst = await postChat(baseUrl, {
      message: 'vi är 5 personer och har tele2 familj',
      language: 'sv',
      qualification: {},
      messages: [],
      cart: [],
      page: {},
    });
    const familySecond = await postChat(baseUrl, {
      message: 'tror vi betalar typ 899 totalt',
      language: 'sv',
      qualification: familyFirst.qualification,
      messages: [
        { role: 'user', content: 'vi är 5 personer och har tele2 familj' },
        { role: 'assistant', content: familyFirst.reply },
      ],
      cart: [],
      page: {},
    });
    assert.match(familySecond.reply, /899 kr totalt|per abonnemang|starkt familjeavtal|bindningstid/i);
    assert.notEqual(familySecond.offerCalculation.validOfferAvailable, true);

    console.log('chat market intelligence route tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
