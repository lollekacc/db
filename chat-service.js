const fs = require('node:fs');
const path = require('node:path');

const { calculateOfferOptions } = require('./offer-calculator');
const { getPlanCatalog } = require('./offer-service');
const { createEmptyQualification, normalizeQualification } = require('./qualification-service');
const { languageNames } = require('./translation-service');
const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
} = require('./src/chat-ui-response');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const MAX_KNOWLEDGE_CHARACTERS = 18_000;
const WEBSITE_SOURCES = {
  siteContent: path.join(__dirname, 'chat', 'site-content.json'),
  websiteMap: path.join(__dirname, 'chat', 'website-map.json'),
  dealettProfile: path.join(__dirname, 'chat', 'dealett-profile.json'),
  broadbandRequirements: path.join(__dirname, 'chat', 'broadband-requirements.json'),
  broadbandPlans: path.join(__dirname, 'data', '5Gbredband.json'),
};

let openAiTransport = (...args) => fetch(...args);

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const loadWebsiteData = () => Object.fromEntries(
  Object.entries(WEBSITE_SOURCES).map(([name, filePath]) => [name, readJson(filePath)])
);

const websiteData = loadWebsiteData();

const toKnowledgeChunks = (value, source, location = source) => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => toKnowledgeChunks(item, source, `${location}[${index}]`));
  }
  if (value && typeof value === 'object') {
    const serialized = JSON.stringify(value);
    if (serialized.length <= 2200) return [{ source, location, text: serialized }];
    return Object.entries(value).flatMap(([key, item]) => toKnowledgeChunks(item, source, `${location}.${key}`));
  }
  return [{ source, location, text: String(value ?? '') }];
};

const knowledgeChunks = Object.entries(websiteData)
  .flatMap(([source, value]) => toKnowledgeChunks(value, source));

const getSearchTerms = (value) => [...new Set(String(value || '')
  .toLocaleLowerCase('sv')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/)
  .filter((term) => term.length > 2))];

const retrieveWebsiteKnowledge = ({ query, page = {} }) => {
  const terms = getSearchTerms(`${query} ${page.path || ''} ${page.title || ''}`);
  const ranked = knowledgeChunks.map((chunk, index) => {
    const haystack = `${chunk.location} ${chunk.text}`
      .toLocaleLowerCase('sv')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 2 : 0), 0) +
      (page.path && haystack.includes(String(page.path).toLowerCase()) ? 8 : 0) +
      (chunk.source === 'dealettProfile' ? 1 : 0);
    return { ...chunk, score, index };
  }).sort((left, right) => right.score - left.score || left.index - right.index);

  const selected = [];
  let size = 0;
  for (const chunk of ranked) {
    if (selected.length >= 18) break;
    const entry = `[${chunk.location}] ${chunk.text}`;
    if (size + entry.length > MAX_KNOWLEDGE_CHARACTERS) continue;
    if (chunk.score <= 0 && selected.length >= 8) continue;
    selected.push(entry);
    size += entry.length;
  }
  return selected.join('\n');
};

const trimMessages = (messages = []) => Array.isArray(messages)
  ? messages.slice(-10).map((item) => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: String(item.content || '').slice(0, 1600),
  })).filter((item) => item.content)
  : [];

const extractOutputText = (response) => {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && content.text)
    .map((content) => content.text)
    .join('\n')
    .trim();
};

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

const personQualificationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: nullableString,
    label: nullableString,
    currentOperator: nullableString,
    currentMonthlyCost: nullableNumber,
    bindingEnd: nullableString,
    remainingBindingMonths: nullableNumber,
    noticePeriodMonths: nullableNumber,
    dataNeed: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
    requiredDataGb: nullableNumber,
    keepNumberPreference: {
      type: ['string', 'null'],
      enum: ['port_number', 'scheduled_port', 'temporary_number', 'new_number', 'exclude', null],
    },
    mustKeepNumber: { type: ['boolean', 'null'] },
    numberOwnerConfirmed: { type: ['boolean', 'null'] },
    hasAddOns: { type: ['boolean', 'null'] },
    addOnMonthlyCost: nullableNumber,
    devicePaymentMonthlyCost: nullableNumber,
    devicePaymentRemainingMonths: nullableNumber,
    coverageLocations: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    existingCustomer: { type: ['boolean', 'null'] },
    excluded: { type: ['boolean', 'null'] },
  },
  required: [
    'id', 'label', 'currentOperator', 'currentMonthlyCost', 'bindingEnd',
    'remainingBindingMonths', 'noticePeriodMonths', 'dataNeed', 'requiredDataGb',
    'keepNumberPreference', 'mustKeepNumber', 'numberOwnerConfirmed', 'hasAddOns',
    'addOnMonthlyCost', 'devicePaymentMonthlyCost', 'devicePaymentRemainingMonths',
    'coverageLocations', 'existingCustomer', 'excluded',
  ],
};

const qualificationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    peopleCount: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
    people: { type: 'array', items: personQualificationSchema, maxItems: 10 },
    operators: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    bindingEnds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    mobileUsage: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
    requiredDataGb: nullableNumber,
    priceRange: { type: ['string', 'null'], enum: ['under300', '300-400', '400-500', null] },
    streamingCalculation: { type: ['string', 'null'], enum: ['none', 'include', 'unknown', null] },
    streamingServices: {
      type: 'array',
      items: { type: 'string', enum: ['netflix', 'hbo', 'disney', 'amazon', 'tv4'] },
      uniqueItems: true,
    },
    streamingMonthlyCosts: {
      type: 'object',
      additionalProperties: false,
      properties: {
        netflix: nullableNumber,
        hbo: nullableNumber,
        disney: nullableNumber,
        amazon: nullableNumber,
        tv4: nullableNumber,
      },
      required: ['netflix', 'hbo', 'disney', 'amazon', 'tv4'],
    },
    internationalTravel: { type: ['string', 'null'], enum: ['none', 'eu', 'outside_eu', null] },
    internationalUsage: { type: ['string', 'null'], enum: ['calls', 'data', null] },
    exactMonthlyPrice: nullableNumber,
    exactMonthlyPrices: { type: 'array', items: { type: 'number' }, maxItems: 10 },
    customerSegment: {
      type: ['string', 'null'],
      enum: ['private', 'family', 'student', 'senior', 'youth', 'child', 'business', null],
    },
    familyTotalPrice: nullableNumber,
    operatorAppliesToAll: { type: 'boolean' },
    bindingAppliesToAll: { type: 'boolean' },
    priceAppliesToAll: { type: 'boolean' },
  },
  required: [
    'peopleCount', 'people', 'operators', 'bindingEnds', 'mobileUsage', 'requiredDataGb', 'priceRange',
    'streamingCalculation', 'streamingServices', 'streamingMonthlyCosts', 'internationalTravel',
    'internationalUsage', 'exactMonthlyPrice', 'exactMonthlyPrices', 'customerSegment',
    'familyTotalPrice', 'operatorAppliesToAll', 'bindingAppliesToAll', 'priceAppliesToAll',
  ],
};

const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    topic: { type: 'string' },
    recommendationRequested: { type: 'boolean' },
    knowledgeQuery: { type: 'string' },
    qualification: qualificationSchema,
  },
  required: ['topic', 'recommendationRequested', 'knowledgeQuery', 'qualification'],
};

const answerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', minLength: 1 },
    quickReplies: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    bestValueReason: { type: 'string' },
    lowestPriceReason: { type: 'string' },
    bestValueBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    lowestPriceBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
  },
  required: [
    'reply', 'quickReplies', 'bestValueReason', 'lowestPriceReason',
    'bestValueBenefits', 'lowestPriceBenefits',
  ],
};

const callOpenAi = async ({ schemaName, schema, input, maxOutputTokens }) => {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('AI chat is unavailable because OPENAI_API_KEY is not configured');
    error.statusCode = 503;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await openAiTransport(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        input,
        max_output_tokens: maxOutputTokens,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`OpenAI request failed with status ${response.status}`);
      error.statusCode = 502;
      throw error;
    }
    const outputText = extractOutputText(body);
    if (!outputText) {
      const error = new Error('OpenAI returned no chat output');
      error.statusCode = 502;
      throw error;
    }
    return JSON.parse(outputText);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('OpenAI request timed out');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    if (!error.statusCode) error.statusCode = 502;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const cleanAiQualification = (qualification = {}) => ({
  ...qualification,
  streamingMonthlyCosts: Object.fromEntries(Object.entries(qualification.streamingMonthlyCosts || {})
    .filter(([, value]) => Number(value) > 0)),
});

const mergeArrays = (current = [], next = []) => {
  const values = [...(Array.isArray(current) ? current : []), ...(Array.isArray(next) ? next : [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, 10);
};

const detectOfflineOperators = (text) => {
  const operators = [];
  [
    ['Tele2', /\btele\s*2\b|\btele2\b/i],
    ['Telia', /\btelia\b/i],
    ['Telenor', /\btelenor\b/i],
    ['Tre', /\btre\b|\b3\b/i],
  ].forEach(([operator, pattern]) => {
    if (pattern.test(text)) operators.push(operator);
  });
  return operators;
};

const detectOfflinePeopleCount = (text) => {
  const direct = text.match(/\b(?:vi\s+är|we\s+are|for)\s*(\d{1,2})\b/i) ||
    text.match(/\b(\d{1,2})\s*(?:personer|person|abonnemang|users?|lines?)\b/i);
  if (direct) return Math.min(Math.max(Number(direct[1]) || 1, 1), 10);
  if (/familj|family|hushåll|household/i.test(text)) return 2;
  if (/bara mig|just me|only me|ensam/i.test(text)) return 1;
  return null;
};

const detectOfflineMonthlyPrice = (text) => {
  const match = text.match(/\b(\d{2,5})\s*(?:kr|sek|kronor)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const detectOfflineUsage = (text) => {
  const gb = text.match(/\b(\d{1,3})\s*gb\b/i);
  if (gb) {
    const amount = Number(gb[1]);
    if (amount >= 50) return { mobileUsage: 'high', requiredDataGb: amount };
    if (amount >= 20) return { mobileUsage: 'medium', requiredDataGb: amount };
    return { mobileUsage: 'low', requiredDataGb: amount };
  }
  if (/obegränsad|unlimited|mycket surf|lots of data|max surf/i.test(text)) {
    return { mobileUsage: 'high', requiredDataGb: null };
  }
  if (/stream|video|youtube|netflix|pendlar|commute/i.test(text)) {
    return { mobileUsage: 'medium', requiredDataGb: null };
  }
  if (/wifi|wi-fi|lite surf|mostly wi|social|mail/i.test(text)) {
    return { mobileUsage: 'low', requiredDataGb: null };
  }
  return {};
};

const detectOfflineBindingEnds = (text, peopleCount) => {
  if (/ingen bindning|utan bindning|no contract|no binding/i.test(text)) return ['Ingen bindningstid'];
  const months = text.match(/\b(\d{1,2})\s*(?:mån|månader|months?)\b/i);
  if (months && /bindning|contract/i.test(text)) return [`${Number(months[1])} månader kvar`];
  if (/vet inte.*bindning|don't know.*contract|dont know.*contract/i.test(text)) return ['Vet inte'];
  if (peopleCount && /bindning/i.test(text)) return ['Vet inte'];
  return [];
};

const getOfflinePriceRange = (price) => {
  if (!price) return null;
  if (price < 300) return 'under300';
  if (price <= 400) return '300-400';
  if (price <= 500) return '400-500';
  return null;
};

const improveOfflineQualification = ({ message, qualification }) => {
  const text = String(message || '');
  const current = normalizeQualification(qualification);
  const peopleCount = detectOfflinePeopleCount(text) || current.peopleCount;
  const operators = mergeArrays(current.operators, detectOfflineOperators(text));
  const price = detectOfflineMonthlyPrice(text) || current.exactMonthlyPrice;
  const usage = detectOfflineUsage(text);
  const bindingEnds = mergeArrays(
    current.bindingEnds,
    detectOfflineBindingEnds(text, peopleCount)
  );
  const customerSegment = /student/i.test(text)
    ? 'student'
    : (/senior|pension/i.test(text)
      ? 'senior'
      : (/företag|jobb|arbetsgivare|business|employer/i.test(text)
        ? 'business'
        : (peopleCount > 1 ? 'family' : current.customerSegment)));

  return normalizeQualification({
    ...current,
    peopleCount,
    operators,
    bindingEnds,
    people: [],
    mobileUsage: usage.mobileUsage || current.mobileUsage,
    requiredDataGb: usage.requiredDataGb || current.requiredDataGb,
    exactMonthlyPrice: price,
    priceRange: current.priceRange || getOfflinePriceRange(price),
    customerSegment,
  });
};

const getOfflineTopic = (message) => {
  if (/bredband|5g|fiber|internet|täckning|coverage/i.test(message)) return 'broadband_or_coverage';
  if (/faktura|autogiro|esim|sim|pin|order|beställning|kundservice|support|mina sidor/i.test(message)) return 'support';
  if (/partisk|betalt|provision|biased|trust/i.test(message)) return 'dealett_trust';
  return 'mobile_plan_comparison';
};

const wantsOfflineRecommendation = (message, context = {}) => (
  context?.quizHandoff === true ||
  /abonnemang|billigare|bästa|rekommendera|jämför|mobil|surf|operator|plan|cheaper|best|recommend|compare/i.test(message)
);

const getOfflineQuestion = (qualification, language) => {
  const missing = qualification.missingFields || [];
  const isEnglish = language === 'en';
  if (missing.includes('peopleCount')) {
    return {
      reply: isEnglish
        ? 'I can help. Is it just for you or for several people?'
        : 'Jag hjälper dig. Är det bara till dig eller flera personer?',
      quickReplies: isEnglish ? ['Just me', '2 people', '3 people', 'Family'] : ['Bara mig', '2 personer', '3 personer', 'Familj'],
    };
  }
  if (missing.includes('operators')) {
    return {
      reply: isEnglish
        ? 'Which operator do you have today?'
        : 'Vilken operatör har du idag?',
      quickReplies: ['Telia', 'Tele2', 'Telenor', 'Tre'],
    };
  }
  if (missing.includes('bindingEnds')) {
    return {
      reply: isEnglish
        ? 'Do you have any contract time left?'
        : 'Har du bindningstid kvar?',
      quickReplies: isEnglish ? ['No contract', "Don't know", '3 months left'] : ['Ingen bindningstid', 'Vet inte', '3 månader kvar'],
    };
  }
  if (missing.includes('mobileUsage')) {
    return {
      reply: isEnglish
        ? 'How much data do you usually need?'
        : 'Hur mycket surf brukar du behöva?',
      quickReplies: isEnglish ? ['Mostly Wi-Fi', 'Streaming/video', 'Unlimited'] : ['Mest wifi', 'Streaming/video', 'Obegränsat'],
    };
  }
  return {
    reply: isEnglish
      ? 'What do you pay per month today? An approximate amount is enough.'
      : 'Vad betalar du per månad idag? Ungefär räcker.',
    quickReplies: isEnglish ? ['Under 300 SEK', '300-400 SEK', '400-500 SEK'] : ['Under 300 kr', '300-400 kr', '400-500 kr'],
  };
};

const createOfflineAnswer = ({ message, language, topic, qualification, offerCalculation }) => {
  const isEnglish = language === 'en';
  if (topic === 'dealett_trust') {
    return {
      reply: isEnglish
        ? 'Dealett may receive compensation from partners, but the recommendation should still be based on your current deal, contract time, usage and total cost. If your current deal is stronger, I should say so.'
        : 'Dealett kan få ersättning från partners, men rekommendationen ska ändå styras av ditt nuvarande avtal, bindningstid, surfbehov och total kostnad. Är ditt avtal bättre ska jag säga det.',
      quickReplies: isEnglish ? ['Compare my deal', 'How do you calculate?'] : ['Jämför mitt avtal', 'Hur räknar ni?'],
    };
  }
  if (topic === 'support') {
    return {
      reply: isEnglish
        ? 'I can guide you, but I cannot change account details in the chat. For invoices, SIM, orders or autogiro, use your operator account page and verify with customer service if money or ownership is involved.'
        : 'Jag kan guida dig, men jag kan inte ändra kontouppgifter i chatten. För faktura, SIM, beställning eller autogiro: använd operatörens Mina sidor och kontrollera med kundservice om pengar eller ägarskap påverkas.',
      quickReplies: isEnglish ? ['Compare subscriptions', 'Contact support'] : ['Jämför abonnemang', 'Kontakta support'],
    };
  }
  if (topic === 'broadband_or_coverage') {
    return {
      reply: isEnglish
        ? 'For coverage and 5G broadband, address-level availability matters more than the headline price. Check the address or area first, then compare monthly cost, binding time and equipment fees.'
        : 'För täckning och 5G-bredband avgör adressen mer än rubrikpriset. Kolla adress eller område först, jämför sedan månadskostnad, bindningstid och utrustningsavgifter.',
      quickReplies: isEnglish ? ['Open coverage map', 'Compare 5G broadband'] : ['Öppna täckningskarta', 'Jämför 5G-bredband'],
    };
  }
  if (offerCalculation?.validOfferAvailable) {
    const best = offerCalculation.bestValue;
    const low = offerCalculation.lowestMonthlyPrice;
    return {
      reply: isEnglish
        ? `I found options from the plan data. Best value: ${best.operator} ${best.title} at ${best.planMonthlyPrice} SEK/month. Lowest monthly price: ${low.operator} ${low.title} at ${low.planMonthlyPrice} SEK/month. The 24-month view includes new subscription cost, any remaining old costs, fees, gift card value and matched streaming savings.`
        : `Jag hittade alternativ i plandatan. Bäst värde: ${best.operator} ${best.title} för ${best.planMonthlyPrice} kr/mån. Lägst månadspris: ${low.operator} ${low.title} för ${low.planMonthlyPrice} kr/mån. 24-månadersbilden räknar in nytt abonnemang, eventuell kvarvarande gammal kostnad, avgifter, presentkort och matchad streamingbesparing.`,
      quickReplies: isEnglish ? ['Show all operators', 'Explain the calculation'] : ['Visa alla operatörer', 'Förklara kalkylen'],
      bestValueReason: isEnglish
        ? 'Best total fit over 24 months based on the supplied details.'
        : 'Bäst helhet över 24 månader utifrån uppgifterna du gav.',
      lowestPriceReason: isEnglish
        ? 'Lowest monthly plan price that still matches the stated needs.'
        : 'Lägst månadspris som fortfarande matchar behoven.',
      bestValueBenefits: best.benefits || [],
      lowestPriceBenefits: low.benefits || [],
    };
  }
  return getOfflineQuestion(qualification, language);
};

const createOfflineChatCompletion = ({
  message,
  language = 'sv',
  qualification = {},
  context = {},
}) => {
  const normalizedLanguage = languageNames[String(language || '').toLowerCase()]
    ? String(language).toLowerCase()
    : 'sv';
  const topic = getOfflineTopic(message);
  const nextQualification = improveOfflineQualification({ message, qualification });
  const recommendationRequested = wantsOfflineRecommendation(message, context) || nextQualification.readyForOffer;
  const offerCalculation = recommendationRequested
    ? calculateOfferOptions(nextQualification)
    : null;
  const answer = createOfflineAnswer({
    message,
    language: normalizedLanguage,
    topic,
    qualification: nextQualification,
    offerCalculation,
  });
  const offerCards = offerCalculation
    ? buildOfferCardsFromOfferCalculation(offerCalculation, {
      language: normalizedLanguage,
      copy: answer,
    })
    : [];
  const ui = buildChatResponse({
    message: answer.reply,
    quickReplies: answer.quickReplies,
    offerCards,
  });

  return {
    reply: ui.message,
    message: ui.message,
    language: normalizedLanguage,
    topic,
    qualification: nextQualification,
    offerCalculation,
    quickReplies: ui.quickReplies,
    suggestions: ui.quickReplies.map((reply) => reply.label),
    offerCards: ui.offerCards,
    embeddedWidget: null,
    source: 'offline',
    model: 'local-rules',
  };
};

const analyzeCustomerMessage = ({ message, messages, qualification, language, page, context }) => callOpenAi({
  schemaName: 'dealett_customer_need',
  schema: analysisSchema,
  maxOutputTokens: 900,
  input: [
    {
      role: 'system',
      content: [
        'Extract the customer need for Dealett without answering it.',
        'Preserve known qualification values unless the customer clearly changes them.',
        'Only record prices, service usage, travel, data needs, operators, and contract details the customer actually supplied.',
        'If context.quizHandoff is true, continue from the supplied quiz state. Do not restart the quiz and do not ask again for information already present in currentQualification or context.answers.',
        'recommendationRequested is true when the customer asks for, continues, or questions a mobile-plan comparison.',
        'When context.quizHandoff is true, recommendationRequested should be true unless the message is unrelated to mobile recommendations.',
        'Use low/medium/high only when the wording supports it; exact GB is preferred when stated.',
      ].join(' '),
    },
    ...trimMessages(messages),
    {
      role: 'user',
      content: JSON.stringify({
        latestMessage: message,
        language,
        page,
        context,
        currentQualification: qualification,
      }),
    },
  ],
});

const generateAnswer = ({
  message,
  messages,
  language,
  page,
  cart,
  topic,
  qualification,
  offerCalculation,
  websiteKnowledge,
  context,
}) => callOpenAi({
  schemaName: 'dealett_adviser_reply',
  schema: answerSchema,
  maxOutputTokens: 1300,
  input: [
    {
      role: 'system',
      content: [
        `You are Dealett's expert human adviser. Reply naturally in ${languageNames[language]}.`,
        'Use only the supplied website knowledge, mobile-plan catalog, cart context, and exact calculation.',
        'For mobile facts the catalog and calculation override other text. Never invent prices, benefits, savings, coverage, or account details.',
        'Ask one useful question when essential recommendation details are missing.',
        'If the customer came from a quiz handoff, act like an expert in-store salesperson who has the filled form in front of them: continue from the current stage, ask only the next missing question, and never repeat provided answers.',
        'When a calculation exists, explain both best total value and lowest monthly price, including the 24-month formula: new cost + remaining old costs + fees - gift card - matching streaming savings.',
        'Treat all four operators fairly. A higher price can be better value when its included streaming, roaming, calls, shared data, or family terms fit the customer.',
        'Never say a number is locked. Mention number porting, scheduled porting, temporary/new number, or exclusion based on the customer preference and remind them to verify number ownership, add-ons, device payments, and notice periods.',
        'When a calculation exists, include a quick reply in the reply language that lets the customer ask to see all four operators.',
        'Keep the answer concise and conversational. Quick replies must be relevant continuations, not canned defaults.',
      ].join(' '),
    },
    ...trimMessages(messages),
    {
      role: 'user',
      content: JSON.stringify({
        latestMessage: message,
        page,
        context,
        topic,
        qualification,
        missingQualificationFields: qualification.missingFields,
        cart,
        websiteKnowledge,
        mobilePlanCatalog: getPlanCatalog(),
        exactMobileRecommendationCalculation: offerCalculation,
      }),
    },
  ],
});

const createChatCompletion = async ({
  message,
  messages = [],
  language = 'sv',
  page = {},
  cart = [],
  qualification = {},
  context = {},
}) => {
  const latestMessage = String(message || '').trim();
  if (!latestMessage) {
    const error = new Error('Message is required');
    error.statusCode = 400;
    throw error;
  }

  const normalizedLanguage = languageNames[String(language || '').toLowerCase()]
    ? String(language).toLowerCase()
    : 'sv';
  if (!process.env.OPENAI_API_KEY) {
    return createOfflineChatCompletion({
      message: latestMessage,
      language: normalizedLanguage,
      qualification,
      context,
    });
  }

  const currentQualification = normalizeQualification(qualification);
  try {
    const analysis = await analyzeCustomerMessage({
      message: latestMessage,
      messages,
      qualification: currentQualification,
      language: normalizedLanguage,
      page,
      context,
    });
    const nextQualification = normalizeQualification(cleanAiQualification(analysis.qualification));
    const quizHandoff = context?.quizHandoff === true;
    const offerCalculation = (analysis.recommendationRequested || quizHandoff)
      ? calculateOfferOptions(nextQualification)
      : null;
    const websiteKnowledge = retrieveWebsiteKnowledge({
      query: `${latestMessage} ${analysis.knowledgeQuery || ''} ${analysis.topic || ''}`,
      page,
    });
    const answer = await generateAnswer({
      message: latestMessage,
      messages,
      language: normalizedLanguage,
      page,
      cart,
      context,
      topic: analysis.topic,
      qualification: nextQualification,
      offerCalculation,
      websiteKnowledge,
    });
    const offerCards = offerCalculation
      ? buildOfferCardsFromOfferCalculation(offerCalculation, {
        language: normalizedLanguage,
        copy: answer,
      })
      : [];
    const ui = buildChatResponse({
      message: answer.reply,
      quickReplies: answer.quickReplies,
      offerCards,
    });

    return {
      reply: ui.message,
      message: ui.message,
      language: normalizedLanguage,
      topic: analysis.topic,
      qualification: nextQualification,
      offerCalculation,
      quickReplies: ui.quickReplies,
      suggestions: ui.quickReplies.map((reply) => reply.label),
      offerCards: ui.offerCards,
      embeddedWidget: null,
      source: 'openai',
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    };
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) throw error;
    return createOfflineChatCompletion({
      message: latestMessage,
      language: normalizedLanguage,
      qualification,
      context,
    });
  }
};

const setOpenAiTransportForTests = (transport) => {
  openAiTransport = transport || ((...args) => fetch(...args));
};

module.exports = {
  createChatCompletion,
  createEmptyQualification,
  loadWebsiteData,
  normalizeQualification,
  setOpenAiTransportForTests,
};
