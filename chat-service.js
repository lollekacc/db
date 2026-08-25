const fs = require('node:fs');
const path = require('node:path');

const { calculateOfferOptions } = require('./offer-calculator');
const { getPlanCatalog } = require('./offer-service');
const { createEmptyQualification, normalizeQualification } = require('./qualification-service');
const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
} = require('./src/chat-ui-response');
const { mergeQualificationState } = require('./src/conversation-state');

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
const CHAT_INSTRUCTIONS_PATH = path.join(__dirname, 'chat', 'CHAT_INSTRUCTIONS.md');

let openAiTransport = (...args) => fetch(...args);

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const chatInstructions = fs.readFileSync(CHAT_INSTRUCTIONS_PATH, 'utf8');

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

const getCalculationFacts = (calculation) => {
  if (!calculation) return null;
  const removeNarrative = (option) => {
    if (!option || typeof option !== 'object') return option;
    const {
      reason,
      benefits,
      tradeoffs,
      giftCardReason,
      numberHandlingNotes,
      ...facts
    } = option;
    return facts;
  };
  return {
    ...calculation,
    bestValue: removeNarrative(calculation.bestValue),
    bestTravelFit: removeNarrative(calculation.bestTravelFit),
    bestStreamingFit: removeNarrative(calculation.bestStreamingFit),
    lowestMonthlyPrice: removeNarrative(calculation.lowestMonthlyPrice),
    options: Array.isArray(calculation.options)
      ? calculation.options.map(removeNarrative)
      : [],
    assumptions: calculation.assumptions
      ? {
        requiredDataGb: calculation.assumptions.requiredDataGb,
        currentMonthlyTotalIsEstimate: calculation.assumptions.currentMonthlyTotalIsEstimate,
      }
      : null,
  };
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
    familyPriceRange: {
      type: ['string', 'null'],
      enum: ['under1000', '1000-1500', '1500-2000', 'over2000', 'unknown', null],
    },
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
    'peopleCount', 'people', 'operators', 'bindingEnds', 'mobileUsage', 'requiredDataGb', 'priceRange', 'familyPriceRange',
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
    interactionStage: {
      type: 'string',
      enum: ['greeting', 'understand', 'solve', 'confirm', 'dissatisfied', 'close'],
    },
    desiredOutcome: nullableString,
    customerEmotion: {
      type: 'string',
      enum: ['neutral', 'confused', 'frustrated', 'angry', 'anxious'],
    },
    recommendationRequested: { type: 'boolean' },
    resetRequested: { type: 'boolean' },
    quizAnswerDecision: {
      type: 'string',
      enum: ['use', 'ignore', 'unresolved'],
    },
    knowledgeQuery: { type: 'string' },
    qualification: qualificationSchema,
  },
  required: [
    'topic', 'interactionStage', 'desiredOutcome', 'customerEmotion',
    'recommendationRequested', 'resetRequested', 'quizAnswerDecision',
    'knowledgeQuery', 'qualification',
  ],
};

const answerSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string', minLength: 1 },
    showOfferCards: { type: 'boolean' },
    quickReplies: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          action: {
            type: 'string',
            enum: [
              'send_message', 'open_coverage_map', 'open_broadband_page',
              'open_broadband_address', 'open_cart', 'open_account', 'open_contact',
            ],
          },
        },
        required: ['label', 'action'],
      },
    },
    bestValueReason: { type: 'string' },
    lowestPriceReason: { type: 'string' },
    bestValueBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    lowestPriceBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    offerCardCopy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bestValueLabel: { type: 'string' },
        lowestPriceLabel: { type: 'string' },
        dataTitle: { type: 'string' },
        monthlyPriceTitle: { type: 'string' },
        bindingTitle: { type: 'string' },
        perMonthSuffix: { type: 'string' },
        bindingMonthsSuffix: { type: 'string' },
        rewardLabel: { type: 'string' },
        ctaLabel: { type: 'string' },
      },
      required: [
        'bestValueLabel', 'lowestPriceLabel', 'dataTitle', 'monthlyPriceTitle',
        'bindingTitle', 'perMonthSuffix', 'bindingMonthsSuffix', 'rewardLabel', 'ctaLabel',
      ],
    },
  },
  required: [
    'reply', 'showOfferCards', 'quickReplies', 'bestValueReason', 'lowestPriceReason',
    'bestValueBenefits', 'lowestPriceBenefits', 'offerCardCopy',
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

const hasHistoricalQuizAnswers = (context = {}) => (
  context?.quizHandoff !== true &&
  context?.quizAnswersStatus === 'unconfirmed' &&
  Boolean(context?.historicalQuizQualification || context?.qualification)
);

const getHistoricalQuizQualification = (context = {}) => normalizeQualification(
  context?.historicalQuizQualification || context?.qualification || {}
);

const analyzeCustomerMessage = ({ message, messages, qualification, language, page, context }) => callOpenAi({
  schemaName: 'dealett_customer_need',
  schema: analysisSchema,
  maxOutputTokens: 900,
  model: process.env.OPENAI_ANALYSIS_MODEL || DEFAULT_ANALYSIS_MODEL,
  reasoningEffort: 'none',
  input: [
    {
      role: 'system',
      content: chatInstructions,
    },
    ...trimMessages(messages),
    {
      role: 'user',
      content: JSON.stringify({
        operation: 'analyze_customer_message',
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
  interactionStage,
  desiredOutcome,
  customerEmotion,
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
      content: chatInstructions,
    },
    ...trimMessages(messages),
    {
      role: 'user',
      content: JSON.stringify({
        operation: 'generate_customer_reply',
        latestMessage: message,
        language,
        page,
        context,
        topic,
        interactionStage,
        desiredOutcome,
        customerEmotion,
        qualification,
        missingQualificationFields: qualification.missingFields,
        priorSiteSelection: cart,
        websiteKnowledge,
        mobilePlanCatalog: getPlanCatalog(),
        exactMobileRecommendationCalculation: getCalculationFacts(offerCalculation),
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
  if (!latestMessage && context?.quizHandoff !== true) {
    const error = new Error('Message is required');
    error.statusCode = 400;
    throw error;
  }

  const requestedLanguage = String(language || '').trim().toLowerCase();
  const normalizedLanguage = /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(requestedLanguage)
    ? requestedLanguage
    : 'sv';
  const historicalQuizAvailable = hasHistoricalQuizAnswers(context);
  const currentQualification = normalizeQualification(qualification);
  const analysis = await analyzeCustomerMessage({
    message: latestMessage,
    messages,
    qualification: currentQualification,
    language: normalizedLanguage,
    page,
    context,
  });
  const historicalQuizAccepted = historicalQuizAvailable && analysis.quizAnswerDecision === 'use';
  const historicalQuizDeclined = historicalQuizAvailable &&
    (analysis.quizAnswerDecision === 'ignore' || analysis.resetRequested);
  const qualificationBase = analysis.resetRequested || historicalQuizDeclined
    ? createEmptyQualification()
    : (historicalQuizAccepted ? getHistoricalQuizQualification(context) : currentQualification);
  const recommendationInProgress = analysis.recommendationRequested;
  const quizConsentRequired = historicalQuizAvailable &&
    !historicalQuizAccepted &&
    !historicalQuizDeclined &&
    recommendationInProgress;
  const mergedQualification = mergeQualificationState(
    qualificationBase,
    quizConsentRequired ? {} : cleanAiQualification(analysis.qualification)
  );
  const nextQualification = normalizeQualification(mergedQualification);
  const offerCalculation = recommendationInProgress &&
    !quizConsentRequired &&
    nextQualification.missingFields.length === 0
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
    context: {
      ...context,
      quizConsentRequired,
    },
    topic: analysis.topic,
    interactionStage: analysis.interactionStage,
    desiredOutcome: analysis.desiredOutcome,
    customerEmotion: analysis.customerEmotion,
    qualification: nextQualification,
    offerCalculation,
    websiteKnowledge,
  });
  const offerCards = offerCalculation && answer.showOfferCards
    ? buildOfferCardsFromOfferCalculation(offerCalculation, {
      language: normalizedLanguage,
      copy: answer,
    })
    : [];
  const ui = buildChatResponse({
    message: answer.reply,
    quickReplies: answer.quickReplies,
    quickReplyMode: 'single',
    quickReplySubmitLabel: '',
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
    quickReplyMode: ui.quickReplyMode,
    quickReplySubmitLabel: ui.quickReplySubmitLabel,
    suggestions: ui.quickReplies.map((reply) => reply.label),
    offerCards: ui.offerCards,
    embeddedWidget: null,
    quizAnswersStatus: context?.quizHandoff === true || historicalQuizAccepted
      ? 'confirmed'
      : (historicalQuizDeclined ? 'ignored' : (historicalQuizAvailable ? 'unconfirmed' : 'none')),
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
