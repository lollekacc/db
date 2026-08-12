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
const DEFAULT_MODEL = 'gpt-5.6-terra';
const DEFAULT_ANALYSIS_MODEL = 'gpt-5.6-luna';
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
    priceRange: { type: ['string', 'null'], enum: ['under300', '300-400', '400-500', 'no_limit', null] },
    streamingCalculation: { type: ['string', 'null'], enum: ['none', 'include', 'unknown', null] },
    streamingServices: {
      type: 'array',
      items: { type: 'string', enum: ['netflix', 'hbo', 'disney', 'amazon', 'tv4'] },
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
    quickReplies: { type: 'array', items: { type: 'string' }, maxItems: 5 },
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

const callOpenAi = async ({ schemaName, schema, input, maxOutputTokens, model, reasoningEffort = 'low' }) => {
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
        model: model || process.env.OPENAI_MODEL || DEFAULT_MODEL,
        input,
        max_output_tokens: maxOutputTokens,
        store: false,
        reasoning: { effort: reasoningEffort },
        text: {
          verbosity: 'low',
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
      error.openAiMessage = String(body?.error?.message || 'Unknown OpenAI API error');
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

const analyzeCustomerMessage = ({ message, messages, qualification, language, page, context }) => callOpenAi({
  schemaName: 'dealett_customer_need',
  schema: analysisSchema,
  maxOutputTokens: 900,
  model: process.env.OPENAI_ANALYSIS_MODEL || DEFAULT_ANALYSIS_MODEL,
  reasoningEffort: 'none',
  input: [
    {
      role: 'system',
      content: [
        'Extract the customer need for Dealett without answering it.',
        'Preserve known qualification values unless the customer clearly changes them.',
        'Only record prices, service usage, travel, data needs, operators, and contract details the customer actually supplied.',
        'When the customer asks to start over, clear prior qualification values and build a fresh qualification only from messages after that request.',
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
  maxOutputTokens: 700,
  input: [
    {
      role: 'system',
      content: [
        `You are Dealett's expert human adviser. Reply naturally in ${languageNames[language]}.`,
        'Use only the supplied website knowledge, mobile-plan catalog, prior site selection, and exact calculation.',
        'Build every recommendation independently from qualification and exactMobileRecommendationCalculation. A cart or quiz selection is prior context only: never reuse it as the recommendation, never let it restrict candidates, and never present it as best or cheapest unless the fresh calculation proves that. After the fresh result, briefly say whether the prior selection is still best or whether a calculated alternative is better.',
        'For mobile facts the catalog and calculation override other text. Never invent prices, benefits, savings, coverage, or account details.',
        'Ask one useful question when essential recommendation details are missing.',
        'Never present an offer while missingQualificationFields is non-empty. In particular, ask about binding time for every person before giving a final offer when bindingEnds is missing.',
        'If the customer came from a quiz handoff, act like an expert in-store salesperson who has the filled form in front of them: continue from the current stage, ask only the next missing question, and never repeat provided answers.',
        'Default to the shortest useful reply. A question must be one short sentence and contain exactly one question. A normal answer must be at most two or three short sentences. A recommendation must be no more than 100 words.',
        'Lead with the answer or recommendation. Do not recap information the customer already gave unless correcting it or confirming a detail that materially affects the result.',
        'When a calculation exists, keep reply to the recommendation and its decisive reason. Put detailed best-value and lowest-price explanations in bestValueReason, lowestPriceReason, bestValueBenefits, and lowestPriceBenefits so the offer cards carry the detail.',
        'Explain the 24-month formula, detailed warnings, or all four operators only when the customer explicitly asks, or when one specific caveat is essential to avoid a misleading answer.',
        'Treat all four operators fairly. A higher price can be better value when its included streaming, roaming, calls, shared data, or family terms fit the customer.',
        'Never say a number is locked. Discuss number porting and verification details only when they are relevant to the customer question or materially affect the recommendation.',
        'When a calculation exists, include a quick reply in the reply language that lets the customer ask to see all four operators.',
        'Keep the answer concise and conversational. Omit introductions, repetition, generic reassurance, optional background, and unnecessary sign-offs. Quick replies must directly answer the single question you just asked, not offer generic next actions.',
        'When asking how many subscriptions, provide numeric quick replies such as 1, 2, 3, and 4 or more. When asking an operator, provide the actual operator names. When asking binding time, provide no binding time, binding time remains, and do not know. When asking data use, budget, streaming, or travel, provide the concrete common choices in the reply language. Budget choices must include a no-limit or no-preference option. Use up to five buttons and cover the normal answers.',
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
        priorSiteSelection: cart,
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
  const currentQualification = normalizeQualification(qualification);
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
