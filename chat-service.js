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
const {
  applyBindingTimeInput,
  isValidIsoDate,
  isStreamingOnlyBindingMessage,
} = require('./src/binding-time');
const {
  buildNextQuestionFlowState,
  getAdaptiveQuestionPlan,
  normalizeQuestionFlowState,
} = require('./src/adaptive-question-policy');

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
const fallbackDealettOperators = ['Telia', 'Tele2', 'Telenor', 'Tre'];
const otherOperatorChoice = 'Annan';
const operatorLoginProfiles = {
  Telia: {
    portalName: 'Mitt Telia',
    loginUrl: 'https://www.telia.se/mitt-telia/start',
    hint: 'Logga in och öppna ditt mobilabonnemang för att se bindningstid eller avtalstid.',
  },
  Tele2: {
    portalName: 'Mitt Tele2',
    loginUrl: 'https://www.tele2.se/mitt-tele2',
    hint: 'Logga in och öppna abonnemang eller dina tjänster för att kontrollera bindningstid.',
  },
  Telenor: {
    portalName: 'Mitt Telenor',
    loginUrl: 'https://www.telenor.se/mitt-telenor/',
    hint: 'Logga in och öppna abonnemanget för att se detaljer om bindningstid och tjänster.',
  },
  Tre: {
    portalName: 'Mitt3',
    loginUrl: 'https://www.tre.se/mitt3',
    hint: 'Logga in, välj abonnemang, gå till Abonnemangsdetaljer och se rutan Uppgifter.',
  },
};

const getDealettOperatorChoices = () => {
  const configuredOperators = Array.isArray(websiteData.dealettProfile?.operators)
    ? websiteData.dealettProfile.operators
    : fallbackDealettOperators;
  return [
    ...new Set(configuredOperators
      .map((operator) => String(operator || '').trim())
      .filter(Boolean)),
    otherOperatorChoice,
  ];
};

const getBindingLookupOperators = (qualification = {}) => {
  const requestedOperators = Array.isArray(qualification.operators)
    ? qualification.operators
    : [];
  const names = requestedOperators
    .map((operator) => String(operator || '').trim())
    .filter((operator) => operatorLoginProfiles[operator]);
  const selected = names.length ? names : fallbackDealettOperators;
  return [...new Set(selected)].map((name) => ({
    name,
    ...operatorLoginProfiles[name],
  }));
};

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
      ...facts
    } = option;
    return facts;
  };
  return {
    ...calculation,
    bestMatch: removeNarrative(calculation.bestMatch),
    bestTravelFit: removeNarrative(calculation.bestTravelFit),
    bestStreamingFit: removeNarrative(calculation.bestStreamingFit),
    lowestEffectiveCost: removeNarrative(calculation.lowestEffectiveCost),
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
    extraSimRequired: { type: 'boolean' },
    sharedDataRequired: { type: 'boolean' },
    needImportance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        streaming: { type: ['string', 'null'], enum: ['flexible', 'must_have', null] },
        outsideEuData: { type: ['string', 'null'], enum: ['flexible', 'must_have', null] },
        internationalCalls: { type: ['string', 'null'], enum: ['flexible', 'must_have', null] },
        extraSim: { type: ['string', 'null'], enum: ['flexible', 'must_have', null] },
        sharedData: { type: ['string', 'null'], enum: ['flexible', 'must_have', null] },
      },
      required: ['streaming', 'outsideEuData', 'internationalCalls', 'extraSim', 'sharedData'],
    },
    internationalTripsPerYear: nullableNumber,
    internationalDataPassCost: nullableNumber,
    internationalCallsMonthlyCost: nullableNumber,
    extraSimMonthlyCost: nullableNumber,
    sharedDataMonthlyCost: nullableNumber,
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
    'internationalUsage', 'extraSimRequired', 'sharedDataRequired',
    'needImportance', 'internationalTripsPerYear', 'internationalDataPassCost',
    'internationalCallsMonthlyCost', 'extraSimMonthlyCost', 'sharedDataMonthlyCost',
    'exactMonthlyPrice', 'exactMonthlyPrices', 'customerSegment',
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
    groupBindingStatus: {
      type: 'string',
      enum: ['none_have_binding', 'one_or_more_have_binding', 'unknown', 'not_applicable'],
    },
    quizAnswerDecision: {
      type: 'string',
      enum: ['use', 'ignore', 'unresolved'],
    },
    knowledgeQuery: { type: 'string' },
    qualification: qualificationSchema,
  },
  required: [
    'topic', 'interactionStage', 'desiredOutcome', 'customerEmotion',
    'recommendationRequested', 'resetRequested', 'groupBindingStatus', 'quizAnswerDecision',
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
              'open_broadband_address', 'open_binding_lookup', 'open_cart', 'open_account', 'open_contact',
            ],
          },
        },
        required: ['label', 'action'],
      },
    },
    bestMatchReason: { type: 'string' },
    lowestEffectiveCostReason: { type: 'string' },
    bestMatchBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    lowestEffectiveCostBenefits: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    offerCardCopy: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bestMatchLabel: { type: 'string' },
        lowestEffectiveCostLabel: { type: 'string' },
        dataTitle: { type: 'string' },
        monthlyPriceTitle: { type: 'string' },
        perPersonPriceTitle: { type: 'string' },
        totalPriceTitle: { type: 'string' },
        bindingTitle: { type: 'string' },
        perMonthSuffix: { type: 'string' },
        perPersonSuffix: { type: 'string' },
        bindingMonthsSuffix: { type: 'string' },
        rewardLabel: { type: 'string' },
        ctaLabel: { type: 'string' },
      },
      required: [
        'bestMatchLabel', 'lowestEffectiveCostLabel', 'dataTitle', 'monthlyPriceTitle',
        'perPersonPriceTitle', 'totalPriceTitle', 'bindingTitle', 'perMonthSuffix',
        'perPersonSuffix', 'bindingMonthsSuffix', 'rewardLabel', 'ctaLabel',
      ],
    },
  },
  required: [
    'reply', 'showOfferCards', 'quickReplies', 'bestMatchReason', 'lowestEffectiveCostReason',
    'bestMatchBenefits', 'lowestEffectiveCostBenefits', 'offerCardCopy',
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

const getExplicitInternationalUsage = (message, activeQuestionField) => {
  const text = String(message || '').trim().toLocaleLowerCase('sv');
  if (!text) return null;
  const dataOnly = /(?:bara|endast|enbart|only)\s+(?:surf|data|mobildata)|(?:surf|data|mobildata)\s+(?:bara|endast|enbart|only)|(?:inga|utan|no)\s+(?:lokala\s+)?(?:samtal|calls?)/i.test(text);
  if (dataOnly) return 'data';
  if (/lokala?\s+samtal|\bsamtal\b|\bringa\b|\bcalls?\b|\bcalling\b/i.test(text)) return 'calls';
  if (activeQuestionField === 'internationalUsage' && /\bb[aå]da\b|\bboth\b/i.test(text)) return 'calls';
  const mentionsData = /\bsurf(?:a|ar)?\b|\bdata\b|mobildata/i.test(text);
  const mentionsOutsideEu = /utanf[oö]r\s*(?:eu|ees)|utomlands|outside\s*(?:the\s*)?(?:eu|eea)|abroad/i.test(text);
  if (mentionsData && (activeQuestionField === 'internationalUsage' || mentionsOutsideEu)) return 'data';
  return null;
};

const cleanAiQualification = (qualification = {}, { message = '', activeQuestionField = null } = {}) => ({
  ...qualification,
  bindingEnds: isStreamingOnlyBindingMessage(message) ? [] : qualification.bindingEnds,
  familyPriceRange: null,
  familyTotalPrice: null,
  internationalUsage: getExplicitInternationalUsage(message, activeQuestionField),
  streamingMonthlyCosts: Object.fromEntries(Object.entries(qualification.streamingMonthlyCosts || {})
    .filter(([, value]) => Number(value) > 0)),
});

const normalizeChatQualification = (qualification = {}) => normalizeQualification({
  ...qualification,
  familyPriceRange: null,
  familyTotalPrice: null,
});

const applyStreamingWidgetPatch = (qualification, context = {}) => {
  if (context?.source !== 'streaming_price_widget') return qualification;
  const patch = context.qualificationPatch;
  if (!patch || typeof patch !== 'object') return qualification;

  if (patch.streamingCalculation === 'none') {
    return normalizeChatQualification({
      ...qualification,
      streamingCalculation: 'none',
      streamingServices: [],
      streamingMonthlyCosts: {},
    });
  }

  if (patch.streamingCalculation !== 'include' || !Array.isArray(patch.streamingServices)) {
    return qualification;
  }
  return normalizeChatQualification({
    ...qualification,
    streamingCalculation: 'include',
    streamingServices: patch.streamingServices,
    streamingMonthlyCosts: patch.streamingMonthlyCosts,
  });
};

const applyOperatorBindingWidgetPatch = (qualification, context = {}) => {
  if (context?.source !== 'operator_binding_widget') return qualification;
  const patch = context.qualificationPatch;
  const peopleCount = Number(qualification.peopleCount);
  if (
    !patch || typeof patch !== 'object' ||
    !Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > 10 ||
    !Array.isArray(patch.operators) || patch.operators.length !== peopleCount ||
    !Array.isArray(patch.bindingEnds) || patch.bindingEnds.length !== peopleCount
  ) {
    return qualification;
  }

  const operators = patch.operators.map((operator) => String(operator || '').trim().slice(0, 40));
  const bindingEnds = patch.bindingEnds.map((bindingEnd) => String(bindingEnd || '').trim());
  const validBindings = bindingEnds.every((bindingEnd) => (
    bindingEnd === 'Ingen bindningstid' ||
    isValidIsoDate(bindingEnd)
  ));
  if (operators.some((operator) => !operator) || !validBindings) return qualification;

  return normalizeChatQualification({
    ...qualification,
    operators,
    bindingEnds,
    people: Array.from({ length: peopleCount }, (_, index) => ({
      ...(Array.isArray(qualification.people) ? qualification.people[index] : {}),
      currentOperator: operators[index],
      bindingEnd: bindingEnds[index],
      existingCustomer: operators[index] !== 'Annan / ingen',
    })),
    operatorAppliesToAll: peopleCount > 1 && new Set(operators).size === 1,
    bindingAppliesToAll: peopleCount > 1 && new Set(bindingEnds).size === 1,
  });
};

const applyWidgetQualificationPatch = (qualification, context = {}) => (
  applyOperatorBindingWidgetPatch(applyStreamingWidgetPatch(qualification, context), context)
);

const buildStreamingPriceWidget = (language) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  const priceLabel = isSwedish ? 'Pris per månad' : 'Monthly price';
  const pricePlaceholder = isSwedish ? 'kr/mån' : 'SEK/month';
  return {
    type: 'streaming_prices',
    services: [
      { id: 'netflix', label: 'Netflix', priceLabel, pricePlaceholder },
      { id: 'hbo', label: 'HBO Max', priceLabel, pricePlaceholder },
      { id: 'disney', label: 'Disney+', priceLabel, pricePlaceholder },
    ],
    noneLabel: isSwedish ? 'Inga av dessa' : 'None of these',
    submitLabel: isSwedish ? 'Fortsätt' : 'Continue',
    missingPriceLabel: isSwedish ? 'Pris saknas' : 'Price missing',
  };
};

const buildOperatorBindingWidget = (language, peopleCount) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  return {
    type: 'operator_binding',
    peopleCount: Math.max(1, Math.min(Number(peopleCount) || 1, 10)),
    operators: getDealettOperatorChoices(),
    personLabel: isSwedish ? 'Person' : 'Person',
    ofLabel: isSwedish ? 'av' : 'of',
    operatorLabel: isSwedish ? 'Nuvarande operatör' : 'Current operator',
    operatorPlaceholder: isSwedish ? 'Välj operatör' : 'Choose operator',
    bindingLabel: isSwedish ? 'Bindningstid' : 'Binding period',
    bindingPlaceholder: isSwedish ? 'Välj bindningsstatus' : 'Choose binding status',
    bindingOptions: [
      {
        value: 'Ingen bindningstid',
        label: isSwedish ? 'Ingen bindningstid' : 'No binding period',
      },
      {
        value: 'lookup',
        label: isSwedish ? 'Hitta bindningstid' : 'Find binding period',
      },
      {
        value: 'date',
        label: isSwedish ? 'Välj slutdatum' : 'Choose end date',
      },
    ],
    dateLabel: isSwedish ? 'Slutdatum' : 'End date',
    nextLabel: isSwedish ? 'Nästa person' : 'Next person',
    submitLabel: isSwedish ? 'Fortsätt' : 'Continue',
    requiredLabel: isSwedish ? 'Välj ett alternativ' : 'Choose an option',
  };
};

const buildOperatorQuickReplies = () => getDealettOperatorChoices().map((operator) => ({
  label: operator,
  action: 'send_message',
}));

const buildStreamingPriceQuickReplies = (language) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  return [{
    label: isSwedish ? 'Vet inte' : "I don't know",
    action: 'send_message',
  }];
};

const buildBindingLookupWidget = (language, qualification) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  return {
    type: 'binding_lookup',
    title: isSwedish ? 'Hitta bindningstid hos operatören' : 'Find binding period with the operator',
    description: isSwedish
      ? 'Logga in hos operatören här, kontrollera bindningstiden och skriv sedan svaret i chatten.'
      : 'Log in with the operator here, check the binding period, then send the answer in the chat.',
    operators: getBindingLookupOperators(qualification),
    openLabel: isSwedish ? 'Öppna här' : 'Open here',
    dateLabel: isSwedish ? 'Slutdatum' : 'End date',
    noBindingLabel: isSwedish ? 'Ingen bindningstid' : 'No binding period',
    submitLabel: isSwedish ? 'Skicka datum' : 'Send date',
  };
};

const isBindingLookupRequest = (message) => (
  /\b(?:vet inte|os[aä]ker|ingen aning|don'?t know|not sure|hitta bindningstid|find binding)\b/i
    .test(String(message || ''))
);

const buildInternationalUsageQuickReplies = (language) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  return (isSwedish
    ? ['Bara surf', 'Lokala samtal och surf']
    : ['Data only', 'Local calls and data'])
    .map((label) => ({ label, action: 'send_message' }));
};

const buildBindingQuickReplies = (language, pendingBindingEnd) => {
  const isSwedish = String(language || '').toLowerCase().startsWith('sv');
  const labels = pendingBindingEnd
    ? (isSwedish
      ? ['Ja, det stämmer', 'Nej, annat datum', 'Hitta bindningstid']
      : ['Yes, that is correct', 'No, different date', 'Find binding period'])
    : (isSwedish
      ? ['Ingen bindningstid', 'Hitta bindningstid']
      : ['No binding period', 'Find binding period']);
  return labels.map((label) => ({
    label,
    action: /hitta|find/i.test(label) ? 'open_binding_lookup' : 'send_message',
  }));
};

const hasHistoricalQuizAnswers = (context = {}) => (
  context?.quizHandoff !== true &&
  context?.quizAnswersStatus === 'unconfirmed' &&
  Boolean(context?.historicalQuizQualification || context?.qualification)
);

const getHistoricalQuizQualification = (context = {}) => normalizeChatQualification(
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
  adaptiveQuestionPlan,
  questionFlowState,
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
        adaptiveQuestionPlan,
        questionFlowState,
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
  flowState = {},
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
  const incomingFlowState = normalizeQuestionFlowState(flowState);
  const currentQualification = applyWidgetQualificationPatch(
    normalizeChatQualification(qualification),
    context
  );
  const analysis = await analyzeCustomerMessage({
    message: latestMessage,
    messages,
    qualification: currentQualification,
    language: normalizedLanguage,
    page,
    context,
  });
  const unavailableHistoricalQuizRequested = !historicalQuizAvailable &&
    analysis.quizAnswerDecision === 'use';
  const historicalQuizAccepted = historicalQuizAvailable && analysis.quizAnswerDecision === 'use';
  const historicalQuizDeclined = historicalQuizAvailable &&
    (analysis.quizAnswerDecision === 'ignore' || analysis.resetRequested);
  const qualificationBase = analysis.resetRequested || historicalQuizDeclined
    ? createEmptyQualification()
    : (historicalQuizAccepted ? getHistoricalQuizQualification(context) : currentQualification);
  const flowBase = analysis.resetRequested
    ? normalizeQuestionFlowState({})
    : incomingFlowState;
  const recommendationInProgress = analysis.interactionStage !== 'close' && (
    analysis.recommendationRequested || flowBase.inProgress || context?.quizHandoff === true
  );
  const quizConsentRequired = historicalQuizAvailable &&
    !historicalQuizAccepted &&
    !historicalQuizDeclined &&
    recommendationInProgress;
  const analyzedQualification = cleanAiQualification(
    unavailableHistoricalQuizRequested ? {} : analysis.qualification,
    {
      message: latestMessage,
      activeQuestionField: flowBase.activeQuestionField,
    }
  );
  const analyzedPeopleCount = Number(analyzedQualification.peopleCount || qualificationBase.peopleCount) || 0;
  if (analyzedPeopleCount > 1 && analysis.groupBindingStatus === 'none_have_binding') {
    analyzedQualification.bindingEnds = ['Ingen bindningstid'];
    analyzedQualification.bindingAppliesToAll = true;
  }
  const mergedQualification = mergeQualificationState(
    qualificationBase,
    quizConsentRequired ? {} : analyzedQualification
  );
  const bindingInput = applyBindingTimeInput({
    qualification: mergedQualification,
    flowState: flowBase,
    message: latestMessage,
  });
  const normalizedNextQualification = applyWidgetQualificationPatch(
    normalizeChatQualification(bindingInput.qualification),
    context
  );
  const questionFlowBase = normalizeQuestionFlowState(bindingInput.flowState);
  const nextQualification = questionFlowBase.pendingBindingEnd
    ? {
      ...normalizedNextQualification,
      readyForOffer: false,
      missingFields: [...new Set([
        ...normalizedNextQualification.missingFields,
        'bindingEnds',
      ])],
    }
    : normalizedNextQualification;
  const adaptiveQuestionPlan = quizConsentRequired
    ? null
    : getAdaptiveQuestionPlan({
      message: latestMessage,
      analysis,
      qualification: nextQualification,
      flowState: questionFlowBase,
    });
  const nextFlowState = buildNextQuestionFlowState({
    previousFlowState: questionFlowBase,
    adaptiveQuestionPlan,
    qualification: nextQualification,
  });
  const offerCalculation = recommendationInProgress &&
    !quizConsentRequired &&
    !adaptiveQuestionPlan &&
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
      unavailableHistoricalQuizRequested,
    },
    topic: analysis.topic,
    interactionStage: analysis.interactionStage,
    desiredOutcome: analysis.desiredOutcome,
    customerEmotion: analysis.customerEmotion,
    qualification: nextQualification,
    offerCalculation,
    websiteKnowledge,
    adaptiveQuestionPlan,
    questionFlowState: nextFlowState,
  });
  const offerCards = offerCalculation && answer.showOfferCards
    ? buildOfferCardsFromOfferCalculation(offerCalculation, {
      language: normalizedLanguage,
      copy: answer,
    })
    : [];
  const showStreamingWidget = ['streamingCalculation', 'streamingServices']
    .includes(adaptiveQuestionPlan?.qualificationField);
  const showOperatorBindingWidget = adaptiveQuestionPlan?.focus === 'current_operator_and_binding' &&
    adaptiveQuestionPlan?.combinedQualificationFields?.includes('operators') &&
    adaptiveQuestionPlan?.combinedQualificationFields?.includes('bindingEnds');
  const showBindingLookupWidget = adaptiveQuestionPlan?.qualificationField === 'bindingEnds' &&
    isBindingLookupRequest(latestMessage);
  const quickReplies = (() => {
    if (adaptiveQuestionPlan?.qualificationField === 'peopleCount') {
      return Array.from({ length: 10 }, (_, index) => ({
        label: String(index + 1),
        action: 'send_message',
      }));
    }
    if (showOperatorBindingWidget || adaptiveQuestionPlan?.qualificationField === 'operators') {
      return buildOperatorQuickReplies();
    }
    if (adaptiveQuestionPlan?.qualificationField === 'internationalUsage') {
      return buildInternationalUsageQuickReplies(normalizedLanguage);
    }
    if (adaptiveQuestionPlan?.qualificationField === 'bindingEnds') {
      return buildBindingQuickReplies(normalizedLanguage, adaptiveQuestionPlan.pendingBindingEnd);
    }
    if (showStreamingWidget) {
      return [];
    }
    if (adaptiveQuestionPlan?.qualificationField === 'streamingPrices') {
      return buildStreamingPriceQuickReplies(normalizedLanguage);
    }
    return answer.quickReplies;
  })();
  const embeddedWidget = showOperatorBindingWidget
    ? buildOperatorBindingWidget(normalizedLanguage, nextQualification.peopleCount)
    : (showBindingLookupWidget
      ? buildBindingLookupWidget(normalizedLanguage, nextQualification)
      : (showStreamingWidget ? buildStreamingPriceWidget(normalizedLanguage) : null));
  const ui = buildChatResponse({
    message: answer.reply,
    quickReplies,
    quickReplyMode: 'single',
    quickReplySubmitLabel: '',
    offerCards,
    embeddedWidget,
  });
  return {
    reply: ui.message,
    message: ui.message,
    language: normalizedLanguage,
    topic: analysis.topic,
    qualification: nextQualification,
    flowState: nextFlowState,
    offerCalculation,
    quickReplies: ui.quickReplies,
    quickReplyMode: ui.quickReplyMode,
    quickReplySubmitLabel: ui.quickReplySubmitLabel,
    suggestions: ui.quickReplies.map((reply) => reply.label),
    offerCards: ui.offerCards,
    embeddedWidget: ui.embeddedWidget,
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
