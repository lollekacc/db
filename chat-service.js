const fs = require('node:fs');
const path = require('node:path');

const { calculateOfferOptions } = require('./offer-calculator');
const { getBroadbandPlans, getPlans } = require('./offer-service');
const { classifyCustomerClaim } = require('./src/marketIntelligence');
const { detectConversationStyle } = require('./src/conversationStyle');
const {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
  getEmbeddedWidgetForChatState,
  getQuickRepliesForChatState,
} = require('./src/chat-ui-response');

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4o-mini';
const CHAT_RULES_DIR = path.join(__dirname, 'chat');
const ALLOWED_OPERATORS = ['Telia', 'Tele2', 'Telenor', 'Tre', 'Halebop'];
const KNOWN_CURRENT_OPERATORS = [
  ...ALLOWED_OPERATORS,
  'Comviq',
  'Hallon',
  'Vimla',
  'Fello',
  'Chilimobil',
  'Fibio',
  'Tellus',
  'MyBeat',
  'Telness',
  'Lycamobile',
];
const OPERATOR_ID_BY_NAME = Object.fromEntries(KNOWN_CURRENT_OPERATORS.map((operator) => [
  operator,
  operator.toLowerCase(),
]));

const emptyOfferCalculation = (qualification = {}) => ({
  readyForOffer: Boolean(qualification.readyForOffer),
  missingFields: qualification.missingFields || [],
  options: [],
});

const loadChatRules = () => {
  if (!fs.existsSync(CHAT_RULES_DIR)) return {};

  return fs.readdirSync(CHAT_RULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .reduce((rules, entry) => {
      const key = entry.name.replace(/\.json$/, '');
      rules[key] = JSON.parse(fs.readFileSync(path.join(CHAT_RULES_DIR, entry.name), 'utf8'));
      return rules;
    }, {});
};

const trimMessages = (messages = []) => (
  Array.isArray(messages)
    ? messages
      .slice(-8)
      .map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || '').slice(0, 1000),
      }))
      .filter((message) => message.content)
    : []
);

const extractOutputText = (response) => {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && content.text)
    .map((content) => content.text)
    .join('\n')
    .trim();
};

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
};

const normalizeOperator = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return KNOWN_CURRENT_OPERATORS.find((operator) => operator.toLowerCase() === normalized.toLowerCase()) ||
    (/annan|andra|annat|ingen|other/i.test(normalized) ? 'Annan / ingen' : normalized.slice(0, 40));
};

const normalizeBindingEnd = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/ingen|no contract|no binding/i.test(normalized)) return 'Ingen bindningstid';
  if (/vet|don't know|dont know/i.test(normalized)) return 'Vet inte';
  return normalized.slice(0, 40);
};

const numberWords = {
  en: 1,
  ett: 1,
  one: 1,
  två: 2,
  tva: 2,
  two: 2,
  tre: 3,
  three: 3,
  fyra: 4,
  four: 4,
  fem: 5,
  five: 5,
  sex: 6,
  six: 6,
  sju: 7,
  seven: 7,
  åtta: 8,
  atta: 8,
  eight: 8,
  nio: 9,
  nine: 9,
  tio: 10,
  ten: 10,
  elva: 11,
  eleven: 11,
  tolv: 12,
  twelve: 12,
};

const parseNumberValue = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return numberWords[normalized] || null;
};

const numberWordPattern = Object.keys(numberWords).join('|');
const numberOnlyPattern = new RegExp(`^(\\d+|${numberWordPattern})$`, 'i');
const escapeRegExp = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const knownOperatorPattern = KNOWN_CURRENT_OPERATORS.map(escapeRegExp).join('|');

const normalizeCommonTypos = (message) => String(message || '')
  .replace(/\babonneamng\b/gi, 'abonnemang')
  .replace(/\babonnemnet\b/gi, 'abonnemang')
  .replace(/\babbonemang\b/gi, 'abonnemang')
  .replace(/\babb\b/gi, 'abonnemang')
  .replace(/\btele\s+2\b/gi, 'Tele2')
  .replace(/\b4\s*hundra\b/gi, '400')
  .replace(/\bbehovs analys\b/gi, 'behovsanalys');

const formatBindingValue = (value, isEnglish) => {
  const normalized = String(value || '');
  const monthMatch = normalized.match(/^(\d+)\s*months?$/i);
  if (monthMatch) return isEnglish ? `${monthMatch[1]} months` : `${monthMatch[1]} månader`;
  return normalized;
};

const appendUntilPeopleCount = (items, value, peopleCount) => {
  const nextItems = Array.isArray(items) ? [...items] : [];
  const limit = Number(peopleCount) || 1;
  while (nextItems.length < limit) nextItems.push(value);
  return nextItems.slice(0, limit);
};

const countMatches = (text, pattern) => [...String(text || '').matchAll(pattern)].length;

const inferPeopleCountFromFamilyText = (text) => {
  const lower = String(text || '').toLowerCase();
  const familyCount = countMatches(
    lower,
    /\b(mamma|pappa|mor|far|fru|make|partner|sambo|son|dotter|barn|mom|dad|mother|father|wife|husband|partner|child|son|daughter)\b/g
  );
  if (!familyCount) return null;

  const includesSelf = /\b(jag|mig|me|myself)\b|\band i\b/.test(lower);
  const inferredCount = familyCount + (includesSelf ? 1 : 0);
  return inferredCount > 1 ? Math.min(inferredCount, 10) : null;
};

const extractBindingAnswersFromText = (text, peopleCount, currentBindingEnds = []) => {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const matches = [];
  const repeatedMatches = [];
  const pattern = new RegExp(
    `\\b(\\d{4}-\\d{2}-\\d{2})\\b|ingen bindningstid|no contract|no binding|vet inte|don't know|dont know|(\\d+|${numberWordPattern})\\s*(mån|månad|månader|manader|month|months)`,
    'gi'
  );

  for (const match of source.matchAll(new RegExp(`(?:ingen bindningstid|no contract|no binding)\\s*(?:på|for)\\s*(\\d+|${numberWordPattern})`, 'gi'))) {
    const quantity = parseNumberValue(match[1]);
    if (quantity) repeatedMatches.push(...Array.from({ length: quantity }, () => 'Ingen bindningstid'));
  }

  for (const match of source.matchAll(new RegExp(`(\\d+|${numberWordPattern})\\s*(mån|månad|månader|manader|month|months)\\s*(?:på|for)\\s*(\\d+|${numberWordPattern})`, 'gi'))) {
    const months = parseNumberValue(match[1]);
    const quantity = parseNumberValue(match[3]);
    if (months && quantity) repeatedMatches.push(...Array.from({ length: quantity }, () => `${months} months`));
  }

  for (const match of source.matchAll(pattern)) {
    const before = lower.slice(Math.max(0, match.index - 10), match.index);
    if (match[2] && /\binte\s*$|\bnot\s*$/i.test(before)) continue;
    if (match[1]) matches.push(match[1]);
    else if (match[2]) matches.push(`${parseNumberValue(match[2])} months`);
    else if (/vet inte|don't know|dont know/i.test(match[0])) {
      if (!/bindning|avtal|contract|mån|månad|month|kvar|löper|slut/i.test(lower)) continue;
      matches.push('Vet inte');
    }
    else matches.push('Ingen bindningstid');
  }

  const count = Number(peopleCount) || currentBindingEnds.length || 1;
  if (repeatedMatches.length) return repeatedMatches.slice(0, count);
  if (!matches.length) return null;
  const appliesToAll = /alla|samtliga|båda|both|all/i.test(lower);
  if (matches.length === 1 && appliesToAll) return Array.from({ length: count }, () => matches[0]);

  if (matches.length === 1 && currentBindingEnds.length < count) {
    return [...currentBindingEnds, matches[0]].slice(0, count);
  }

  if (
    matches.length === 1 &&
    currentBindingEnds.length &&
    currentBindingEnds.some((bindingEnd) => /vet/i.test(String(bindingEnd || '')))
  ) {
    const next = [...currentBindingEnds];
    const unknownIndex = next.findIndex((bindingEnd) => /vet/i.test(String(bindingEnd || '')));
    next[unknownIndex] = matches[0];
    return next.slice(0, count);
  }

  if (matches.length === 1 && count === 1) return [matches[0]];
  return matches.slice(0, count);
};

const extractOperatorMatches = (text) => [...String(text || '').matchAll(new RegExp(`\\b(${knownOperatorPattern})\\b`, 'gi'))]
  .filter((match) => {
    const operator = match[1];
    if (operator.toLowerCase() !== 'tre') return true;

    const after = String(text || '').slice(match.index + match[0].length, match.index + match[0].length + 24);
    return !/^\s*(person|personer|abonnemang|subscriptions?|people)\b/i.test(after);
  })
  .map((match) => normalizeOperator(match[1]))
  .filter(Boolean);

const createEmptyQualification = () => ({
  peopleCount: null,
  operators: [],
  bindingEnds: [],
  mobileUsage: null,
  priceRange: null,
  streamingServices: [],
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  readyForOffer: false,
  missingFields: ['peopleCount', 'operators', 'bindingEnds', 'mobileUsage', 'priceRange'],
});

const normalizeQualification = (qualification = {}) => {
  const peopleCount = Number.isFinite(Number(qualification.peopleCount)) && Number(qualification.peopleCount) > 0
    ? Math.min(Math.round(Number(qualification.peopleCount)), 10)
    : null;
  const rawOperators = Array.isArray(qualification.operators)
    ? qualification.operators.map(normalizeOperator).filter(Boolean).slice(0, peopleCount || 10)
    : [];
  const rawBindingEnds = Array.isArray(qualification.bindingEnds)
    ? qualification.bindingEnds.map(normalizeBindingEnd).filter(Boolean).slice(0, peopleCount || 10)
    : [];
  const operators = peopleCount && qualification.operatorAppliesToAll && rawOperators.length === 1
    ? Array.from({ length: peopleCount }, () => rawOperators[0])
    : rawOperators;
  const bindingEnds = peopleCount && qualification.bindingAppliesToAll && rawBindingEnds.length === 1
    ? Array.from({ length: peopleCount }, () => rawBindingEnds[0])
    : rawBindingEnds;
  const mobileUsage = ['low', 'medium', 'high'].includes(qualification.mobileUsage)
    ? qualification.mobileUsage
    : null;
  const priceRange = ['under300', '300-400', '400-500'].includes(qualification.priceRange)
    ? qualification.priceRange
    : null;
  const streamingCalculation = ['none', 'include', 'unknown'].includes(qualification.streamingCalculation)
    ? qualification.streamingCalculation
    : null;
  const streamingServices = Array.isArray(qualification.streamingServices)
    ? qualification.streamingServices
      .map((service) => String(service || '').trim().toLowerCase())
      .filter((service) => ['netflix', 'hbo', 'disney', 'amazon', 'tv4'].includes(service))
    : [];
  const internationalTravel = ['none', 'eu', 'outside_eu'].includes(qualification.internationalTravel)
    ? qualification.internationalTravel
    : null;
  const exactMonthlyPrice = Number(qualification.exactMonthlyPrice) > 0
    ? Math.round(Number(qualification.exactMonthlyPrice))
    : null;
  const rawExactMonthlyPrices = Array.isArray(qualification.exactMonthlyPrices)
    ? qualification.exactMonthlyPrices
      .map((price) => Number(price))
      .filter((price) => Number.isFinite(price) && price > 0)
      .map((price) => Math.round(price))
      .slice(0, peopleCount || 10)
    : [];
  const exactMonthlyPrices = peopleCount && qualification.priceAppliesToAll && rawExactMonthlyPrices.length === 1
    ? Array.from({ length: peopleCount }, () => rawExactMonthlyPrices[0])
    : rawExactMonthlyPrices;
  const customerSegment = ['private', 'family', 'student', 'senior', 'youth', 'child', 'business'].includes(qualification.customerSegment)
    ? qualification.customerSegment
    : null;
  const familyTotalPrice = Number(qualification.familyTotalPrice) > 0
    ? Math.round(Number(qualification.familyTotalPrice))
    : null;

  let missingFields = [];
  if (!peopleCount) missingFields.push('peopleCount');
  if (!peopleCount || operators.length < peopleCount) missingFields.push('operators');
  if (!peopleCount || bindingEnds.length < peopleCount) missingFields.push('bindingEnds');
  if (!mobileUsage) missingFields.push('mobileUsage');
  if (!priceRange && !exactMonthlyPrice && (!peopleCount || exactMonthlyPrices.length < peopleCount)) {
    missingFields.push('priceRange');
  }
  if (exactMonthlyPrice && !familyTotalPrice && !operators.length && missingFields.includes('operators')) {
    missingFields = ['operators', ...missingFields.filter((field) => field !== 'operators')];
  }

  return {
    peopleCount,
    operators,
    bindingEnds,
    mobileUsage,
    priceRange,
    streamingCalculation,
    streamingServices,
    internationalTravel,
    exactMonthlyPrice,
    exactMonthlyPrices,
    customerSegment,
    familyTotalPrice,
    operatorAppliesToAll: Boolean(qualification.operatorAppliesToAll),
    bindingAppliesToAll: Boolean(qualification.bindingAppliesToAll),
    priceAppliesToAll: Boolean(qualification.priceAppliesToAll),
    readyForOffer: missingFields.length === 0,
    missingFields,
  };
};

const inferQualificationFromText = (message, qualification = {}) => {
  const text = String(message || '');
  const lower = text.toLowerCase();
  const next = {
    ...qualification,
    operators: Array.isArray(qualification.operators) ? [...qualification.operators] : [],
    bindingEnds: Array.isArray(qualification.bindingEnds) ? [...qualification.bindingEnds] : [],
    exactMonthlyPrices: Array.isArray(qualification.exactMonthlyPrices) ? [...qualification.exactMonthlyPrices] : [],
  };
  const countMatch = lower.match(new RegExp(`(\\d+|${numberWordPattern})\\s*(person|personer|abonnemang|subscriptions?|people|hemma|home)`, 'i'));
  const naturalFamilyCount = inferPeopleCountFromFamilyText(lower);

  if (/student/.test(lower)) next.customerSegment = 'student';
  if (/senior|pensionär|pensionar/.test(lower)) next.customerSegment = 'senior';
  if (/ungdom|youth/.test(lower)) next.customerSegment = 'youth';
  if (/barn|child/.test(lower)) next.customerSegment = 'child';
  if (/företag|business|arbetsgivare|employer|jobbet betalar|work pays|company pays/.test(lower)) next.customerSegment = 'business';
  if (/familj|family|delat|shared|samla/.test(lower)) next.customerSegment = 'family';

  if (countMatch) next.peopleCount = parseNumberValue(countMatch[1]);
  else if (!Number(next.peopleCount)) {
    if (naturalFamilyCount) next.peopleCount = naturalFamilyCount;
    else if (/\b(one subscription|one person|en person|ett abonnemang|en abonnemang|ett subscription)\b/i.test(lower)) next.peopleCount = 1;
    else if (/\b(two|två)\s+(subscriptions?|abonnemang|personer|people)\b/i.test(lower)) next.peopleCount = 2;
    else if (/\b(three|tre)\s+(subscriptions?|abonnemang|personer|people)\b/i.test(lower)) next.peopleCount = 3;
    else if (/\b(four|fyra)\s+(subscriptions?|abonnemang|personer|people)\b/i.test(lower)) next.peopleCount = 4;
    else if (/jag och (min )?(mamma|pappa|fru|man|partner)|mom and i|dad and i|my partner and i/i.test(lower)) next.peopleCount = 2;
    else if (/jag är student|jag ar student|i am a student|i'm a student|min pappa|min mamma|my dad|my father|my mom|my mother/i.test(lower)) next.peopleCount = 1;
    else if (/bara jag|bara mig|just me|only me/i.test(lower)) next.peopleCount = 1;
  }

  const operatorMatches = extractOperatorMatches(text);
  if (operatorMatches.length) {
    if (operatorMatches.length === 1 && (/alla|samtliga|båda|both|all/i.test(lower) || (/familj|family/.test(lower) && Number(next.peopleCount) > 1))) {
      next.operatorAppliesToAll = true;
      next.operators = appendUntilPeopleCount(next.operators, operatorMatches[0], next.peopleCount);
    } else {
      next.operators = [...next.operators, ...operatorMatches].slice(0, Number(next.peopleCount) || 10);
    }
  } else if (/^(annan \/ ingen|annan|andra|annat|other|other operator)$/i.test(lower)) {
    next.operators = [...next.operators, 'Annan / ingen'].slice(0, Number(next.peopleCount) || 10);
  }
  if (/samma.*alla|same.*all/i.test(lower) && Number(next.peopleCount) > 1 && next.operators.length === 1) {
    next.operatorAppliesToAll = true;
  }

  const bindingAnswers = extractBindingAnswersFromText(text, next.peopleCount, next.bindingEnds);
  if (bindingAnswers) {
    if (bindingAnswers.length === 1 && /alla|samtliga|båda|both|all/i.test(lower)) next.bindingAppliesToAll = true;
    next.bindingEnds = bindingAnswers;
  } else if (hasBindingSignal(lower) && !next.bindingEnds.length) {
    next.bindingEnds = ['Vet inte'];
  }
  if (/samma.*alla|same.*all/i.test(lower) && Number(next.peopleCount) > 1 && next.bindingEnds.length === 1) {
    next.bindingAppliesToAll = true;
  }

  if (/wifi|social|sociala medier|lite surf/i.test(lower)) next.mobileUsage = 'low';
  if (/stream|video|youtube|netflix|hbo|disney/i.test(lower)) next.mobileUsage = 'medium';
  if (/max surf|mycket surf|fri surf|obegränsad|obegransad|obegränsat|obegransat|unlimited|unlimited data|100\s*gb/i.test(lower)) next.mobileUsage = 'high';
  const dataGbMatch = lower.match(/(\d{1,4})\s*(gb|gigabyte|gig|giga)\b/i);
  if (dataGbMatch) {
    const dataGb = Number(dataGbMatch[1]);
    if (dataGb >= 100) next.mobileUsage = 'high';
    else if (dataGb >= 20) next.mobileUsage = 'medium';
    else next.mobileUsage = 'low';
  }

  const priceSource = lower.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  let exactPrices = [...priceSource.matchAll(/(\d{2,4})\s*(kr|sek|kronor|spänn|spann)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price >= 50 && price <= 2000);
  if (
    exactPrices.length <= 1 &&
    /betalar|kostar|pris|kr|sek|kronor|spänn|spann/i.test(priceSource) &&
    /\b\d{2,4}\b(?:\s+\b\d{2,4}\b)+/.test(priceSource)
  ) {
    exactPrices = [...priceSource.matchAll(/\b(\d{2,4})\b/g)]
      .map((match) => Number(match[1]))
      .filter((price) => Number.isFinite(price) && price >= 50 && price <= 2000);
  }
  if (
    !exactPrices.length &&
    /betalar|kostar|pris|totalt|sammanlagt|tillsammans|total|combined/i.test(priceSource)
  ) {
    exactPrices = [...priceSource.matchAll(/\b(\d{2,4})\b/g)]
      .map((match) => Number(match[1]))
      .filter((price) => Number.isFinite(price) && price >= 50 && price <= 2000);
  }
  if (exactPrices.length) {
    const exactPrice = exactPrices[0];
    const totalPriceMention = exactPrices.length === 1 &&
      /totalt|sammanlagt|tillsammans|total|altogether|combined/i.test(lower);
    const totalPriceAppliesToFamily = totalPriceMention && Number(next.peopleCount) > 1;
    const totalPriceNeedsPeople = totalPriceMention && !Number(next.peopleCount);
    const perPersonPrice = totalPriceAppliesToFamily
      ? Math.round(exactPrice / Number(next.peopleCount))
      : (totalPriceNeedsPeople ? null : exactPrice);
    const rangePrice = exactPrices.length > 1
      ? Math.round(exactPrices.reduce((sum, price) => sum + price, 0) / exactPrices.length)
      : (perPersonPrice || exactPrice);
    if (perPersonPrice !== null) next.exactMonthlyPrice = perPersonPrice;
    if (totalPriceMention) {
      next.familyTotalPrice = exactPrice;
    }
    if (totalPriceAppliesToFamily) {
      next.priceAppliesToAll = true;
      next.exactMonthlyPrices = Array.from({ length: Number(next.peopleCount) }, () => perPersonPrice);
    }
    if (exactPrices.length > 1) {
      next.exactMonthlyPrices = [...next.exactMonthlyPrices, ...exactPrices].slice(0, Number(next.peopleCount) || 10);
    } else if (!totalPriceAppliesToFamily && /alla|samtliga|all|var|each|per/i.test(lower)) {
      next.priceAppliesToAll = true;
      next.exactMonthlyPrices = appendUntilPeopleCount(next.exactMonthlyPrices, exactPrice, next.peopleCount);
    } else if (!totalPriceAppliesToFamily && Number(next.peopleCount) > 1 && next.exactMonthlyPrices.length < Number(next.peopleCount)) {
      next.exactMonthlyPrices = [...next.exactMonthlyPrices, exactPrice].slice(0, Number(next.peopleCount));
    }

    if (rangePrice < 300) next.priceRange = 'under300';
    else if (rangePrice < 400) next.priceRange = '300-400';
    else next.priceRange = '400-500';
  } else if (/under\s*300/i.test(lower)) {
    next.priceRange = 'under300';
  } else if (/300\s*[–-]\s*400/i.test(lower)) {
    next.priceRange = '300-400';
  } else if (/400\s*[–-]\s*500|500\+/i.test(lower)) {
    next.priceRange = '400-500';
  }

  return normalizeQualification(next);
};

const getRecentUserText = (message, messages = []) => [
  ...trimMessages(messages)
    .filter((item) => item.role === 'user')
    .map((item) => item.content),
  message,
].join(' ');

const getAveragePrice = (prices = []) => {
  const numericPrices = prices
    .map((price) => Number(price))
    .filter((price) => Number.isFinite(price) && price > 0);
  if (!numericPrices.length) return null;
  return Math.round(numericPrices.reduce((sum, price) => sum + price, 0) / numericPrices.length);
};

const extractMarketDataGb = (text) => {
  const matches = [...String(text || '').matchAll(/(\d{1,4})\s*(gb|gigabyte|gig|giga)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return matches.length ? matches[matches.length - 1] : null;
};

const extractCampaignMonths = (text) => {
  const match = String(text || '').match(/(?:kampanj|campaign|första|first)[^\d]*(\d{1,2})\s*(mån|månad|månader|month|months)/i);
  return match ? Number(match[1]) : null;
};

const extractNormalPriceAfterCampaign = (text) => {
  const match = String(text || '').match(/(?:efter|sedan|sen|därefter|after|then)[^\d]*(\d{2,4})\s*(kr|sek|kronor|spänn|spann)/i);
  return match ? Number(match[1]) : null;
};

const extractClaimedMarketPrice = (text, qualification = {}) => {
  if (
    qualification.exactMonthlyPrice !== null &&
    qualification.exactMonthlyPrice !== undefined &&
    qualification.exactMonthlyPrice !== '' &&
    Number.isFinite(Number(qualification.exactMonthlyPrice))
  ) return Number(qualification.exactMonthlyPrice);

  const averagePrice = getAveragePrice(qualification.exactMonthlyPrices || []);
  if (averagePrice !== null) return averagePrice;

  const source = String(text || '').toLowerCase();
  if (/\b(gratis|free|0\s*(kr|sek|kronor))\b/.test(source)) return 0;

  const explicit = [...source.matchAll(/(\d{1,4})\s*(kr|sek|kronor|spänn|spann)/g)]
    .map((match) => Number(match[1]))
    .filter((price) => Number.isFinite(price) && price >= 0 && price <= 5000);
  if (explicit.length) return explicit[explicit.length - 1];

  const spokenHundreds = source.match(/\b(\d+)\s*hundra\b/);
  if (spokenHundreds) return Number(spokenHundreds[1]) * 100;

  return null;
};

const getMarketSegmentFromText = (text, qualification = {}) => {
  const lower = String(text || '').toLowerCase();
  if (qualification.customerSegment) return qualification.customerSegment;
  if (/företag|business|arbetsgivare|employer/.test(lower)) return 'business';
  if (/student/.test(lower)) return 'student';
  if (/senior|pensionär|pensionar/.test(lower)) return 'senior';
  if (/ungdom|youth/.test(lower)) return 'youth';
  if (/barn|child/.test(lower)) return 'child';
  if (/familj|family|delat|shared|samla/.test(lower) || Number(qualification.peopleCount) > 1) return 'family';
  return 'private';
};

const buildMarketClaim = ({ message, messages = [], qualification = {}, offerCalculation = null }) => {
  const recentText = getRecentUserText(message, messages);
  const lower = recentText.toLowerCase();
  const latestLower = String(message || '').toLowerCase();
  const claimedPrice = extractClaimedMarketPrice(recentText, qualification);
  const explicitDataGb = extractMarketDataGb(recentText);
  const isUnlimited = /obegränsad|obegransad|obegränsat|obegransat|fri surf|unlimited/.test(lower) ||
    (qualification.mobileUsage === 'high' && explicitDataGb === null);
  const dataGb = isUnlimited
    ? null
    : (explicitDataGb ?? (
      qualification.mobileUsage === 'low'
        ? 10
        : qualification.mobileUsage === 'medium'
          ? 30
          : qualification.mobileUsage === 'high'
            ? 100
            : null
    ));
  const segment = getMarketSegmentFromText(recentText, qualification);
  const firstOperator = qualification.operators?.[0] || null;
  const operatorId = firstOperator ? OPERATOR_ID_BY_NAME[firstOperator] : null;
  const marketSignal = /telia|tele2|telenor|tre|halebop|operatör|operator|pris|price|betalar|pay|kostar|kr|sek|kronor|spänn|spann|gb|gig|surf|data|obegränsad|obegransad|obegränsat|obegransat|unlimited|familj|family|student|senior|ungdom|youth|barn|child|kampanj|campaign|arbetsgivare|employer|winback|behållet|retained|paket|bundle|rabatt|discount/.test(lower);
  const latestMarketSignal = /pris|price|betalar|pay|kostar|kr|sek|kronor|spänn|spann|gb|gig|surf|data|obegränsad|obegransad|obegränsat|obegransat|unlimited|familj|family|student|senior|ungdom|youth|barn|child|kampanj|campaign|arbetsgivare|employer|winback|behållet|retained|paket|bundle|rabatt|discount|gäller.*månader|bara.*månader|temporary|slå|beat|vanliga pris|ordinary price/.test(latestLower);
  const hasClaim = Boolean(
    claimedPrice !== null &&
    marketSignal &&
    (latestMarketSignal || qualification.readyForOffer) &&
    (isUnlimited || dataGb !== null || segment !== 'private' || /kampanj|campaign|winback|arbetsgivare|employer/.test(lower))
  );

  if (!hasClaim) return null;

  return {
    claimedPrice,
    dataGb,
    isUnlimited,
    segment,
    operatorId,
    isCampaignPrice: /kampanj|campaign|intro|första|first|gäller.*månader|bara.*månader|tillfällig|tillfallig|temporary/.test(lower),
    campaignMonths: extractCampaignMonths(recentText),
    normalPriceAfterCampaign: extractNormalPriceAfterCampaign(recentText),
    familyBundle: segment === 'family',
    sharedPlan: /delat|shared/.test(lower),
    studentDiscount: /student/.test(lower),
    seniorDiscount: /senior|pensionär|pensionar/.test(lower),
    youthDiscount: /ungdom|youth/.test(lower),
    childPlan: /barn|child/.test(lower),
    employerPaid: /arbetsgivare|jobbet betalar|employer|work pays|company pays/.test(lower),
    oldRetainedContract: /gammalt|behållet|behallet|retained|old contract/.test(lower),
    bundledDiscount: /paket|bundle|bredband.*mobil|mobil.*bredband/.test(lower),
    winbackOffer: /winback|stanna kvar|retention|räddningserbjudande/.test(lower),
    hasBindingContext: hasBindingSignal(lower) || Boolean(qualification.bindingEnds?.length),
    canDealettBeat: offerCalculation?.validOfferAvailable === true
      ? true
      : offerCalculation?.readyForOffer === true
        ? false
        : undefined,
  };
};

const applyMarketIntelligenceGate = ({ intent, toolResult, marketClaim }) => {
  if (!['mobile_offer', 'family_offer'].includes(intent) || !marketClaim) return toolResult;

  const classification = classifyCustomerClaim(marketClaim);
  if (
    classification.status === 'human_review' &&
    toolResult?.type === 'qualification' &&
    marketClaim.familyBundle &&
    Number(toolResult?.offerCalculation?.assumptions?.familyTotalPrice || 0) <= 0
  ) {
    return {
      ...toolResult,
      marketClaim,
      marketClassification: classification,
    };
  }
  if (classification.status === 'realistic') {
    return {
      ...toolResult,
      marketClaim,
      marketClassification: classification,
    };
  }

  return {
    type: 'market_intelligence',
    status: classification.status,
    marketClaim,
    marketClassification: classification,
    originalToolResult: toolResult,
    offerCalculation: toolResult.offerCalculation,
    rule: 'Market intelligence must be checked before recommending an offer.',
  };
};

const tokenize = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
  .split(/\s+/)
  .filter((token) => token.length > 2);

const flattenKnowledge = (value, label = '') => {
  if (!value) return [];
  if (typeof value === 'string' || typeof value === 'number') return [`${label}: ${value}`];
  if (Array.isArray(value)) return value.flatMap((item, index) => flattenKnowledge(item, label ? `${label}.${index}` : String(index)));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => flattenKnowledge(item, label ? `${label}.${key}` : key));
  }
  return [];
};

const retrieveKnowledge = ({ message, intent, cart = [] }) => {
  const rules = loadChatRules();
  const query = new Set([...tokenize(message), ...tokenize(intent)]);
  const docs = [
    ...flattenKnowledge(rules['site-content'], 'site'),
    ...flattenKnowledge(rules['dealett-profile'], 'profile'),
    ...flattenKnowledge(rules['website-map'], 'map'),
    ...getPlans().map((plan) => `plan ${plan.operator} ${plan.title}: ${plan.data || ''}, ${plan.price} kr/mån, ${plan.text || ''}`),
    ...getBroadbandPlans().map((plan) => `broadband ${plan.operator} ${plan.title}: ${plan.speed}, ${plan.price} kr/mån, ${(plan.features || []).join(', ')}`),
    ...cart.map((item) => `cart ${item.operator || ''} ${item.title || ''}: ${item.price || 0} kr/mån, ${item.rewardTotal || 0} kr presentkort`),
  ];

  return docs
    .map((text) => ({
      text,
      score: tokenize(text).reduce((score, token) => score + (query.has(token) ? 1 : 0), 0),
    }))
    .filter((doc) => doc.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((doc) => doc.text);
};

const hasDealettTopic = (message) => (
  /dealett|abonnemang|mobil|telefon|telekom|bredband|5g|fiber|täckning|operator|operatör|telia|tele2|telenor|tre|halebop|presentkort|gift card|surf|varukorg|cart|faktura|konto|mina sidor/i
    .test(String(message || ''))
);

const hasOutsideTopic = (message) => (
  /elavtal|elbolag|hemförsäkring|försäkring|insurance|electricity|bank|bolån|lån|loan|matkasse|flyg|flight|resa|travel/i
    .test(String(message || ''))
);

const hasPersonalDataInChat = (message) => (
  /personnummer|bankid|mitt nummer|my number|phone number|telefonnummer|\b0\d[\d\s-]{6,}\d\b/i
    .test(String(message || ''))
);

const isBrowsingMessage = (message) => (
  /tittar runt|kollar runt|kika runt|bara kollar|kolla om|kolla runt|såg.*reklam|testa|nyfiken|något intressant|nåt intressant|har ni det|browsing|looking around|curious|interesting|anything good|good deal/i
    .test(String(message || ''))
);

const isReluctantMessage = (message) => (
  /vill inte|inte intresserad|behöver inte|behover inte|varför ska jag|varfor ska jag|redan abonnemang|redan.*familj|already have|don't want|do not want|not interested/i
    .test(String(message || ''))
);

const hasStrongOfferIntent = (message) => (
  /billigare|billigast|bästa|basta|best|dyrt|för dyrt|sänka|sanka|spara|byta|jämför|jamfor|behovsanalys|erbjudande|rekommendera|hjälp.*välja|samla abonnemang|samla.*abonnemang|vill ha.*abonnemang|need cheaper|cheapest|lowest price|too expensive|switch|compare|offer|recommend|help.*choose/i
    .test(String(message || ''))
);

const hasCheapestOnlyIntent = (message) => (
  /bara.*billigast|ge mig.*billigast|exakt billigast|exakt billigaste|billigaste abonnemang|bara.*bästa|bara.*basta|ge mig.*bästa|ge mig.*basta|bästa erbjudandet|basta erbjudandet|best deal|best offer|don't ask|dont ask|fråga inte|fraga inte|orkar inte svara/i
    .test(String(message || ''))
);

const hasBindingSignal = (message) => (
  /bindningstid|bindning|binding|contract|låst|last|uppsägning|uppsagning|till oktober|till november|till december|till januari|till februari|till mars|till april|till maj|till juni|till juli|till augusti|till september/i
    .test(String(message || ''))
);

const hasCampaignSignal = (message) => (
  /kampanj|campaign|första månader|första mån|bara.*månader|några månader|tillfällig|tillfallig|temporary|intro/i
    .test(String(message || ''))
);

const hasFakeConditionSignal = (message) => (
  /låtsas|latsas|säg att jag inte|sag att jag inte|skriv bara|räkna som student fast|rakna som student fast|fast jag inte|hitta på|fake|pretend/i
    .test(String(message || ''))
);

const hasTrustSignal = (message) => (
  /oberoende|partisk|partiska|lita på|lita pa|får ni betalt|far ni betalt|varför får ni betalt|varfor far ni betalt|betalar er|provision|ersättning|ersattning|biased|can i trust|do i trust|trust you|trusted|are you paid|get paid|paid by/i
    .test(String(message || ''))
);

const getSoftGuidanceType = (message) => {
  const text = String(message || '').toLowerCase();
  if (/jag vill ha bästa,?\s*inte billigast|vill ha bästa.*inte billigast|bästa.*inte billigast|basta.*inte billigast|best.*not cheapest/.test(text)) return 'best_not_cheapest';
  if (/ställ inte massa frågor|stall inte massa fragor|fråga inte|fraga inte|bara säg|bara sag|dont ask|don't ask/.test(text)) return 'no_patience';
  if (/säkert val|sakert val|tryggt val|safe choice/.test(text)) return 'safe_choice';
  if (/orkar inte.*abonnemang|alla luras|känns.*luras|kanns.*luras|frustrerad|jobbigt.*abonnemang/.test(text)) return 'emotional';
  if (/vet inte vad jag betalar|vet inte.*pris|ingen aning.*pris|kommer inte ihåg.*pris|kommer inte ihag.*pris/.test(text)) return 'unknown_price';
  if (/runt\s*\d{2,4}|cirka\s*\d{2,4}|typ\s*\d{2,4}|ungefär\s*\d{2,4}|ungefar\s*\d{2,4}|\d{2,4}\s*nånting|\d{2,4}\s*nanting/.test(text)) return 'approximate_price';
  if (/ingen aning.*surf|vet inte.*surf|vet inte.*gb|hur mycket surf jag använder|hur mycket surf jag anvander/.test(text)) return 'unknown_data';
  if (/bryr mig inte om gb|vill bara att det ska funka|ska bara funka|något som funkar|nat som funkar|something that works/.test(text)) return 'reliability_first';
  if (/till mitt barn|till.*barn|barn.*abonnemang|child.*plan/.test(text)) return 'child_plan';
  if (/(min\s+)?pappa.*(ringa|bankid)|(min\s+)?mamma.*(ringa|bankid)|senior.*(ringa|bankid)|äldre.*(ringa|bankid|abonnemang)|aldre.*(ringa|bankid|abonnemang)/.test(text)) return 'elder_parent';
  if (/flera hemma.*rörigt|flera hemma.*rorigt|allt är rörigt|allt ar rorigt|family.*messy/.test(text)) return 'family_unclear';
  if (/internet hemma.*mobil|mobil.*internet hemma|hemma.*mobil.*samma|mobil.*bredband.*samma|bredband.*mobil.*samma/.test(text)) return 'mobile_broadband_mix';
  if (/bor i\s+(jakobsberg|barkarby)|bor nära\s+(jakobsberg|barkarby)|bor nara\s+(jakobsberg|barkarby)|nära barkarby|nara barkarby|nära jakobsberg|nara jakobsberg/.test(text)) return 'coverage_area';
  if (/hemma.*dålig täckning|hemma.*dalig tackning|ute funkar|inomhus.*dålig|inomhus.*dalig|har tele2.*suger hemma|tele2.*suger hemma|suger hemma/.test(text)) return 'coverage_indoor';
  if (/kompis.*telia.*funkar|telia.*funkar.*hos mig|friend.*telia.*works/.test(text)) return 'friend_coverage_signal';
  if (/samma abonnemang.*många år|samma abonnemang.*manga ar|haft.*abonnemang.*många år|haft.*abonnemang.*manga ar|old plan/.test(text)) return 'old_plan';
  return null;
};

const hasMobileConversationContext = (text, qualification = {}) => Boolean(
  qualification.peopleCount ||
  qualification.mobileUsage ||
  qualification.priceRange ||
  (qualification.exactMonthlyPrice !== null && qualification.exactMonthlyPrice !== undefined) ||
  qualification.operators?.length ||
  qualification.bindingEnds?.length ||
  qualification.exactMonthlyPrices?.length ||
  /mobil|abonnemang|telefon|operatör|operator|telia|tele2|telenor|tre|halebop|surf|gb|kr|sek|billig|dyrt|bindning|kampanj|winback|student|senior|familj/i.test(text)
);

const isGreetingOnly = (message) => (
  /^(hej|hejsan|hallå|halla|tja|tjena|läget|laget|hej hur mår du|hej hur mar du|hallå hur mår du|halla hur mar du|hur är läget|hur ar laget|god morgon|god kväll|hello|hi|hey|good morning|good evening)[!?.\s]*$/i
    .test(String(message || '').trim())
);

const hasDirectAnswerSignal = (message) => (
  /utan fler frågor|utan fler fragor|utan frågor|utan fragor|svara nu|svara direkt|nu direkt|bara svara|bara säg|bara sag|kort svar|no more questions|answer now|direct answer/i
    .test(String(message || ''))
);

const hasCoverageSignal = (message) => (
  /täckning|tackning|coverage|nät|nat|signal|karta|map|jakobsberg|barkarby/i
    .test(String(message || ''))
);

const hasJakobsbergAreaSignal = (message) => (
  /jakobsberg|barkarby/i.test(String(message || ''))
);

const isGenericTopicStart = (message) => (
  /^(abonnemang|mobilabonnemang|mobil|bredband|bredband hemma|täckning|tackning|presentkort|mobile|mobile plan|broadband|home broadband|coverage|gift card)[!?.\s]*$/i
    .test(String(message || '').trim())
);

const hasCapabilityQuestion = (message) => (
  /vad kan du( göra| gora)?|vad gör du|vad gor du|hur kan du hjälpa|hur kan du hjalpa|vad kan jag fråga|what can you do|how can you help/i
    .test(String(message || ''))
);

const OPERATOR_SELF_SERVICE = {
  tre: 'Mitt3 eller Tre-appen',
  telia: 'Mina sidor eller Telia-appen',
  tele2: 'Mitt Tele2 eller Tele2-appen',
  telenor: 'Mitt Telenor eller Telenor-appen',
};

const getMockSupportOperator = ({ message, appContext = {} }) => {
  const explicitOperator = String(
    appContext.operator ||
    appContext.operatorName ||
    appContext.selectedOperator ||
    appContext.provider ||
    ''
  ).trim();
  const source = `${message || ''} ${explicitOperator}`.toLowerCase();
  if (/\btele\s*2\b|\btele2\b/.test(source)) return 'Tele2';
  if (/\btelia\b/.test(source)) return 'Telia';
  if (/\btelenor\b/.test(source)) return 'Telenor';
  if (/\btre\b|\bmitt3\b|\b3extra\b/.test(source)) return 'Tre';
  return explicitOperator || null;
};

const hasSupportActionRequest = (message) => (
  /kan du (fixa|göra|gora|ändra|andra|säga upp|saga upp|avsluta|beställa|bestalla|aktivera|starta)|fixa det|gör det|gor det|starta ett ärende|starta ett arende|göra ändringen|gora andringen|åt mig|at mig/i
    .test(String(message || ''))
);

const hasRecentSupportContext = (messages = []) => (
  Array.isArray(messages) &&
  messages
    .slice(-6)
    .some((item) => /faktura|betal|abonnemang|support|kundservice|konto|sim|esim|puk|pin|roaming|bredband|router|tv|kanal|röstbrevlåda|rostbrevlada|täckning|tackning|drift|felanmäl|felanmal|säkerhet|sakerhet|spärr|sparr/i.test(String(item?.content || '')))
);

const getOperatorSupportTopic = (message) => {
  const text = String(message || '').toLowerCase();
  if (/tv\b|tv-|tv\s|kanal|streaming|play|tv-box|tvbox|tv hub|tv-hub|hubb/i.test(text)) return 'tv_streaming';
  if (/röstbrevlåda|rostbrevlada|voicemail/i.test(text)) return 'voicemail';
  if (/publik ip|öppna portar|oppna portar|port.?forward|hemmaserver|dns|nat-typ|nat typ/i.test(text)) return 'advanced_network';
  if (/roaming|dataroaming|utomlands|utland|eu|utlandssamtal/i.test(text)) return 'roaming';
  if (/e-post|epost|webmail|mailkonto|mailen/i.test(text)) return 'email';
  if (/smartklock|smart watch|apple watch|galaxy watch|extra sim|extra-sim|extra användare|extra anvandare/i.test(text)) return 'addon';
  if (/reparation|försäkring|forsakring|skada|skärm|skarm|servicepartner|verkstad|trasig/i.test(text)) return 'device_repair';
  if (/beloppsgräns|beloppsgrans|spärr|sparr|bedrägeri|bedrageri|säkerhet|sakerhet|id-kapning|id kapning/i.test(text)) return 'security';
  if (/autogiro|\be-faktura\b|\befaktura\b|betal|förfall|forfall|nekades|påminnelse|paminnelse|inkasso|kredit|kvitto|swish|kortbetal|avgift|återbetal|aterbetal|bestrid/i.test(text)) return 'payment';
  if (/faktura|räkning|rakning|debiter|moms|företagsfaktura|foretagsfaktura|specificer/i.test(text)) return 'invoice';
  if (/beställ|bestall|order|spåra|spara min best|leverans|leverera|simkort|sim-kort|esim|e-sim|aktivera|puk|pin-kod|pinkod/i.test(text)) return 'order_sim';
  if (/ändra|andra|avsluta|säga upp|saga upp|uppsäg|uppsag|överlåt|overlat|abonnemangsägare|abonnemangsagare|fullmakt|dödsbo|dodsbo|byta abonnemang|nummerflytt|flytta.*nummer|flyttar.*nummer|pausa/i.test(text)) return 'subscription';
  if (/logga in|inlogg|konto|mina sidor|mitt tele2|mitt telenor|mitt3|telia-appen|tele2-appen|telenor-appen|tre-appen|bankid|bank-id|lösenord|losenord|behörighet|behorighet|inte abonnemangsägare|inte abonnemangsagare/i.test(text)) return 'account';
  if (/surf|dataförbruk|dataforbruk|förbrukning|forbrukning|saldo|hur mycket data|extra data|köpa data|kopa data/i.test(text)) return 'usage';
  if (/roaming|utomlands|utland|eu|sms|samtal|mms|wifi-samtal|vo[l]?te|telefoni/i.test(text)) return 'network';
  if (/täckning|tackning|drift|störning|storning|nät|nat|internet.*funk|hastighet|långsam|langsam|signal/i.test(text)) return 'network';
  if (/bredband|fiber|router|wifi|wi-fi|tv-kanal|tv kanal|iptv/i.test(text)) return 'broadband_operator';
  if (/företag|foretag|företags|foretags|organisationsnummer/i.test(text)) return 'business';
  if (/vilka .*abonnemang|vad .*abonnemang|erbjuder|prislista|student|senior|familj.*abonnemang|mobilabonnemang|extra användare|extra anvandare|uppkoppling/i.test(text)) return 'products';
  if (/kundservice|support|kontakt|chatta|ringa|mejla|maila/i.test(text)) return 'contact';
  return null;
};

const hasOperatorSupportQuestionShape = (message) => (
  /(^|\s)(hur|var|vart|vad|varför|varfor|när|nar|vilka|kan jag|går det|gar det|behöver jag|behover jag|why|how|where|what|when|can i)\b|\?/.test(String(message || '').toLowerCase())
);

const shouldUseMockOperatorSupport = ({ message, messages = [], appContext = {}, intent = null }) => {
  if (['dealett_trust', 'fake_condition', 'capabilities', 'identity', 'small_talk', 'outside_scope'].includes(intent)) return false;
  const topic = getOperatorSupportTopic(message);
  const actionRequest = hasSupportActionRequest(message) && hasRecentSupportContext(messages);
  if (!topic && !actionRequest) return false;
  const text = String(message || '').toLowerCase();
  const operator = getMockSupportOperator({ message, appContext });
  const questionLike = hasOperatorSupportQuestionShape(message);
  const problemLike = /fel|fungerar inte|funkar inte|kan inte|saknas|nekad|nekades|inte fått|inte fatt|stoppad|spärr|sparr|tappat|förlorat|forlorat|problem/i.test(text);
  if (!questionLike && !problemLike && !actionRequest) return false;
  if (!operator && ['network', 'broadband_operator', 'products', 'tv_streaming', 'advanced_network'].includes(topic)) return false;
  const hasOfferIntent = /billigare|billigast|bästa|basta|jämför|jamfor|rekommendera|erbjudande|presentkort|dealett|switch|compare|recommend|gift card/i.test(text);
  const isAdminTopic = ['payment', 'invoice', 'order_sim', 'subscription', 'account', 'usage', 'network', 'broadband_operator', 'business', 'contact'].includes(topic);
  if (hasOfferIntent && !isAdminTopic && ['mobile_offer', 'family_offer', 'cheapest_start'].includes(intent)) return false;
  return Boolean(operator || questionLike || problemLike);
};

const buildMockOperatorSupportReply = ({ message, messages = [], language = 'sv', appContext = {}, intent = null }) => {
  if (!shouldUseMockOperatorSupport({ message, messages, appContext, intent })) return null;

  const isEnglish = language === 'en';
  const operator = getMockSupportOperator({ message, appContext });
  const operatorLabel = operator || (isEnglish ? 'your operator' : 'din operatör');
  const selfService = operator ? OPERATOR_SELF_SERVICE[operator.toLowerCase()] || `${operator}s app eller Mina sidor` : (isEnglish ? 'the operator app or My pages' : 'operatörens app eller Mina sidor');
  const topic = getOperatorSupportTopic(message) || (hasSupportActionRequest(message) ? 'action_boundary' : null);

  if (isEnglish) {
    const opening = `As ${operatorLabel} would normally answer:`;
    const replies = {
      action_boundary: `${opening} I cannot make account changes, cancel subscriptions, activate services, take payments or create a real support case from this chat. I can guide you, but the safe next step is ${selfService} or authenticated ${operatorLabel} support for anything that changes the account.`,
      payment: `${opening} manage direct debit, e-invoice and payment status in ${selfService}. If a payment was rejected or is missing, check the bank account first and then contact ${operatorLabel} support so they can see the account-specific status.`,
      invoice: `${opening} open the invoice in ${selfService} and compare subscription fees, add-ons, usage, discounts and one-time charges. If a charge looks wrong, contact ${operatorLabel} support because they need authenticated account access.`,
      order_sim: `${opening} track orders, SIM/eSIM status and activation in ${selfService} or from the order confirmation. If the SIM, eSIM or delivery is missing, contact ${operatorLabel} support with the order number.`,
      subscription: `${opening} changes, cancellations, transfers and ownership questions usually require login and identity verification in ${selfService} or authenticated support. Do not send personal identity details in chat.`,
      account: `${opening} log in to ${selfService} to see subscriptions, permissions, invoices and usage. The subscription owner controls sensitive changes; support can help with identity or power-of-attorney questions.`,
      usage: `${opening} check used data, remaining data and add-ons in ${selfService}. If the usage does not match what you expect, compare it with the invoice and ask support to review the account.`,
      network: `${opening} first check operating-status and coverage information, restart the device/router and test another location if possible. If the problem remains, report it to ${operatorLabel} support with address, device and time of issue.`,
      roaming: `${opening} check roaming is enabled in the phone and in ${selfService}, then restart the phone and manually choose a local network if needed. Contact ${operatorLabel} support if roaming is blocked on the account or charges look wrong.`,
      broadband_operator: `${opening} restart the router, check operating status and then review broadband/router settings in ${selfService}. For address-specific fiber or broadband faults, ${operatorLabel} support must troubleshoot the line.`,
      tv_streaming: `${opening} restart the TV box or app, check operating status and verify channel/package access in ${selfService}. If channels are missing or the box shows an error code, contact ${operatorLabel} support with the error code and equipment model.`,
      voicemail: `${opening} voicemail codes and settings normally sit in ${selfService}, the phone settings or authenticated support. If the code is missing or locked, ${operatorLabel} support must verify the subscriber before resetting it.`,
      advanced_network: `${opening} public IP, port opening and advanced router settings depend on the broadband/mobile broadband service and router. Check available add-ons/settings in ${selfService}; if the option is missing, ${operatorLabel} support needs to confirm whether it is supported for the subscription.`,
      device_repair: `${opening} start with warranty/insurance status and repair options in ${selfService}. For damage, service or insurance claims, use the official repair or insurance flow and avoid sending sensitive identity details in chat.`,
      security: `${opening} for spending limits, blocks, suspected fraud or security issues, use ${selfService} if available and contact authenticated ${operatorLabel} support quickly. Do not share passwords, BankID codes or card details in chat.`,
      email: `${opening} check email/webmail settings, password reset and service status in ${selfService}. If the mailbox is locked or missing, authenticated ${operatorLabel} support needs to verify the account.`,
      addon: `${opening} add-ons such as extra SIM, smartwatch services or extra users are managed in ${selfService}. If provisioning does not work, contact ${operatorLabel} support so they can check the subscription and activation status.`,
      business: `${opening} company accounts normally use the business portal or authenticated business support, especially for invoices, authorizations and power of attorney.`,
      products: `${opening} current mobile plans and campaigns can change, so check ${operatorLabel}'s plan page or app for the live assortment. Dealett can still compare total value if you want an independent comparison.`,
      contact: `${opening} use ${selfService} first for self-service. If the issue needs account access, contact authenticated ${operatorLabel} support by the official support channel.`,
    };
    return replies[topic] || `${opening} start in ${selfService}. If the case needs account data, contact authenticated ${operatorLabel} support.`;
  }

  const opening = `Som ${operatorLabel} normalt skulle svara:`;
  const replies = {
    action_boundary: `${opening} jag kan inte göra kontoändringar, säga upp abonnemang, aktivera tjänster, ta betalt eller starta ett riktigt supportärende från chatten. Jag kan guida dig, men säkra nästa steget är ${selfService} eller autentiserad ${operatorLabel}-kundservice när något ska ändras på kontot.`,
    payment: `${opening} hantera autogiro, e-faktura och betalstatus i ${selfService}. Om en betalning har nekats eller saknas bör du först kontrollera banken och sedan kontakta ${operatorLabel}s kundservice så att de kan se status på kontot.`,
    invoice: `${opening} öppna fakturan i ${selfService} och jämför abonnemangsavgifter, tillval, förbrukning, rabatter och engångskostnader. Om en debitering verkar fel behöver ${operatorLabel}s kundservice kontrollera kontot efter inloggning.`,
    order_sim: `${opening} spåra beställning, SIM/eSIM och aktivering i ${selfService} eller via orderbekräftelsen. Om SIM, eSIM eller leverans saknas bör du kontakta ${operatorLabel}s kundservice med ordernummer.`,
    subscription: `${opening} ändring, uppsägning, överlåtelse och frågor om abonnemangsägare kräver normalt inloggning och identifiering i ${selfService} eller hos autentiserad kundservice. Skicka inte personnummer i chatten.`,
    account: `${opening} logga in i ${selfService} för att se abonnemang, behörigheter, fakturor och förbrukning. Abonnemangsägaren styr känsliga ändringar; kundservice kan hjälpa vid fullmakt eller identitetskontroll.`,
    usage: `${opening} kontrollera använd surf, kvarvarande surf och tillval i ${selfService}. Om förbrukningen inte stämmer med din bild bör du jämföra med fakturan och be kundservice granska kontot.`,
    network: `${opening} börja med att kontrollera driftinformation och täckning, starta om mobil/router och testa en annan plats om möjligt. Om felet kvarstår bör du felanmäla till ${operatorLabel}s kundservice med adress, enhet och tidpunkt.`,
    roaming: `${opening} kontrollera att roaming är påslaget i mobilen och i ${selfService}, starta om mobilen och välj nät manuellt om det behövs. Kontakta ${operatorLabel}s kundservice om roaming är spärrat på kontot eller om debiteringen verkar fel.`,
    broadband_operator: `${opening} starta om routern, kontrollera driftstatus och gå igenom bredbands- eller routerinställningar i ${selfService}. För adressbundna fiber- eller bredbandsfel behöver ${operatorLabel}s support felsöka linjen.`,
    tv_streaming: `${opening} starta om tv-boxen eller appen, kontrollera driftstatus och se att kanalpaket/behörighet finns i ${selfService}. Om kanaler saknas eller tv-boxen visar felkod bör du kontakta ${operatorLabel}s kundservice med felkod och modell.`,
    voicemail: `${opening} kod och inställningar för röstbrevlådan hanteras normalt i ${selfService}, telefonens inställningar eller via autentiserad kundservice. Om koden saknas eller är låst behöver ${operatorLabel}s support verifiera abonnenten innan återställning.`,
    advanced_network: `${opening} publik IP, portöppning och avancerade routerinställningar beror på bredbands- eller mobilt bredbandstjänsten och routern. Kontrollera tillval/inställningar i ${selfService}; om valet saknas behöver ${operatorLabel}s support bekräfta om abonnemanget stödjer det.`,
    device_repair: `${opening} börja med garanti, försäkring och reparationsflöde i ${selfService}. Vid skada, service eller försäkringsärende ska du använda den officiella reparations- eller försäkringsvägen och inte skriva känsliga id-uppgifter i chatten.`,
    security: `${opening} för beloppsgränser, spärrar, misstänkt bedrägeri eller säkerhetsärenden bör du använda ${selfService} om det går och snabbt kontakta autentiserad ${operatorLabel}-kundservice. Dela inte lösenord, BankID-koder eller kortuppgifter i chatten.`,
    email: `${opening} kontrollera e-post/webmail-inställningar, lösenordsåterställning och driftstatus i ${selfService}. Om brevlådan är låst eller saknas behöver autentiserad ${operatorLabel}-support verifiera kontot.`,
    addon: `${opening} tillägg som extra SIM, smartklocka eller extra användare hanteras i ${selfService}. Om aktivering eller delning inte fungerar behöver ${operatorLabel}s kundservice kontrollera abonnemanget och aktiveringsstatus.`,
    business: `${opening} företagsärenden hanteras normalt i företagsportalen eller via autentiserad företagssupport, särskilt fakturor, behörigheter och fullmakter.`,
    products: `${opening} aktuella mobilabonnemang och kampanjer kan ändras, så kontrollera ${operatorLabel}s abonnemangssida eller app för live-utbudet. Dealett kan fortfarande jämföra totalvärdet om du vill ha en oberoende jämförelse.`,
    contact: `${opening} använd ${selfService} först för självservice. Om ärendet kräver kontodata behöver du kontakta autentiserad ${operatorLabel}-kundservice via deras officiella supportkanal.`,
  };
  return replies[topic] || `${opening} börja i ${selfService}. Om ärendet kräver kontodata behöver autentiserad ${operatorLabel}-kundservice hjälpa dig.`;
};

const hasIdentityQuestion = (message) => (
  /vem är du|vem ar du|who are you|är du en människa|ar du en manniska|är du människa|ar du manniska|du människa|du manniska|människa$|manniska$|är du ai|ar du ai|är du robot|ar du robot|chatbot|bot/i
    .test(String(message || '').trim())
);

const hasSmallTalkQuestion = (message) => (
  /gillar du|tycker du om|favorit|fotboll|hockey|väder|vader|hur mår du|hur mar du|läget|laget/i
    .test(String(message || ''))
);

const isLowInformationAcknowledgement = (message) => (
  /^(ok|okej|ja|japp|yes|mm|mhm|aha|alright|sure)[!?.\s]*$/i
    .test(String(message || '').trim())
);

const hasActiveQualificationQuestion = (messages = []) => {
  const previousAssistant = [...trimMessages(messages)]
    .reverse()
    .find((item) => item.role === 'assistant')?.content || '';

  return /hur många abonnemang|bara till dig|priset bara för dig|priset bara for dig|gäller (det|priset) (bara dig|ett abonnemang|ett abonnemang eller flera)|is it (just you|one subscription)|vilken operatör|operatören du har|operator.*today|bindningstid|contract time|hur använder du mobilen|mobile data|vad betalar du|prisintervall|price range/i
    .test(previousAssistant);
};

const normalizeContextualMessage = (message, messages = []) => {
  const latest = normalizeCommonTypos(message).trim();
  const normalized = latest.toLowerCase();
  const previousMessages = trimMessages(messages);

  const previousAssistant = [...previousMessages]
    .reverse()
    .find((item) => item.role === 'assistant')?.content || '';
  const previousUser = [...previousMessages]
    .reverse()
    .find((item) => item.role === 'user')?.content || '';

  if (
    /^(bara mig|bara jag|mig|jag|just me|only me|me)$/i.test(normalized) &&
    /hur många abonnemang|bara till dig|priset bara för dig|priset bara for dig|gäller (det|priset) (bara dig|ett abonnemang|ett abonnemang eller flera)|is it (just you|one subscription)/i.test(previousAssistant)
  ) {
    return '1 abonnemang';
  }

  if (
    /^(ingen|inget|nej|nä|nää|0|ingen bindning|ingen bindningstid|no|none|no contract|no binding)$/i.test(normalized) &&
    /bindningstid|månader kvar|contract time|contract.*left/i.test(previousAssistant)
  ) {
    return 'Ingen bindningstid';
  }

  if (
    /^(annan|andra|annat|annan operatör|annan operator|other|other operator)$/i.test(normalized) &&
    /vilken operatör|operatören du har|operator.*today/i.test(previousAssistant)
  ) {
    return 'Annan / ingen';
  }

  const approximateNumberMatch = normalized.match(new RegExp(`^(\\d+|${numberWordPattern})\\s*(typ|kanske|maybe|ungefär|ungefar)?$`, 'i'));
  const numberMatch = normalized.match(numberOnlyPattern) || approximateNumberMatch;
  if (numberMatch) {
    const parsedNumber = parseNumberValue(numberMatch[1]);
    if (/hur många abonnemang|one subscription|several subscriptions|bara till dig|gäller det ett abonnemang eller flera|is it one subscription or several/i.test(previousAssistant)) {
      return `${parsedNumber} abonnemang`;
    }
    if (/bindningstid|månader kvar|contract time|contract.*left/i.test(previousAssistant)) {
      return `${parsedNumber} months`;
    }
    if (/vad betalar|pris|price|pay per subscription/i.test(previousAssistant) && parsedNumber >= 50) {
      return `${parsedNumber} kr`;
    }
  }

  if (/^(månader|mån|months?)$/i.test(normalized)) {
    const previousNumber = String(previousUser || '').trim().toLowerCase().match(numberOnlyPattern);
    if (previousNumber && /bindningstid|månader kvar|contract time|contract.*left/i.test(previousAssistant)) {
      return `${parseNumberValue(previousNumber[1])} months`;
    }
  }

  const confirmedCount = previousAssistant.match(/menar du\s+(\d+)\s+abonnemang/i);
  if (confirmedCount && /^(ja|japp|yes|starta|börja|borja|ok|okej)$/i.test(normalized)) {
    return `${Number(confirmedCount[1])} abonnemang`;
  }

  if (/^(kör|kor|kör igång|kor igang|starta|börja|borja|kom igång|kom igang)$/i.test(normalized)) {
    const recentText = previousMessages.map((item) => item.content).join(' ');
    if (/abonnemang|mobil|telefon|behovsanalys/i.test(recentText)) return 'jag vill jämföra abonnemang';
  }

  return latest;
};

const detectIntent = ({ message, messages = [], page = {}, qualification = {}, conversationStyle = null, appContext = {} }) => {
  const text = normalizeCommonTypos(message).toLowerCase();
  const pagePath = String(page?.path || '');
  const recentUserConversation = trimMessages(messages)
    .filter((item) => item.role === 'user')
    .map((item) => item.content)
    .join(' ')
    .toLowerCase();
  const recentConversation = trimMessages(messages)
    .map((item) => item.content)
    .join(' ')
    .toLowerCase();
  const fullUserContext = [recentUserConversation, text].filter(Boolean).join(' ');
  const supportContextActive = /faktura|räkning|förfall|invoice|bill|mina sidor|konto|account|kundservice|support/.test(recentUserConversation);
  const coverageContextActive = /täckning|coverage|nät|map|karta|adress|address/.test(recentUserConversation);
  const broadbandContextActive = /bredband|5g[-\s]?bredband|internet hemma|router|fiber|broadband/.test(recentUserConversation);
  const checkoutContextActive = /köp|köpa|beställ|beställa|personnummer|uppgifter|checkout|cart|buy|purchase|personal details/.test(recentUserConversation);
  const offerContextActive = /mobilabonnemang eller bredband|mobile subscription or broadband|hur många abonnemang|how many subscriptions|bästa|basta|billigast|för dyrt|dyrt|erbjudande|jämför|jamfor|hitta billigare|kan.*slå|beat it|current deal/i.test(recentConversation);
  const salesClaimSignal = /telia|tele2|telenor|tre|halebop|comviq|hallon|vimla|fello|operatör|operator|pris|price|betalar|pay|kostar|kr|sek|kronor|spänn|spann|gb|gig|surf|data|wifi|wi-fi|obegränsad|obegransad|unlimited/i.test(text);
  const hasQualification = Boolean(
    qualification.peopleCount ||
    qualification.mobileUsage ||
    qualification.priceRange ||
    qualification.exactMonthlyPrice ||
    qualification.operators?.length ||
    qualification.bindingEnds?.length ||
    qualification.exactMonthlyPrices?.length
  );
  const answeringQualificationQuestion = hasActiveQualificationQuestion(messages);

  if (hasTrustSignal(text)) return 'dealett_trust';
  if (hasFakeConditionSignal(text)) return 'fake_condition';
  if (hasCapabilityQuestion(text)) return 'capabilities';
  if (hasIdentityQuestion(text)) return 'identity';
  if (isGreetingOnly(text)) return 'greeting';
  if (hasSmallTalkQuestion(text) && !hasDealettTopic(text)) return 'small_talk';
  if (shouldUseMockOperatorSupport({ message: text, messages, appContext, intent: 'support' })) return 'support';
  if (coverageContextActive && hasDirectAnswerSignal(text)) return 'coverage';
  if (broadbandContextActive && isLowInformationAcknowledgement(text)) return 'broadband';
  if (
    answeringQualificationQuestion &&
    !hasOutsideTopic(text) &&
    !hasCoverageSignal(text) &&
    !/bredband|5g[-\s]?bredband|fiber|router|faktura|räkning|presentkort|gift card|reward|belöning/i.test(text)
  ) return 'mobile_offer';
  if (/jag vill jämföra abonnemang|jämföra abonnemang|jamfora abonnemang|jämför abonnemang|jamfor abonnemang|compare subscriptions|compare mobile plans/i.test(text)) return 'mobile_offer';
  if (/^(kör|kor|kör igång|kor igang|starta|börja|borja)$/i.test(text) && /jämför|jamfor|abonnemang|mobil|erbjudande|behovsanalys/i.test(recentUserConversation)) return 'mobile_offer';
  if (conversationStyle?.style === 'skeptical') return 'dealett_trust';
  if (conversationStyle?.style === 'browsing') return 'browsing';
  if (
    conversationStyle?.style === 'reward_focused' &&
    /högsta|hogsta|mest|största|storsta|bara/i.test(text)
  ) return 'style_guided';
  if (
    conversationStyle?.style === 'comparison' &&
    !/(\d{2,4})\s*(kr|sek|kronor|spänn|spann)|kampanj|campaign|bindning|binding/i.test(text)
  ) return 'style_guided';
  if (conversationStyle?.style === 'confused') return 'style_guided';
  if (
    conversationStyle?.style === 'complaint_or_problem' &&
    !/(\d{2,4})\s*(kr|sek|kronor|spänn|spann)|kampanj|campaign|bindning|binding/i.test(text)
  ) return 'style_guided';
  if (
    ['direct_answer', 'impatient', 'human_test'].includes(conversationStyle?.style) &&
    !/(\d{2,4})\s*(kr|sek|kronor|spänn|spann)|obegränsad|obegransad|unlimited|kampanj|campaign|bindning|binding/i.test(text)
  ) return 'style_guided';
  const softGuidanceType = getSoftGuidanceType(text);
  if (
    softGuidanceType &&
    !(softGuidanceType === 'approximate_price' && (Number(qualification.peopleCount) > 1 || /totalt|sammanlagt|tillsammans|familj|family/i.test(text)))
  ) return 'soft_guidance';
  if (/vet inte vad jag har|vet inte operatör|vet inte operator|vet inte pris|ingen aning.*pris|bara säg vad som är bäst|bara sag vad som ar bast/i.test(text)) return 'unknown_customer';
  if (/jobbet betalar|arbetsgivare|employer.*pay|work pays|company pays/i.test(text)) return 'mobile_offer';
  if (hasCheapestOnlyIntent(text) && !hasMobileConversationContext(fullUserContext, qualification)) return 'cheapest_start';
  if (
    offerContextActive &&
    /vill inte|tänker inte|tanker inte|orkar inte|gissa|sluta.*frågor|dumma frågor|bara priset|slå|beat|operatör|operator|pris|price|betalar|pay|bindning|binding|surf|data|gb|kan ni|can you|säg bara|sag bara/i.test(text)
  ) return 'mobile_offer';
  if (numberOnlyPattern.test(text) && !hasQualification) return 'clarify_number';
  if (hasOutsideTopic(text) && !hasDealettTopic(text)) return 'outside_scope';
  if (/täckning|coverage|nät|map|karta|garantera.*funkar|funkar.*lägenhet|fungerar.*lägenhet/i.test(text)) return 'coverage';
  if (coverageContextActive && /works|work|funkar|fungerar|täckning|coverage|nät|adress|address|karta|map|område|area|bor|live/i.test(text)) return 'coverage';
  if (hasBindingSignal(text) && !salesClaimSignal && !offerContextActive && !answeringQualificationQuestion && !hasStrongOfferIntent(text)) return 'support';
  if (supportContextActive && hasStrongOfferIntent(text)) return 'mobile_offer';
  if (hasStrongOfferIntent(text) && hasMobileConversationContext(fullUserContext, qualification)) return 'mobile_offer';
  if (
    hasQualification &&
    /telia|tele2|telenor|tre|halebop|operatör|operator|no contract|ingen bindningstid|månader kvar|months? left|social|stream|wifi|surf|kr|sek|kronor|spänn|spann|billigare|bättre|slå|byta|hitta billigare|cheaper|better|beat|switch/i.test(text)
  ) return 'mobile_offer';
  if (
    hasQualification &&
    /förklara|rekommendation|kalkyl|varför|bättre|explain|recommendation|calculation|why|details|worth/i.test(text)
  ) return 'mobile_offer';
  if (coverageContextActive && /tre|telia|tele2|telenor|halebop/i.test(text)) return 'coverage';
  if (isReluctantMessage(text)) return 'not_interested';
  if (isBrowsingMessage(text) && !hasStrongOfferIntent(text)) return 'browsing';
  if (/behovsanalys/i.test(text) && !/abonnemang|mobil|telefon|bredband|5g/i.test(text)) return 'offer_discovery';
  if (/jämför erbjudanden|nytt erbjudande|new offer|compare offers/i.test(text)) return 'offer_discovery';
  if (hasPersonalDataInChat(text)) return 'checkout';
  if (checkoutContextActive && /inget erbjudande|inte valt|vad gör jag först|no offer|not selected|what do i do first/i.test(text)) return 'checkout';
  if (hasStrongOfferIntent(text) && /abonnemang|mobil|telefon|subscription|phone plan|mobile plan/i.test(text)) return 'mobile_offer';
  if (hasStrongOfferIntent(text)) return 'cheapest_start';
  if (supportContextActive && /redan kund|befintlig kund|ungefär|datum|när|var ska|vart ska|kolla|hittar|already customer|existing customer|roughly|approximately|date|when|where should|where can|check|find/i.test(text)) return 'support';
  if (/faktura|räkning|betalning|förfall|invoice|\bbill\b|payment|due|mitt abonnemang|min bindningstid|hur länge|subscription length|my subscription|contract length|avtal|kundservice|support|mina sidor|konto|account|logga in|login|ändra|uppgradera|säga upp|cancel|befintlig kund|redan kund|existing customer|already customer|current customer/i.test(text)) return 'support';
  if (/signera|signering|köp|köpa|beställ|beställa|lägg.*varukorg|varukorg|flytta.*nummer|nummerflytt|startdatum|checkout|cart|purchase|buy|sign/i.test(text)) return 'checkout';
  if (/presentkort|gift card|reward|belöning/i.test(text)) return 'gift_card';
  if (/bredband|5g[-\s]?bredband|fiber|router|adress|broadband|tv-kanal|tv kanal/i.test(text)) return 'broadband';
  if (pagePath.includes('5g-bredband') && !isLowInformationAcknowledgement(text) && !isGreetingOnly(text)) return 'broadband';
  if (
    /familj|familje|mamma|pappa|\bfru\b|\bmake\b|partner|flera|båda|family|wife|husband/i.test(text) &&
    (/abonnemang|mobil|telefon|operatör|operator|telia|tele2|telenor|tre|halebop|byta|erbjudande|behöver|vill|plan|subscription|offer|switch|need|want|vi är|we are/i.test(text) || hasQualification)
  ) return 'family_offer';
  if (/mobil|abonnemang|telefon|surf|sms|samtal|operatör|operator|telia|tele2|telenor|tre|halebop|billigare|unlimited|obegränsad|kr|sek|pris|betalar|cheaper|mobile plan|phone plan|cell plan|data plan|subscription/i.test(text)) return 'mobile_offer';

  const unrelatedCount = [
    ...trimMessages(messages).filter((item) => item.role === 'user').map((item) => item.content),
    message,
  ].filter((item) => !hasDealettTopic(item) && !hasOutsideTopic(item) && !isGreetingOnly(item)).length;
  return unrelatedCount >= 5 ? 'unclear_direct' : 'unclear';
};

const defaultSuggestions = ({ intent, qualification, offerCalculation, cart, language }) => {
  const isEnglish = language === 'en';
  if (intent === 'greeting' || intent === 'unclear' || intent === 'unclear_direct' || intent === 'unknown_customer' || intent === 'outside_scope' || intent === 'browsing' || intent === 'not_interested') {
    return isEnglish
      ? ['New offer', 'Existing customer', 'My cart', '5G broadband']
      : ['Nytt erbjudande', 'Befintlig kund', 'Min varukorg', '5G-bredband'];
  }
  if (intent === 'offer_discovery') {
    return isEnglish
      ? ['Mobile plan', 'Family plan', '5G broadband', 'Coverage']
      : ['Mobilabonnemang', 'Familjabonnemang', '5G-bredband', 'Täckning'];
  }
  if (intent === 'support') {
    return isEnglish
      ? [{ label: 'Open account', action: 'openAccount' }, { label: 'Open cart', action: 'openCart' }, 'Billing question', 'New offer']
      : [{ label: 'Öppna Mina sidor', action: 'openAccount' }, { label: 'Öppna varukorg', action: 'openCart' }, 'Fakturafråga', 'Nytt erbjudande'];
  }
  if (intent === 'checkout') {
    return cart?.length
      ? [{ label: isEnglish ? 'Open cart' : 'Öppna varukorg', action: 'openCart' }]
      : (isEnglish ? ['New offer', '5G broadband'] : ['Nytt erbjudande', '5G-bredband']);
  }
  if (intent === 'broadband') {
    return [
      { label: isEnglish ? 'Enter address' : 'Skriv adress', action: 'openBroadbandAddress' },
      { label: isEnglish ? 'Open coverage map' : 'Öppna täckningskarta', action: 'openCoverageMap' },
      { label: isEnglish ? 'Show offers' : 'Visa erbjudanden', action: 'openBroadbandPage' },
    ];
  }
  if (intent === 'coverage') {
    return [
      { label: isEnglish ? 'Open coverage map' : 'Öppna täckningskarta', action: 'openCoverageMap' },
      'Telia',
      'Tele2',
      'Telenor',
    ];
  }
  if (intent === 'gift_card') return isEnglish ? ['Mobile plan', 'Family plan', '5G broadband'] : ['Mobilabonnemang', 'Familjepaket', '5G-bredband'];
  if (offerCalculation?.validOfferAvailable) {
    return isEnglish
      ? ['Explain calculation', 'Gift cards', { label: 'Open cart', action: 'openCart' }]
      : ['Förklara kalkylen', 'Presentkort', { label: 'Öppna varukorg', action: 'openCart' }];
  }
  if (qualification?.missingFields?.includes('peopleCount')) {
    return ['1', '2', '3', '4'].map((label) => ({
      label: isEnglish ? `${label} subscription${label === '1' ? '' : 's'}` : `${label} abonnemang`,
      qualificationPatch: { peopleCount: Number(label) },
    }));
  }
  if (qualification?.missingFields?.includes('operators')) return ALLOWED_OPERATORS;
  if (qualification?.missingFields?.includes('bindingEnds')) return isEnglish ? ['No contract', '1 month left', '3 months left', '6 months left'] : ['Ingen bindningstid', '1 månad kvar', '3 månader kvar', '6 månader kvar'];
  if (qualification?.missingFields?.includes('mobileUsage')) {
    return isEnglish
      ? [
        { label: 'Mostly Wi-Fi', qualificationPatch: { mobileUsage: 'low' } },
        { label: 'Streaming & video', qualificationPatch: { mobileUsage: 'medium' } },
        { label: 'Maximum data', qualificationPatch: { mobileUsage: 'high' } },
      ]
      : [
        { label: 'Mest wifi & sociala medier', qualificationPatch: { mobileUsage: 'low' } },
        { label: 'Streaming & video', qualificationPatch: { mobileUsage: 'medium' } },
        { label: 'Max surf', qualificationPatch: { mobileUsage: 'high' } },
      ];
  }
  if (qualification?.missingFields?.includes('priceRange')) return isEnglish ? ['Under 300 SEK', '300-400 SEK', '400-500+ SEK'] : ['Under 300 kr', '300-400 kr', '400-500+ kr'];
  return isEnglish ? ['New offer', 'Existing customer', '5G broadband'] : ['Nytt erbjudande', 'Befintlig kund', '5G-bredband'];
};

const buildToolResult = ({ intent, qualification, cart = [] }) => {
  if (['mobile_offer', 'family_offer'].includes(intent)) {
    if (!qualification.readyForOffer) {
      return {
        type: 'qualification',
        status: 'missing_info',
        missingFields: qualification.missingFields,
        nextField: qualification.missingFields[0],
      };
    }

    const offerCalculation = calculateOfferOptions(qualification);
    return {
      type: 'offer_calculator',
      status: offerCalculation.validOfferAvailable ? 'valid_offer' : 'no_valid_offer',
      offerCalculation,
      rule: 'Code decided offer validity. GPT may only explain this result.',
    };
  }

  if (intent === 'checkout') {
    return {
      type: 'cart',
      status: Array.isArray(cart) && cart.length ? 'cart_has_items' : 'cart_empty',
      cart,
      boundary: 'Phone numbers, personal data, start date and signing are handled in varukorg.html, not in chat.',
    };
  }

  if (intent === 'support') {
    const item = Array.isArray(cart) && cart.length ? cart[0] : null;
    return {
      type: 'customer_service',
      status: 'account_data_limited',
      selectedCartItem: item
        ? {
          operator: item.operator,
          title: item.title || item.data,
          price: item.price,
          rewardTotal: item.rewardTotal,
        }
        : null,
      cart,
      boundary: 'Exact invoice dates and active account facts require Mina sidor or support. Do not invent them.',
    };
  }

  if (intent === 'broadband') {
    return {
      type: 'broadband',
      status: 'address_or_map_required',
      offers: getBroadbandPlans().slice(0, 6).map((plan) => ({
        operator: plan.operator,
        title: plan.title,
        speed: plan.speed,
        price: plan.price,
        bindingMonths: 24,
      })),
      boundary: 'Do not promise exact availability before address/map check.',
    };
  }

  if (intent === 'coverage') {
    return {
      type: 'coverage',
      status: 'map_required',
      message: 'Coverage varies by area and should be checked on the map.',
    };
  }

  if (intent === 'gift_card') {
    return {
      type: 'gift_card',
      status: cart?.length ? 'cart_reward_context' : 'general_reward_context',
      cart,
      giftCards: ['Apollo', 'H&M', 'Hotel', 'ICA Maxi', 'Mio', 'Zalando', 'Elgiganten', 'Ticketmaster'],
    };
  }

  return {
    type: intent,
    status: intent === 'outside_scope' ? 'outside_dealett_scope' : 'needs_intent',
  };
};

const summarizeCartItem = (item) => {
  if (!item) return null;
  const title = [item.operator, item.title || item.data].filter(Boolean).join(' ').trim() || 'valt erbjudande';
  const price = Number(item.price) > 0 ? `${Number(item.price)} kr/mån` : null;
  const reward = Number(item.rewardTotal) > 0 ? `${Number(item.rewardTotal)} kr presentkort` : null;
  return [title, price, reward].filter(Boolean).join(', ');
};

const wantsExplanation = (message) => /varför|förklara|kalkyl|bättre|värt|värd|räkna|snackar|details|explain|why|worth|calculation/i
  .test(String(message || ''));

const wantsToProceed = (message) => /gå vidare|beställ|beställa|köpa|köp|checkout|varukorg|proceed|continue|order|buy|cart/i
  .test(String(message || ''));

const asksForException = (message) => /ändå|ändå samla|göra ändå|finns det något|kan vi ändå|can.*anyway|anything.*do/i
  .test(String(message || ''));

const buildBrowsingReply = ({ isEnglish, message }) => {
  const text = String(message || '').toLowerCase();
  if (/reklam|ad|advert/i.test(text)) {
    return isEnglish
      ? 'Welcome. The interesting part is not that we sell another plan, but that we can check whether your current deal can be beaten after price, binding time and gift card. You can browse first; I only start a comparison when you ask for one.'
      : 'Välkommen. Det intressanta är inte att vi bara säljer ett nytt abonnemang, utan att vi kan kontrollera om ditt nuvarande avtal faktiskt går att slå efter pris, bindningstid och presentkort. Kolla runt först; jag börjar jämföra först när du ber om det.';
  }
  if (/har ni|något intressant|nåt intressant|interesting/i.test(text)) {
    return isEnglish
      ? 'Yes, potentially: mobile plans, family bundles, 5G broadband, coverage help and gift-card offers. But it is only interesting if it improves your current situation. Want a quick overview, or do you just want to browse?'
      : 'Ja, potentiellt: mobilabonnemang, familjepaket, 5G-bredband, täckningshjälp och presentkortserbjudanden. Men det är bara intressant om det förbättrar det du har idag. Vill du ha en snabb överblick, eller vill du bara kika runt?';
  }
  return isEnglish
    ? 'Browse in peace. Dealett is useful when you want to see if your current mobile plan, family subscriptions or 5G broadband can become cheaper or fit better. I can explain offers first, and only compare when you want me to.'
    : 'Kika runt i lugn och ro. Dealett är mest användbart när du vill se om ditt nuvarande abonnemang, familjens abonnemang eller 5G-bredband kan bli billigare eller passa bättre. Jag kan förklara erbjudanden först och jämföra först när du vill.';
};

const buildNotInterestedReply = ({ isEnglish, message }) => {
  const text = String(message || '').toLowerCase();
  if (/varför|varfor|why/i.test(text)) {
    return isEnglish
      ? 'You should not switch unless it is clearly better. The point is to compare your current cost, binding time and needs against Dealett offers. If the math is not better, the right answer is to keep what you have.'
      : 'Du ska inte byta om det inte tydligt blir bättre. Poängen är att jämföra din nuvarande kostnad, bindningstid och behov mot Dealetts erbjudanden. Om kalkylen inte blir bättre är rätt svar att behålla det du har.';
  }
  if (/redan|already/i.test(text)) {
    return isEnglish
      ? 'Exactly, most customers already have a plan. Dealett is for checking whether that plan is still worth keeping, especially for families, high prices, poor coverage, more data or 5G broadband.'
      : 'Precis, de flesta har redan abonnemang. Dealett är till för att kontrollera om det fortfarande är värt att behålla, särskilt för familjer, höga priser, dålig täckning, mer surf eller 5G-bredband.';
  }
  if (/vill inte|not interested|don't want|do not want/i.test(text)) {
    return isEnglish
      ? 'No problem. I will not push you into an offer. I can just answer questions about Dealett, gift cards, coverage, broadband or how the comparison works.'
      : 'Inga problem. Jag ska inte pressa dig till ett erbjudande. Jag kan bara svara på frågor om Dealett, presentkort, täckning, bredband eller hur jämförelsen fungerar.';
  }
  return isEnglish
    ? 'That is completely fine. Dealett is only worth using if we can show a better fit, lower total cost, better data, coverage, broadband or gift-card value.'
    : 'Det är helt okej. Dealett är bara värt det om vi kan visa bättre passform, lägre totalkostnad, bättre surf, täckning, bredband eller presentkortsvärde.';
};

const buildMissingInfoReply = ({ nextField, isEnglish, message, qualification }) => {
  const text = String(message || '').toLowerCase();
  const labels = {
    peopleCount: isEnglish ? 'Is it just for you, or several subscriptions?' : 'Är det bara till dig, eller gäller det flera abonnemang?',
    operators: isEnglish ? 'Which operator do you use today?' : 'Vilken operatör har du idag?',
    bindingEnds: isEnglish ? 'Do you have contract time left, or no binding?' : 'Har du bindningstid kvar, eller ingen?',
    mobileUsage: isEnglish ? 'How do you mostly use mobile data?' : 'Hur använder du mobilen mest?',
    priceRange: isEnglish ? 'What do you pay roughly per month today?' : 'Vad betalar du ungefär per månad idag?',
  };

  if (nextField === 'peopleCount' && /bara.*pris|prisbild|få pris|fa pris|se pris|price/i.test(text)) {
    return isEnglish
      ? 'Absolutely, we can keep it to price. Is the price for just you or for several subscriptions?'
      : 'Absolut. Är priset bara för dig, eller gäller det flera abonnemang?';
  }

  if (/vill inte|tänker inte|tanker inte|du får gissa|du far gissa|gissa|orkar inte|sluta.*frågor|dumma frågor|don't ask|dont ask/i.test(text)) {
    return isEnglish
      ? `For a fair comparison I need real facts, because a guess can produce a bad recommendation. ${labels[nextField]}`
      : `Jag kan ge en snabb riktning, men för ett riktigt pris behöver jag lite grundinfo. ${labels[nextField]}`;
  }

  if (nextField === 'peopleCount' && Number(qualification?.familyTotalPrice) > 0 && !Number(qualification?.peopleCount)) {
    return isEnglish
      ? 'To use a household total fairly, I first need to know how many subscriptions it covers.'
      : 'För att räkna på ett totalpris hemma behöver jag först veta hur många abonnemang det gäller.';
  }

  if (hasBindingSignal(text) || qualification?.bindingEnds?.some((value) => /vet/i.test(String(value || '')))) {
    if (nextField === 'bindingEnds') {
      return isEnglish
        ? 'Switching may not be worth it before the binding period ends. When does the contract end, or how many months are left?'
        : 'Byte kan bli ovärt innan bindningstiden är slut. När går bindningstiden ut, eller hur många månader är kvar?';
    }
    if (nextField === 'peopleCount') {
      return isEnglish
        ? 'The binding period matters because overlap cost can remove the saving. Is it one subscription or several?'
        : 'Bindningstiden är viktig eftersom dubbelkostnad kan äta upp vinsten. Gäller det ett abonnemang eller flera?';
    }
  }

  if (Number(qualification?.familyTotalPrice) > 0 && Number(qualification?.peopleCount) > 1) {
    const perPerson = Math.round(Number(qualification.familyTotalPrice) / Number(qualification.peopleCount));
    if (nextField === 'bindingEnds') {
      return isEnglish
        ? `${qualification.familyTotalPrice} SEK total is about ${perPerson} SEK per subscription, so it may already be a strong family deal. I need the remaining contract time before I compare.`
        : `${qualification.familyTotalPrice} kr totalt är cirka ${perPerson} kr per abonnemang, så det kan redan vara ett starkt familjeavtal. Jag behöver bindningstiden innan jag jämför.`;
    }
    if (nextField === 'mobileUsage') {
      return isEnglish
        ? `${qualification.familyTotalPrice} SEK total is about ${perPerson} SEK per subscription. To know if Dealett can beat it, how much data do you need?`
        : `${qualification.familyTotalPrice} kr totalt är cirka ${perPerson} kr per abonnemang. För att veta om Dealett kan slå det behöver jag veta hur mycket surf ni behöver.`;
    }
  }

  if (qualification?.customerSegment === 'student') {
    return isEnglish
      ? `Student pricing can change the comparison, so I will compare carefully. ${labels[nextField]}`
      : `Studentpris kan påverka jämförelsen, så jag jämför försiktigt. ${labels[nextField]}`;
  }

  if (qualification?.customerSegment === 'senior') {
    return isEnglish
      ? `Senior pricing can be a strong deal, so I will compare carefully. ${labels[nextField]}`
      : `Seniorpris kan vara ett starkt avtal, så jag jämför försiktigt. ${labels[nextField]}`;
  }

  if (qualification?.customerSegment === 'business') {
    return isEnglish
      ? `Employer-paid plans can be exception deals, so I need to compare your real out-of-pocket cost and actual terms. ${labels[nextField]}`
      : `När arbetsgivare betalar kan priset vara ett undantag, så jag behöver jämföra din riktiga egenkostnad och faktiska villkor. ${labels[nextField]}`;
  }

  if (nextField === 'peopleCount') {
    if (/^(flera|fler|flera abonnemang|several|multiple)$/i.test(text)) {
      return isEnglish
        ? 'Sure. Roughly how many subscriptions are we talking about?'
        : 'Absolut. Hur många abonnemang gäller det ungefär?';
    }
    if (/vet inte|not sure|don't know|dont know/i.test(text)) {
      return isEnglish
        ? 'No stress. Let us start simple: is it one subscription or several?'
        : 'Ingen fara. Är det bara till dig, eller flera abonnemang?';
    }
    if (/kanske mobil|maybe mobile/i.test(text)) {
      return isEnglish
        ? 'Then we can compare mobile plans. Is it just for you, or do you need several subscriptions?'
        : 'Då tar vi mobilabonnemang. Är det bara till dig, eller flera abonnemang?';
    }
    if (/vad är bäst|what.*best/i.test(text)) {
      return isEnglish
        ? 'The best option depends on how many subscriptions we compare. Is it 1, 2, 3 or more?'
        : 'Då börjar vi enkelt: är det 1, 2, 3 eller fler abonnemang?';
    }
  }

  if (
    nextField === 'operators' &&
    Number(qualification?.peopleCount) > 1 &&
    /min fru|son|dotter|mamma|pappa|wife|husband|daughter/i.test(text)
  ) {
    return isEnglish
      ? 'Got it. Now I need the current operator for each subscription.'
      : 'Jag förstår. Nu behöver jag nuvarande operatör för varje abonnemang.';
  }

  if (nextField === 'operators' && /^(starta|börja|borja|ok|okej|ja)$/i.test(text)) {
    return isEnglish
      ? 'We are started. First I need the current operator for the subscription or subscriptions, for example Telia, Tele2, Telenor, Tre or Halebop.'
      : 'Vi är igång. Först behöver jag nuvarande operatör för abonnemanget eller abonnemangen, till exempel Telia, Tele2, Telenor, Tre eller Halebop.';
  }

  if (nextField === 'operators' && Number(qualification?.peopleCount) === 1 && /^(mobil|mobilabonnemang|mobile|mobile plan)$/i.test(text)) {
    return isEnglish
      ? 'Yes, mobile subscription. Which operator do you use today: Telia, Tele2, Telenor, Tre or Halebop?'
      : 'Ja, mobilabonnemang. Vilken operatör har du idag: Telia, Tele2, Telenor, Tre eller Halebop?';
  }

  if (nextField === 'operators' && Number(qualification?.peopleCount) === 1 && /^(1 abonnemang|bara mig|bara jag|mig|jag|just me|only me|me)$/i.test(text)) {
    return isEnglish
      ? 'Great, one subscription. Which operator do you use today: Telia, Tele2, Telenor, Tre or Halebop?'
      : 'Toppen, ett abonnemang. Vilken operatör har du idag: Telia, Tele2, Telenor, Tre eller Halebop?';
  }

  if (nextField === 'operators' && /^(nää|nä|nej|inget|vet inte|ingen aning|no|nothing|not sure)$/i.test(text)) {
    if (/inget|nothing/i.test(text)) {
      return isEnglish
        ? 'Then we skip preferences and use the current situation. Which operator do you use today: Telia, Tele2, Telenor, Tre or Halebop?'
        : 'Då struntar vi i önskemål och tar nuläget. Vilken operatör har ni idag: Telia, Tele2, Telenor, Tre eller Halebop?';
    }
    if (/vet inte|ingen aning|not sure/i.test(text)) {
      return isEnglish
        ? 'If you are unsure, check the latest invoice or app. For the comparison I need the current operator for each subscription.'
        : 'Om du är osäker kan du kolla senaste fakturan eller appen. För jämförelsen behöver jag nuvarande operatör för varje abonnemang.';
    }
    if (Number(qualification?.peopleCount) === 1) {
      return isEnglish
        ? 'No preference is fine. I only need the operator you use today, for example Telia, Tele2, Telenor, Tre or Halebop.'
        : 'Du behöver inte ha någon önskad operatör. Jag behöver bara veta operatören du har idag, till exempel Telia, Tele2, Telenor, Tre eller Halebop.';
    }
    return isEnglish
      ? 'No preference is fine. I only need the operator you use today, for example Telia, Tele2, Telenor, Tre or Halebop. If all subscriptions use the same one, write "Tele2 for all".'
      : 'Du behöver inte ha någon önskad operatör. Jag behöver bara veta operatören ni har idag, till exempel Telia, Tele2, Telenor, Tre eller Halebop. Om alla har samma kan du skriva "Tele2 på alla".';
  }

  if (nextField === 'operators' && Number(qualification?.peopleCount) > 1 && !qualification?.operators?.length) {
    return isEnglish
      ? 'Which operator does each subscription use today? You can write them one by one, or say for example "Tele2 for all".'
      : 'Vilka operatörer har ni idag? Du kan skriva en i taget, eller till exempel "Tele2 på alla".';
  }

  if (nextField === 'operators' && Number(qualification?.peopleCount) > 1 && qualification?.operators?.length) {
    const left = Number(qualification.peopleCount) - qualification.operators.length;
    return isEnglish
      ? `I have ${qualification.operators.join(', ')} so far. Which operator do the other ${left} subscription${left === 1 ? '' : 's'} use? If all use the same operator, write "same for all".`
      : `Jag har ${qualification.operators.join(', ')} hittills. Vilken operatör har de andra ${left} abonnemang${left === 1 ? 'et' : 'en'}? Om alla har samma kan du skriva "samma för alla".`;
  }

  if (nextField === 'bindingEnds' && Number(qualification?.peopleCount) > 1 && !qualification?.bindingEnds?.length) {
    if (/samma.*alla|same.*all/i.test(text)) {
      return isEnglish
        ? 'Same for all works, but I still need the number of months. For example: "3 months for all" or "no contract for all".'
        : 'Samma för alla funkar, men jag behöver antal månader. Till exempel: "3 månader på alla" eller "ingen bindningstid på alla".';
    }
    return isEnglish
      ? 'How much contract time is left on each subscription? You can answer one by one, or say for example "3 months for all".'
      : 'Hur lång bindningstid har varje abonnemang kvar? Du kan svara en i taget, eller till exempel "3 månader på alla".';
  }

  if (nextField === 'bindingEnds' && Number(qualification?.peopleCount) > 1 && qualification?.bindingEnds?.length) {
    const left = Number(qualification.peopleCount) - qualification.bindingEnds.length;
    const bindingList = qualification.bindingEnds.map((value) => formatBindingValue(value, isEnglish)).join(', ');
    return isEnglish
      ? `I have ${bindingList} so far. How much contract time is left for the other ${left} subscription${left === 1 ? '' : 's'}? You can answer like "2 months", "no contract", or "same for all".`
      : `Jag har ${bindingList} hittills. Hur lång bindningstid har de andra ${left} abonnemang${left === 1 ? 'et' : 'en'}? Du kan svara till exempel "2 månader", "ingen bindningstid" eller "samma för alla".`;
  }

  if (nextField === 'mobileUsage' && /^(nää|nä|nej|inget|vet inte|ingen aning|no|nothing|not sure)$/i.test(text)) {
    return isEnglish
      ? 'No worries. Pick the closest one: mostly Wi-Fi/social media, streaming/video, or maximum data?'
      : 'Ingen fara. Välj det som ligger närmast: mest wifi/sociala medier, streaming/video eller max surf?';
  }

  if (nextField === 'mobileUsage' && /^(månader|mån|months?)$/i.test(text)) {
    return isEnglish
      ? 'Got it, the contract time is noted. Next I need the usage level: mostly Wi-Fi/social media, streaming/video, or maximum data?'
      : 'Jag har noterat bindningstiden. Nästa steg är användningen: mest wifi/sociala medier, streaming/video eller max surf?';
  }

  if (nextField === 'bindingEnds' && /^(nää|nä|nej|inget|vet inte|ingen aning|no|nothing|not sure)$/i.test(text)) {
    return isEnglish
      ? 'If you do not know the exact contract time, say "do not know". For an exact offer later, we need the real remaining months.'
      : 'Om du inte vet exakt kan du skriva "vet inte". För ett exakt erbjudande senare behöver vi riktiga kvarvarande månader.';
  }

  if (nextField === 'priceRange' && /^(nää|nä|nej|inget|vet inte|ingen aning|no|nothing|not sure)$/i.test(text)) {
    return isEnglish
      ? 'No problem. A rough current price is enough to start: under 300, 300-400, or 400-500+ SEK per subscription?'
      : 'Ingen fara. Ett ungefärligt pris räcker för att börja: under 300, 300-400 eller 400-500+ kr per abonnemang?';
  }

  return labels[nextField] || (isEnglish ? 'I need one more detail to compare.' : 'Jag behöver en uppgift till för att jämföra.');
};

const buildMarketIntelligenceReply = ({ toolResult, isEnglish }) => {
  const classification = toolResult?.marketClassification || {};
  const marketClaim = toolResult?.marketClaim || {};
  const hasPositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const firstQuestion = Array.isArray(classification.nextQuestions) && classification.nextQuestions.length
    ? classification.nextQuestions[0]
    : 'Är priset ett kampanjpris, familjepris, rabatt, arbetsgivarbetalt eller winback-erbjudande?';
  const bindingNote = marketClaim.hasBindingContext
    ? (isEnglish
      ? ' The remaining contract time also matters, because switching before it ends can remove the saving.'
      : ' Bindningstiden spelar också roll, eftersom byte innan den är slut kan äta upp vinsten.')
    : '';

  if (classification.status === 'possible_needs_clarification') {
    if (marketClaim.isCampaignPrice) {
      const campaignQuestion = !hasPositive(marketClaim.campaignMonths)
        ? (isEnglish ? 'How many months is the campaign price valid?' : 'Hur många månader gäller kampanjpriset?')
        : (isEnglish ? 'What is the price after the campaign?' : 'Vad blir priset efter kampanjen?');
      return isEnglish
        ? `That may be a strong campaign deal, but I need one detail before comparing fairly.${bindingNote} ${campaignQuestion}`
        : `${classification.recommendedResponse || 'Det kan vara ett starkt kampanjpris, men jag behöver en uppgift till innan jag jämför.'}${bindingNote} ${campaignQuestion}`;
    }
    return isEnglish
      ? `That may be a strong deal, but I need one detail before comparing fairly.${bindingNote} Is it a campaign, family/shared plan, student/senior/youth discount, employer-paid plan or winback offer?`
      : `${classification.recommendedResponse || 'Det kan vara möjligt, men jag behöver ett förtydligande innan jag jämför.'}${bindingNote} ${firstQuestion}`;
  }

  if (classification.status === 'suspicious_low') {
    return isEnglish
      ? `That is unusually low compared with normal market levels. I am not saying it is wrong, but before recommending anything I need to know if it is a campaign, family/shared price, discount, employer-paid plan or winback offer.${bindingNote}`
      : `Det är ovanligt lågt jämfört med normal marknadsnivå. Jag säger inte att det är fel, men innan jag rekommenderar något behöver jag veta om det är kampanj, familjepris, rabatt, arbetsgivare eller winback.${bindingNote}`;
  }

  if (classification.status === 'probably_not_sellable') {
    return isEnglish
      ? `If that current deal is correct, it is probably already very strong. Check whether it is a campaign, family/shared price, student/senior discount, employer-paid plan or winback offer. It may actually be better to keep it for now.${bindingNote}`
      : `Om det nuvarande avtalet stämmer är det troligen redan väldigt starkt. Kontrollera bara om priset beror på kampanj, familjepris, student-/seniorrabatt, arbetsgivare eller winback. Då kan det faktiskt vara bättre att behålla det tills vidare.${bindingNote}`;
  }

  return isEnglish
    ? `I do not want to give a firm recommendation yet because the market comparison needs one more detail.${bindingNote} Is the price ordinary, campaign-based, discounted, shared with family, employer-paid or a winback offer?`
    : `Jag vill inte ge en fast rekommendation än eftersom marknadsjämförelsen behöver en uppgift till.${bindingNote} Är priset ordinarie, kampanj, rabatt, familjedelat, arbetsgivarbetalt eller winback?`;
};

const buildSoftGuidanceReply = ({ isEnglish, message }) => {
  const type = getSoftGuidanceType(message);
  const replies = {
    best_not_cheapest: {
      sv: 'Bästa betyder oftast täckning, stabilitet, hastighet, support eller familjevärde, inte bara lägst pris. Vilket av dem är viktigast för dig?',
      en: 'Best usually means coverage, stability, speed, support or family value, not only the lowest price. Which one matters most to you?',
    },
    no_patience: {
      sv: 'Kort svar: börja med täckning och stabilitet, sedan pris. Är det mobilabonnemang eller bredband du vill jämföra?',
      en: 'Short answer: start with coverage and stability, then price. Do you want to compare mobile or broadband?',
    },
    safe_choice: {
      sv: 'Ett säkert val är att prioritera stabil täckning, undvika onödig bindning om du är osäker och välja rimlig surf istället för max direkt. Gäller det mobil eller bredband?',
      en: 'A safe choice is to prioritize stable coverage, avoid unnecessary binding if you are unsure, and choose reasonable data instead of max data immediately. Is this for mobile or broadband?',
    },
    emotional: {
      sv: 'Jag förstår, abonnemang kan kännas frustrerande och rörigt. Vi tar ett lugnt steg utan press: gäller det mobil, bredband eller en faktura?',
      en: 'I understand, subscriptions can feel frustrating and messy. Let us take one calm step without pressure: is this about mobile, broadband or a bill?',
    },
    unknown_price: {
      sv: 'Ingen fara, ett ungefär räcker för att börja. Ligger det ungefär under 200, 200-350 eller över 350 kr per månad?',
      en: 'No problem, an approximate range is enough to start. Is it roughly under 200, 200-350 or over 350 SEK per month?',
    },
    approximate_price: {
      sv: 'Runt det priset räcker som start, men jag markerar det som ungefärligt. Vilken operatör har du idag?',
      en: 'That approximate price is enough to start, and I will treat it as an estimate. Which operator do you use today?',
    },
    unknown_data: {
      sv: 'Ingen fara, vi kan utgå från beteende istället för GB. Tar surfen slut, streamar du mycket, eller är det mest sociala medier, BankID och kartor?',
      en: 'No problem, we can use behavior instead of exact GB. Does your data run out, do you stream a lot, or is it mostly social media, BankID and maps?',
    },
    reliability_first: {
      sv: 'Då prioriterar vi täckning och stabilitet före GB. Var måste det funka bäst: hemma, på jobbet eller under pendling?',
      en: 'Then we prioritize coverage and stability before GB. Where must it work best: at home, at work or while commuting?',
    },
    child_plan: {
      sv: 'För barn är ett enkelt och billigt abonnemang med rimlig surfgräns ofta bättre än max surf. Hur gammalt är barnet ungefär?',
      en: 'For a child, a simple low-cost plan with a reasonable data limit is often better than maximum data. Roughly how old is the child?',
    },
    elder_parent: {
      sv: 'För lite BankID och samtal brukar låg surf och ett enkelt abonnemang räcka, så jag ska inte översälja obegränsad surf. Har han wifi hemma?',
      en: 'For some BankID and calls, low data and a simple plan usually works, so I should not oversell unlimited data. Does he have Wi-Fi at home?',
    },
    family_unclear: {
      sv: 'Vi förenklar det. Börja med en sak: hur många mobilanvändare är ni hemma?',
      en: 'Let us simplify it. Start with one thing: how many mobile users are at home?',
    },
    mobile_broadband_mix: {
      sv: 'Mobil och internet hemma jämförs bäst separat, även om de ibland kan paketeras. Vad är mest akut: internet hemma eller mobilabonnemang?',
      en: 'Mobile and home internet are best compared separately, even if they can sometimes be bundled. What is most urgent: home internet or mobile?',
    },
    coverage_area: {
      sv: 'I Jakobsberg/Barkarby kan täckning skilja mellan gata, hus och inomhusmiljö. Som praktisk riktning skulle jag börja med Telias nät och sedan jämföra Tele2/Telenor som alternativ. Det är ingen garanti, men ett bra första spår att kontrollera.',
      en: 'In the Jakobsberg/Barkarby area, coverage can differ by street, building and indoor environment. As practical direction, I would start with Telia’s network and then compare Tele2/Telenor as alternatives. It is not a guarantee, but it is a good first track to verify.',
    },
    coverage_indoor: {
      sv: 'Om det är dåligt hemma men funkar ute handlar det ofta om inomhustäckning, väggar eller nätet just där. Wifi-samtal kan hjälpa, men vi bör också jämföra annat nät. Vilken operatör har du idag?',
      en: 'If it is bad at home but works outside, it is often indoor coverage, walls or that network at that exact place. Wi-Fi calling can help, but we should also compare another network. Which operator do you use today?',
    },
    friend_coverage_signal: {
      sv: 'Att en kompis med Telia har bra signal hos dig är en nyttig signal, men inte en garanti eftersom telefon, SIM och inomhusläge kan skilja. Vill du prioritera Telia-nätet i jämförelsen?',
      en: 'A friend with Telia having good signal at your place is a useful signal, but not a guarantee because phone, SIM and indoor position can differ. Do you want to prioritize the Telia network in the comparison?',
    },
    old_plan: {
      sv: 'Gamla abonnemang kan vara antingen riktigt bra eller onödigt dyra, så det är värt att jämföra mjukt först. Betalar du ungefär under eller över 300 kr i månaden?',
      en: 'Old plans can be either very good or unnecessarily expensive, so it is worth doing a soft comparison first. Do you pay roughly under or over 300 SEK per month?',
    },
  };

  const selected = replies[type] || {
    sv: 'Jag kan hjälpa även med ungefärliga uppgifter. Vad är viktigast just nu: pris, täckning eller enkelhet?',
    en: 'I can help even with approximate details. What matters most right now: price, coverage or simplicity?',
  };

  return isEnglish ? selected.en : selected.sv;
};

const buildStyleGuidedReply = ({ isEnglish, message, conversationStyle }) => {
  const text = String(message || '').toLowerCase();
  const style = conversationStyle?.style || 'direct_answer';

  if (
    hasCoverageSignal(text) &&
    (hasDirectAnswerSignal(text) || hasJakobsbergAreaSignal(text) || /bäst täckning|basta tackning|bästa täckning|best coverage/i.test(text))
  ) {
    return buildDirectCoverageReply({
      isEnglish,
      message,
      messages: [],
    });
  }

  if (style === 'skeptical') {
    return isEnglish
      ? 'Yes, Dealett may earn compensation from partners if you choose an offer. But the assistant should still tell you when your current deal looks better or when switching is not worth it, otherwise the advice is not useful.'
      : 'Ja, Dealett kan få ersättning från partners om du väljer ett erbjudande. Men assistenten ska ändå säga när ditt nuvarande avtal verkar bättre eller när ett byte inte är värt det, annars är rådgivningen inte användbar.';
  }

  if (style === 'browsing') {
    return isEnglish
      ? 'Welcome. Dealett helps you see whether your current subscription can actually be beaten after price, coverage, binding time and any reward. You can just browse; I start comparing only when you want.'
      : 'Välkommen. Dealett hjälper dig se om ditt nuvarande abonnemang faktiskt går att slå efter pris, täckning, bindningstid och eventuell belöning. Du kan bara kika runt, jag börjar jämföra först när du vill.';
  }

  if (style === 'confused') {
    if (/faktura|invoice|bill/i.test(text)) {
      return isEnglish
        ? 'Invoices can be confusing. Start with the total monthly amount and how many users or services are included, then we can separate subscriptions, add-ons and one-time fees.'
        : 'Fakturor kan vara röriga. Börja med totalbeloppet per månad och hur många användare eller tjänster som ingår, så kan vi skilja abonnemang, tillval och engångskostnader.';
    }
    return isEnglish
      ? 'I am not completely sure what you mean. If you are just looking around, I can briefly explain Dealett, or you can write "mobile", "broadband" or "coverage".'
      : 'Jag är inte helt säker på vad du menar. Om du bara kikar kan jag kort förklara vad Dealett gör, eller så kan du skriva "mobil", "bredband" eller "täckning".';
  }

  if (style === 'impatient') {
    return isEnglish
      ? 'Short answer: start with coverage and stability, then price. If I must guess, a mid-sized 5G mobile plan around 20-30 GB is a safe all-round start, but not an exact recommendation. Mobile or broadband?'
      : 'Kort svar: börja med täckning och stabilitet, sedan pris. Om jag måste gissa är ett mellanstort 5G-abonnemang runt 20-30 GB en trygg allroundstart, men inte en exakt rekommendation. Mobilabonnemang eller bredband?';
  }

  if (style === 'comparison') {
    if (/täckning|tackning|coverage|telia|tele2|telenor|tre|halebop/i.test(text)) {
      if (/jakobsberg|barkarby/i.test(text)) {
        return isEnglish
          ? 'Direct answer: for the best chance of strong coverage around Jakobsberg/Barkarby, I would start by checking Telia’s network first, with Tele2/Telenor as alternatives. I cannot guarantee exact coverage at every address, especially indoors, but Telia’s network is the safest all-round starting point to verify.'
          : 'Direkt svar: för bästa chans till stark täckning i Jakobsberg/Barkarby skulle jag börja med Telias nät som förstahandsval och jämföra Tele2/Telenor som alternativ. Jag kan inte garantera exakt täckning på varje adress, särskilt inomhus, men Telias nät är det säkraste allroundvalet att börja kontrollera.';
      }
      return isEnglish
        ? 'Direct answer: if coverage matters most, I would start by checking Telia’s network first, then compare Tele2/Telenor as alternatives. It is not a guarantee, because address and indoor environment can change the result a lot.'
        : 'Direkt svar: om täckning är viktigast skulle jag börja med Telias nät först och sedan jämföra Tele2/Telenor som alternativ. Det är ingen garanti, eftersom adress och inomhusmiljö kan ändra resultatet mycket.';
    }
    return isEnglish
      ? 'A fair comparison starts with total monthly cost, data need and binding time. I can give a rough direction first, but exact recommendation needs real terms. What are you comparing: operators, price or coverage?'
      : 'En rättvis jämförelse börjar med total månadskostnad, surfbehov och bindningstid. Jag kan ge en grov riktning först, men exakt rekommendation kräver riktiga villkor. Vad jämför du: operatörer, pris eller täckning?';
  }

  if (style === 'complaint_or_problem') {
    return isEnglish
      ? 'As a first assessment, not an exact recommendation: if the current service is bad, I would not start with price. First check whether the problem is coverage, indoor signal, router/device or billing. What is the main problem: coverage, speed or cost?'
      : 'Som första bedömning, inte en exakt rekommendation: om nuvarande tjänst strular skulle jag inte börja med priset. Först kollar vi om problemet är täckning, inomhussignal, router/enhet eller faktura. Vad är huvudproblemet: täckning, hastighet eller kostnad?';
  }

  if (style === 'reward_focused') {
    return isEnglish
      ? 'I can show the highest reward, but I should not choose a subscription only by gift card. An expensive plan with a large reward can be worse in total. Do you want highest reward or best total value?'
      : 'Jag kan visa högsta belöningen, men jag bör inte välja abonnemang bara efter presentkort. Ett dyrt abonnemang med stor belöning kan bli sämre totalt. Vill du se högsta belöning eller bästa totalvärde?';
  }

  const broadbandContext = /bredband|internet hemma|router|fiber|5g[-\s]?bredband/i.test(text);
  const coverageContext = /täckning|tackning|coverage|funkar|stabil/i.test(text);
  if (broadbandContext) {
    return isEnglish
      ? 'If I must choose without more information: start with an address-checked 5G broadband option only if the coverage map looks strong at home. That is a qualified guess, not an exact recommendation. Do you want me to keep guessing or make it accurate with one detail?'
      : 'Om jag måste välja utan mer info: börja med ett adresskontrollerat 5G-bredband bara om täckningskartan ser stark ut hemma. Det är en kvalificerad gissning, inte en exakt rekommendation. Vill du att jag gissar vidare eller gör det träffsäkert med en uppgift?';
  }
  if (coverageContext) {
    return isEnglish
      ? 'If I must answer first: choose coverage and stability before price. I would start with the network that works best at home indoors, then compare price. That is a qualified guess, not a guarantee. Where must it work best?'
      : 'Om jag måste svara först: välj täckning och stabilitet före pris. Jag hade börjat med nätet som fungerar bäst hemma inomhus och sedan jämfört pris. Det är en kvalificerad gissning, inte en garanti. Var måste det funka bäst?';
  }

  return isEnglish
    ? 'If I must choose with no more information: start with a mid-sized 5G mobile plan around 20-30 GB. It is a safe all-round choice for many without being as expensive as unlimited data. This is a qualified guess, not an exact personal recommendation. Do you want me to keep guessing or make it accurate with one question?'
    : 'Om jag måste välja utan mer info: börja med ett mellanstort 5G-abonnemang runt 20-30 GB. Det är ett tryggt allroundval för många utan att bli lika dyrt som obegränsat. Det är en kvalificerad gissning, inte en exakt personlig rekommendation. Vill du att jag gissar vidare eller gör det träffsäkert med en fråga?';
};

const wantsFullCoverageMap = (message) => (
  /full\s*täckningskarta|full\s*tackningskarta|fullskärm|fullskarm|stor karta|större karta|storre karta|karta-sida|kartasida|hel karta|full map|fullscreen|large map|map page|separat karta/i
    .test(String(message || ''))
);

const buildDirectCoverageReply = ({ isEnglish, message, messages = [] }) => {
  const coverageContext = getRecentConversationText(message, messages);
  const currentMessageHasCoverageSignal = hasCoverageSignal(message);
  if (hasJakobsbergAreaSignal(coverageContext) && currentMessageHasCoverageSignal) {
    return isEnglish
      ? 'Direct answer: for the best chance of strong coverage around Jakobsberg/Barkarby, I would start by checking Telia’s network first, with Tele2/Telenor as alternatives. I cannot guarantee exact coverage at every address, especially indoors, but Telia’s network is the safest all-round starting point to verify.'
      : 'Direkt svar: för bästa chans till stark täckning i Jakobsberg/Barkarby skulle jag börja med Telias nät som förstahandsval och jämföra Tele2/Telenor som alternativ. Jag kan inte garantera exakt täckning på varje adress, särskilt inomhus, men Telias nät är det säkraste allroundvalet att börja kontrollera.';
  }

  return isEnglish
    ? 'Short answer: start with Telia’s network for the best chance of coverage, but verify the address because indoor environment can differ a lot.'
    : 'Om jag ska svara kort: börja med Telias nät för bästa chans till täckning, men kontrollera adressen eftersom inomhusmiljö kan skilja mycket.';
};

const fallbackReply = ({ intent, language, message, messages = [], qualification, toolResult, conversationStyle, appContext = {} }) => {
  const isEnglish = language === 'en';
  if (intent === 'greeting') {
    return isEnglish
      ? 'Hi! I can help you compare mobile plans, broadband, coverage and gift cards. What would you like to start with?'
      : 'Hej! Jag kan hjälpa dig jämföra mobilabonnemang, bredband, täckning och presentkort. Vad vill du börja med?';
  }
  if (intent === 'capabilities') {
    return isEnglish
      ? 'I can compare mobile plans, 5G broadband, coverage and gift-card value. I can also explain invoices or subscriptions in general, but I cannot see live account data from chat.'
      : 'Jag kan jämföra mobilabonnemang, 5G-bredband, täckning och presentkortsvärde. Jag kan också förklara faktura eller abonnemang generellt, men jag kan inte se live-data från ditt konto i chatten.';
  }
  if (intent === 'identity') {
    return isEnglish
      ? 'I am Dealett AI, not a human. I can help with telecom questions and comparisons, and I should say when I am unsure or when your current deal may be better.'
      : 'Jag är Dealett AI, inte en människa. Jag kan hjälpa med telekomfrågor och jämförelser, och jag ska säga till när jag är osäker eller när ditt nuvarande avtal kan vara bättre.';
  }
  if (intent === 'small_talk') {
    return isEnglish
      ? 'I do not have personal hobbies, but I can keep it light. My job here is mainly to help you with mobile plans, broadband, coverage and gift-card value.'
      : 'Jag har inga egna hobbyer, men jag kan hålla tonen lätt. Min uppgift här är främst att hjälpa dig med mobilabonnemang, bredband, täckning och presentkortsvärde.';
  }
  if (intent === 'outside_scope') {
    return isEnglish
      ? 'I can only help with Dealett topics like mobile plans, 5G broadband, coverage, gift cards, cart and customer service. What do you need help with at Dealett?'
      : 'Jag kan bara hjälpa med Dealett-frågor som mobilabonnemang, 5G-bredband, täckning, presentkort, varukorg och kundservice. Vad behöver du hjälp med hos Dealett?';
  }
  if (intent === 'dealett_trust') {
    return isEnglish
      ? 'Dealett may earn compensation from partners if you buy through us. The AI should still act on your side: if your current deal looks better, unusually strong, or not worth switching from, I should say that instead of forcing a switch.'
      : 'Dealett kan få ersättning från partners om du köper via oss. AI:n ska ändå stå på kundens sida: om ditt nuvarande avtal verkar bättre, ovanligt starkt eller inte värt att byta från ska jag säga det istället för att pressa fram ett byte.';
  }
  if (intent === 'fake_condition') {
    return isEnglish
      ? 'I cannot pretend or calculate from fake conditions. Dealett can only compare using the actual operator terms, price, data need and remaining contract time.'
      : 'Jag kan inte låtsas eller räkna på fejkade villkor. Dealett kan bara jämföra med riktiga operatörsvillkor, pris, surfbehov och faktisk bindningstid.';
  }
  const mockOperatorSupportReply = buildMockOperatorSupportReply({
    message,
    messages,
    language,
    appContext,
    intent,
  });
  if (mockOperatorSupportReply) return mockOperatorSupportReply;
  if (intent === 'style_guided') {
    return buildStyleGuidedReply({ isEnglish, message, conversationStyle });
  }
  if (intent === 'soft_guidance') {
    return buildSoftGuidanceReply({ isEnglish, message });
  }
  if (intent === 'cheapest_start') {
    return isEnglish
      ? 'Do you want to compare a mobile subscription or broadband?'
      : 'Är det mobilabonnemang eller bredband du vill jämföra?';
  }
  if (intent === 'unknown_customer') {
    return isEnglish
      ? 'No problem. For an exact recommendation I need real facts, but we can start small. Do you want to compare a mobile subscription or broadband?'
      : 'Ingen fara. För en exakt rekommendation behöver jag riktiga uppgifter, men vi kan börja enkelt. Är det mobilabonnemang eller bredband du vill jämföra?';
  }
  if (intent === 'offer_discovery') {
    return isEnglish
      ? 'Do you want to compare a mobile subscription, a family bundle, or 5G broadband?'
      : 'Vill du jämföra mobilabonnemang, familjepaket eller 5G-bredband?';
  }
  if (intent === 'browsing') {
    return buildBrowsingReply({ isEnglish, message });
  }
  if (intent === 'not_interested') {
    return buildNotInterestedReply({ isEnglish, message });
  }
  if (intent === 'clarify_number') {
    return isEnglish
      ? `Do you mean ${String(message).trim()} subscriptions? If you want, I can compare them, but I will not start the offer flow until you say you want a comparison.`
      : `Menar du ${String(message).trim()} abonnemang? Om du vill kan jag jämföra dem, men jag startar inte erbjudandeflödet förrän du säger att du vill jämföra.`;
  }
  if (intent === 'unclear_direct') {
    return isEnglish
      ? 'I am happy to keep it friendly, but to help properly I need to know what you need from Dealett: offer, existing subscription, bill, coverage, broadband, or cart?'
      : 'Jag hänger med, men för att hjälpa dig på riktigt behöver jag veta vad du behöver hos Dealett: erbjudande, befintligt abonnemang, faktura, täckning, bredband eller varukorg?';
  }
  if (intent === 'unclear') {
    return isEnglish
      ? 'I am here with you. When you are ready, tell me if you want help with an offer, existing subscription, bill, coverage, broadband, or the cart.'
      : 'Jag är med dig. När du vill kan du säga om du behöver hjälp med erbjudande, befintligt abonnemang, faktura, täckning, bredband eller varukorg.';
  }
  if (toolResult?.type === 'market_intelligence') {
    return buildMarketIntelligenceReply({ toolResult, isEnglish });
  }
  if (intent === 'support') {
    const selected = toolResult?.selectedCartItem
      ? `${toolResult.selectedCartItem.operator || 'Dealett'} ${toolResult.selectedCartItem.title || 'abonnemang'}`
      : null;
    if (/fattar inte|min faktura|förstår inte.*faktura|forstar inte.*faktura|invoice.*confus/i.test(message)) {
      return isEnglish
        ? 'Invoices can be confusing. Start with the total monthly amount and how many users or services are included, then we can separate subscriptions, add-ons and one-time fees.'
        : 'Fakturor kan vara röriga. Börja med totalbeloppet per månad och hur många användare eller tjänster som ingår, så kan vi skilja abonnemang, tillval och engångskostnader.';
    }
    if (/redan kund|befintlig kund|already customer|existing customer/i.test(message)) {
      return isEnglish
        ? 'I understand. Even for existing customers, the chat is not connected to live account data, so invoice dates and contract details must be checked in My pages or support.'
        : 'Jag förstår. Även för befintliga kunder är chatten inte kopplad till live-data, så fakturadatum och avtalsdetaljer behöver kontrolleras i Mina sidor eller support.';
    }
    if (/se mitt abonnemang|se mina abonnemang|mitt abonnemang|can you see.*subscription|my subscription/i.test(message)) {
      return isEnglish
        ? 'I cannot see your active subscription from chat. My pages should show your current plan, binding time and invoices.'
        : 'Jag kan inte se ditt aktiva abonnemang från chatten. Mina sidor ska visa nuvarande abonnemang, bindningstid och fakturor.';
    }
    if (/bindningstid|löper ut|går.*ut|contract.*end|contract.*left/i.test(message)) {
      return isEnglish
        ? 'I cannot look up your exact contract end date here. Check My pages for the binding period, or contact support if it is missing.'
        : 'Jag kan inte slå upp exakt när bindningstiden går ut här. Kolla Mina sidor för bindningstid, eller kontakta support om den saknas.';
    }
    if (/ungefär|bara säga|roughly|approximately/i.test(message)) {
      return isEnglish
        ? 'I should not give even an approximate invoice date without account data. My pages is the place for the exact due date.'
        : 'Jag ska inte ge ens ett ungefärligt fakturadatum utan kontodata. Mina sidor är rätt plats för exakt förfallodatum.';
    }
    if (/datum|när kommer|vilket datum|which date/i.test(message)) {
      return isEnglish
        ? 'I do not want to guess a billing date. The safe answer is to check My pages, where the exact invoice, due date and payment status should be shown.'
        : 'Jag vill inte gissa ett fakturadatum. Det säkra är att kolla Mina sidor, där exakt faktura, förfallodatum och betalstatus ska visas.';
    }
    if (/var ska|vart ska|var.*kolla|vart.*kolla|where should|where can|where.*check/i.test(message)) {
      return isEnglish
        ? 'Check My pages first. If the invoice is missing there too, contact support so they can look up your account.'
        : 'Kolla Mina sidor först. Om fakturan saknas där också behöver supporten titta på ditt konto.';
    }
    if (selected) {
      return isEnglish
        ? `I can see ${selected} in your cart, but I do not have live account or invoice data in chat. Use My pages for exact billing or subscription details.`
        : `Jag ser ${selected} i varukorgen, men jag har inte live-data om konto eller faktura i chatten. Använd Mina sidor för exakta faktura- eller abonnemangsuppgifter.`;
    }
    return isEnglish
      ? 'I can guide you, but I do not have live account or invoice data in chat. Use My pages for exact billing or subscription details.'
      : 'Jag kan guida dig, men jag har inte live-data om konto eller faktura i chatten. Använd Mina sidor för exakta faktura- eller abonnemangsuppgifter.';
  }
  if (intent === 'checkout') {
    const summary = summarizeCartItem(toolResult?.cart?.[0]);
    const personalDataWarning = hasPersonalDataInChat(message)
      ? (isEnglish
        ? 'Do not send phone numbers or personal details in chat.'
        : 'Skicka inte telefonnummer eller personuppgifter i chatten.')
      : '';
    if (!summary && /personnummer|personal identity|identity number|ssn/i.test(message)) {
      return isEnglish
        ? 'No, do not write personal identity details in chat. First choose a valid offer; identity checks and signing belong in the secure cart flow.'
        : 'Nej, skriv inte personnummer i chatten. Välj först ett giltigt erbjudande; identitetskontroll och signering hör hemma i det säkra varukorgsflödet.';
    }
    if (!summary && /telefonnummer|phone number|mitt nummer|my number|\b07\d/i.test(message)) {
      return isEnglish
        ? 'Do not send your phone number here. Start with a valid offer first, then number transfer is handled in the cart.'
        : 'Skicka inte telefonnummer här. Börja med ett giltigt erbjudande först, sedan hanteras nummerflytt i varukorgen.';
    }
    if (!summary && /inget erbjudande|inte valt|no offer|not selected/i.test(message)) {
      return isEnglish
        ? 'Then the first step is comparison, not checkout. Tell me if it is for mobile subscriptions, a family bundle or 5G broadband, and I will collect the needed details.'
        : 'Då är första steget jämförelse, inte köp. Säg om det gäller mobilabonnemang, familjepaket eller 5G-bredband så samlar jag rätt uppgifter.';
    }
    if (!summary && /vad gör jag först|what do i do first/i.test(message)) {
      return isEnglish
        ? 'Start by choosing what we should compare: mobile plan, family bundle or 5G broadband. When a valid offer exists, the cart handles the purchase.'
        : 'Börja med att välja vad vi ska jämföra: mobilabonnemang, familjepaket eller 5G-bredband. När ett giltigt erbjudande finns tar varukorgen köpet.';
    }
    if (summary) {
      return isEnglish
        ? [personalDataWarning, `Your cart contains: ${summary}. Continue in the cart for number transfer, start date and signing.`].filter(Boolean).join(' ')
        : [personalDataWarning, `I varukorgen finns: ${summary}. Fortsätt där för nummerflytt, startdatum och signering.`].filter(Boolean).join(' ');
    }
    return isEnglish
      ? [personalDataWarning, 'First choose a valid offer. After that, continue in the cart for contact details, number transfer, start date and signing.'].filter(Boolean).join(' ')
      : [personalDataWarning, 'Välj först ett giltigt erbjudande. Efter det fortsätter du i varukorgen för kontaktuppgifter, nummerflytt, startdatum och signering.'].filter(Boolean).join(' ');
  }
  if (intent === 'gift_card') {
    const summary = summarizeCartItem(toolResult?.cart?.[0]);
    if (summary) {
      return isEnglish
        ? `Gift cards are connected to the selected offer. In your cart I can see: ${summary}. You choose the gift card during the purchase flow.`
        : `Presentkortet hör ihop med det valda erbjudandet. I din varukorg ser jag: ${summary}. Du väljer presentkort i köpflödet.`;
    }
    const cards = (toolResult?.giftCards || []).slice(0, 5).join(', ');
    return isEnglish
      ? `Dealett offers gift cards with selected offers. Available examples are ${cards}. First choose an offer, then you can continue to the cart.`
      : `Dealett erbjuder presentkort med utvalda erbjudanden. Exempel är ${cards}. Välj först ett erbjudande, sedan fortsätter du till varukorgen.`;
  }
  if (intent === 'broadband') {
    if (isLowInformationAcknowledgement(message)) {
      return isEnglish
        ? 'Yes, we can continue with broadband. For 5G broadband, availability depends on address, so the safe next step is an address check or coverage comparison. I should not collect sensitive personal data here.'
        : 'Ja, vi kan fortsätta med bredband. För 5G-bredband beror tillgänglighet på adress, så nästa säkra steg är adresskontroll eller täckningsjämförelse. Jag ska inte samla känsliga personuppgifter här i chatten.';
    }
    if (/fiber/i.test(message)) {
      return isEnglish
        ? '5G broadband can be an alternative to fiber if the coverage and capacity are good at your address. Check with address or coverage map before deciding.'
        : '5G-bredband kan vara ett alternativ till fiber om täckning och kapacitet är bra på din adress. Kontrollera med adress eller täckningskarta innan du bestämmer dig.';
    }
    if (/adress|address/i.test(message)) {
      return isEnglish
        ? 'For an exact availability check, yes: use the address field on the 5G broadband page. The chat should not collect your full address.'
        : 'För exakt tillgänglighet, ja: använd adressfältet på 5G-bredbandssidan. Chatten ska inte samla in din fullständiga adress.';
    }
    return isEnglish
      ? 'For 5G broadband, the next step is to enter your address or open the coverage map. I can show the available offers, but exact availability must be checked by address.'
      : 'För 5G-bredband är nästa steg att skriva adress eller öppna täckningskartan. Jag kan visa erbjudanden, men exakt tillgänglighet måste kontrolleras med adress.';
  }
  if (intent === 'coverage') {
    if (hasDirectAnswerSignal(message)) {
      return buildDirectCoverageReply({
        isEnglish,
        message,
        messages,
      });
    }
    if (wantsFullCoverageMap(message)) {
      return isEnglish
        ? 'Yes, if you want a large map view, the full coverage map page can be useful. We can still start here in chat with address, location or operator comparison first.'
        : 'Ja, om du vill ha stor kartvy kan hela täckningskartan vara användbar. Vi kan ändå börja här i chatten med adress, position eller operatörsjämförelse först.';
    }
    if (/karta|map/i.test(message)) {
      return isEnglish
        ? 'We can start the coverage check here in chat. Coverage still depends on exact address and indoor conditions, so use address, location or operator comparison as a first step.'
        : 'Vi kan börja täckningskollen här i chatten. Täckning beror fortfarande på exakt adress och inomhusmiljö, så använd adress, position eller operatörsjämförelse som första steg.';
    }
    if (/inte.*adress|exakta adress|do not want.*address|don't want.*address/i.test(message)) {
      return isEnglish
        ? 'That is fine. You do not need to share the exact address in chat. We can start with location or compare operators generally, but exact coverage still depends on address and indoor conditions.'
        : 'Det är helt okej. Du behöver inte skriva exakt adress i chatten. Vi kan börja med position eller jämföra operatörer generellt, men exakt täckning beror fortfarande på adress och inomhusmiljö.';
    }
    if (/funkar|fungerar|lägenheten|works|work|apartment/i.test(message)) {
      return isEnglish
        ? 'I cannot guarantee indoor coverage from chat. Buildings can change the signal a lot, but we can start here with address, location or operator comparison and treat the result as guidance.'
        : 'Jag kan inte garantera inomhustäckning från chatten. Byggnader kan påverka signalen mycket, men vi kan börja här med adress, position eller operatörsjämförelse och se det som vägledning.';
    }
    if (/vad borde|kontrollera|what should|check/i.test(message)) {
      return isEnglish
        ? 'Coverage depends on exact address, especially indoors. We can start here in chat: choose address, location or operator comparison, then avoid ordering until the guidance looks good where you use the service most.'
        : 'Täckning beror på exakt adress, särskilt inomhus. Vi kan börja här i chatten: välj adress, position eller operatörsjämförelse, och beställ först när vägledningen ser bra ut där du använder tjänsten mest.';
    }
    return isEnglish
      ? 'Coverage depends on exact address, especially indoors. We can start here in chat: choose whether you want to enter an address, use location or compare operators.'
      : 'Täckning beror på exakt adress, särskilt inomhus. Vi kan börja här i chatten: välj om du vill ange adress, använda position eller jämföra operatörer.';
  }
  if (['mobile_offer', 'family_offer'].includes(intent) && toolResult?.status === 'missing_info') {
    return buildMissingInfoReply({
      nextField: toolResult.nextField,
      isEnglish,
      message,
      qualification,
    });
  }
  if (toolResult?.status === 'valid_offer') {
    const top = toolResult.offerCalculation.options[0];
    const priceText = Number(top.peopleCount) > 1
      ? (isEnglish
        ? `${top.monthlyPrice} SEK/month total, about ${top.pricePerPerson} SEK per subscription`
        : `${top.monthlyPrice} kr/mån totalt, cirka ${top.pricePerPerson} kr per abonnemang`)
      : (isEnglish ? `${top.monthlyPrice} SEK/month` : `${top.monthlyPrice} kr/mån`);
    if (wantsExplanation(message)) {
      return isEnglish
        ? `It is better because the code calculation compares your current cost with ${top.operator} ${top.title}, includes ${top.overlapCostKnown} SEK overlap cost and ${top.rewardTotal} SEK gift card, and still estimates ${top.savingsVsStaying} SEK in savings over ${top.contractMonths} months.`
        : `Det är bättre eftersom kalkylen jämför din nuvarande kostnad med ${top.operator} ${top.title}, räknar med ${top.overlapCostKnown} kr i dubbelkostnad och ${top.rewardTotal} kr i presentkort, och ändå visar cirka ${top.savingsVsStaying} kr i vinst över ${top.contractMonths} månader.`;
    }
    if (wantsToProceed(message)) {
      return isEnglish
        ? `Yes. The valid option is ${top.operator} ${top.title} for ${priceText}. Continue in the cart to choose gift card, number transfer, start date and signing.`
        : `Ja. Det giltiga alternativet är ${top.operator} ${top.title} för ${priceText}. Fortsätt i varukorgen för att välja presentkort, nummerflytt, startdatum och signering.`;
    }
    if (/visa bästa|bästa|show best|best option/i.test(message)) {
      return isEnglish
        ? `Best valid option right now: ${top.operator} ${top.title} for ${priceText}, with estimated savings of ${top.savingsVsStaying} SEK after overlap cost and gift card.`
        : `Bästa giltiga alternativet just nu: ${top.operator} ${top.title} för ${priceText}, med uppskattad vinst på ${top.savingsVsStaying} kr efter dubbelkostnad och presentkort.`;
    }
    return isEnglish
      ? `I found a valid option: ${top.operator} ${top.title} for ${priceText}. The estimated saving is ${top.savingsVsStaying} SEK after overlap cost and gift card.`
      : `Jag hittade ett giltigt alternativ: ${top.operator} ${top.title} för ${priceText}. Uppskattad vinst är ${top.savingsVsStaying} kr efter dubbelkostnad och presentkort.`;
  }
  if (toolResult?.status === 'no_valid_offer') {
    const reason = toolResult.offerCalculation.noOfferReason;
    if (/mer än 6|more than 6/i.test(String(reason || ''))) {
      if (asksForException(message)) {
        return isEnglish
          ? 'Not as a valid Dealett switch today. With more than 6 months left, the safer advice is to wait until the remaining contract time is 6 months or less, then compare again with the exact price and binding time.'
          : 'Inte som ett giltigt Dealett-byte idag. När mer än 6 månader återstår är rådet att vänta tills bindningstiden är högst 6 månader och sedan jämföra igen med exakt pris och bindningstid.';
      }
      return isEnglish
        ? 'I should not recommend switching right now because at least one subscription has more than 6 months left. Dealett only creates an offer when the remaining contract time is 6 months or less and the total becomes cheaper after overlap cost and gift card.'
        : 'Jag ska inte rekommendera byte just nu eftersom minst ett abonnemang har mer än 6 månader kvar. Dealett tar bara fram erbjudande när bindningstiden är högst 6 månader och totalen blir billigare efter dubbelkostnad och presentkort.';
    }
    return reason || (isEnglish ? 'I do not have a valid cheaper offer right now.' : 'Jag har inget giltigt billigare erbjudande just nu.');
  }
  return isEnglish
    ? 'What would you like help with at Dealett?'
    : 'Vad vill du ha hjälp med hos Dealett?';
};

const buildPrompt = ({ language, intent, message, messages, qualification, toolResult, facts, conversationStyle }) => [
  'You are Dealett assistant, Dealett customer service and sales support.',
  'Your job is to write the customer-facing wording in a natural human way.',
  'Dealett code decides intent, missing fields, offer validity, prices, savings, coverage boundaries and cart actions.',
  'Never override or invent facts beyond responsePlan/toolResult.',
  'Do not use canned/template wording. Write a fresh reply that fits the exact customer message.',
  'Be simple, warm and direct. Prefer everyday Swedish/English, not bureaucratic language.',
  'Ask at most one question unless responsePlan explicitly allows more.',
  'Do not collect personal identity numbers, phone numbers, payment details or BankID details in chat.',
  'When checkout/signing is needed, direct the customer to the cart.',
  'If responsePlan.nextField exists, ask naturally for that exact thing and do not ask for other fields.',
  'If responsePlan.hasValidOffer is true, explain only the supplied offer calculation and do not invent other prices.',
  'If responsePlan.coverageSelector is true, support the in-chat selector and do not tell the user they must leave chat unless they asked for a full map.',
  'Return JSON only: {"reply":"..."}',
  '',
  `Language: ${language === 'en' ? 'English' : 'Swedish'}`,
  `Intent: ${intent}`,
  `Customer message: ${message}`,
  `Recent conversation: ${JSON.stringify(trimMessages(messages))}`,
  `Memory/qualification: ${JSON.stringify(qualification)}`,
  `Conversation style: ${JSON.stringify(conversationStyle)}`,
  `Response plan: ${JSON.stringify(buildResponsePlan({ intent, language, message, messages, qualification, toolResult, facts, conversationStyle }))}`,
  `Tool result: ${JSON.stringify(toolResult)}`,
  `Relevant Dealett facts: ${JSON.stringify(facts)}`,
].join('\n');

const buildResponsePlan = ({ intent, message, messages = [], qualification = {}, toolResult = {}, facts = [], conversationStyle = null }) => {
  const base = {
    intent,
    style: conversationStyle?.style || 'advisor',
    maxQuestions: 1,
    tone: 'simple, friendly, human, concise',
    doNotSoundLikeForm: true,
  };

  if (intent === 'greeting') {
    return {
      ...base,
      action: 'welcome',
      mentionCapabilities: ['mobilabonnemang', 'bredband', 'täckning', 'presentkort'],
      ask: 'what the customer wants to start with',
    };
  }

  if (intent === 'capabilities') {
    return {
      ...base,
      action: 'explain_capabilities',
      canHelpWith: ['compare mobile plans', '5G broadband', 'coverage', 'gift-card value', 'general invoice/subscription explanations'],
      limitation: 'cannot see live account or invoice data in chat',
    };
  }

  if (intent === 'identity') {
    return {
      ...base,
      action: 'explain_identity',
      identity: 'Dealett AI, not a human',
      promise: 'helps with telecom questions and says when unsure or when current deal may be better',
    };
  }

  if (intent === 'small_talk') {
    return {
      ...base,
      action: 'small_talk_redirect',
      answerLightly: true,
      redirectTo: ['mobile plans', 'broadband', 'coverage', 'gift-card value'],
    };
  }

  if (intent === 'dealett_trust') {
    return {
      ...base,
      action: 'explain_trust',
      facts: [
        'Dealett may earn compensation from partners if customer buys through Dealett',
        'assistant should still say when current deal looks better or switching is not worth it',
      ],
    };
  }

  if (intent === 'fake_condition') {
    return {
      ...base,
      action: 'reject_fake_conditions',
      rule: 'Dealett can only compare real operator terms, price, usage and binding time',
    };
  }

  if (toolResult?.type === 'qualification') {
    const nextField = toolResult.nextField || qualification.missingFields?.[0] || null;
    const fieldGuidance = {
      peopleCount: 'ask whether it is only for the customer or several subscriptions; if they already said several, ask roughly how many',
      operators: 'ask which operator they use today; examples may include Telia, Tele2, Telenor, Tre, Halebop, Comviq, Hallon or another operator',
      bindingEnds: 'ask if they have binding time left or no binding; mention that this affects whether switching is worth it only if helpful',
      mobileUsage: 'ask how they mostly use mobile data, in plain behavior terms such as social media, streaming or max data',
      priceRange: 'ask roughly what they pay per month today',
    };
    return {
      ...base,
      action: 'collect_missing_info',
      nextField,
      askFor: fieldGuidance[nextField] || 'the next missing detail',
      knownSoFar: {
        peopleCount: qualification.peopleCount || null,
        operators: qualification.operators || [],
        bindingEnds: qualification.bindingEnds || [],
        mobileUsage: qualification.mobileUsage || null,
        exactMonthlyPrice: qualification.exactMonthlyPrice || null,
        priceRange: qualification.priceRange || null,
      },
      avoid: [
        'do not ask for a field already known',
        'do not ask multiple checklist questions',
        'do not sound like a form',
      ],
    };
  }

  if (toolResult?.type === 'market_intelligence') {
    return {
      ...base,
      action: 'market_claim_clarification',
      status: toolResult.status,
      classification: toolResult.marketClassification || null,
      marketClaim: toolResult.marketClaim || null,
      rule: 'Do not accuse. Ask one clarification if needed. Do not recommend an offer yet unless classification allows it.',
    };
  }

  if (toolResult?.status === 'valid_offer') {
    const top = toolResult.offerCalculation?.options?.[0] || null;
    return {
      ...base,
      action: wantsExplanation(message)
        ? 'explain_valid_offer'
        : wantsToProceed(message)
          ? 'route_to_cart'
          : 'present_valid_offer',
      hasValidOffer: true,
      topOffer: top,
      offerCalculation: toolResult.offerCalculation,
      rule: 'Use only supplied offer figures. Do not invent prices, terms, or operators.',
    };
  }

  if (toolResult?.status === 'no_valid_offer') {
    return {
      ...base,
      action: 'explain_no_valid_offer',
      reason: toolResult.offerCalculation?.noOfferReason || null,
      offerCalculation: toolResult.offerCalculation || null,
      rule: 'Do not pressure the customer. Explain why there is no valid cheaper offer.',
    };
  }

  if (toolResult?.type === 'coverage') {
    return {
      ...base,
      action: hasDirectAnswerSignal(message) ? 'direct_coverage_guidance' : 'coverage_guidance',
      coverageSelector: true,
      rule: 'No guarantees, no exact signal scores. Give practical guidance and mention address/indoor uncertainty.',
      fullMapRequested: wantsFullCoverageMap(message),
    };
  }

  if (toolResult?.type === 'broadband') {
    return {
      ...base,
      action: 'broadband_guidance',
      rule: '5G broadband availability depends on address/coverage. Do not collect sensitive personal data in chat.',
      offers: toolResult.offers || [],
    };
  }

  if (toolResult?.type === 'customer_service') {
    return {
      ...base,
      action: 'customer_service_guidance',
      limitation: 'chat has no live account/invoice data',
      selectedCartItem: toolResult.selectedCartItem || null,
    };
  }

  if (toolResult?.type === 'cart') {
    return {
      ...base,
      action: 'cart_guidance',
      cartStatus: toolResult.status,
      boundary: toolResult.boundary,
    };
  }

  if (toolResult?.type === 'gift_card') {
    return {
      ...base,
      action: 'gift_card_guidance',
      giftCards: toolResult.giftCards || [],
      rule: 'Do not optimize only for reward; total value matters.',
    };
  }

  return {
    ...base,
    action: intent || 'general_reply',
    facts,
  };
};

const getRecentConversationText = (message, messages = []) => [
  ...trimMessages(messages).map((item) => item.content),
  message,
].join(' ').toLowerCase();

const hasSkepticalContext = (text) => (
  /får ni betalt|far ni betalt|säljare|saljare|bara sälja|bara salja|lita på|lita pa|oberoende|partisk|reklam.*sälj|reklam.*salj/i.test(String(text || ''))
);

const hasRewardContext = (text) => (
  /presentkort|belöning|beloning|bonus|reward|gift card/i.test(String(text || ''))
);

const hasCurrentRewardSignal = (text) => (
  /presentkort|belöning|beloning|bonus|reward|gift card|högsta presentkort|hogsta presentkort|största presentkort|storsta presentkort|mest tillbaka/i
    .test(String(text || ''))
);

const hasCurrentApproximateFactualInput = (text) => {
  const normalized = String(text || '').toLowerCase();
  const factualUnit = '(?:kr|sek|kronor|spänn|spann|gb|g|person|personer|abonnemang|mån|månad|månader|manader|month|months)?';
  const approximateWords = '(?:typ|runt|cirka|ca|ungefär|ungefar|kanske|maybe|around|roughly|approximately)';
  const numberPattern = `(?:\\d{1,4}|${numberWordPattern})`;

  return new RegExp(`\\b${approximateWords}\\s*${numberPattern}\\s*${factualUnit}\\b`, 'i').test(normalized) ||
    new RegExp(`\\b${numberPattern}\\s*${factualUnit}\\s*${approximateWords}\\b`, 'i').test(normalized) ||
    /\btror\s+(jag|vi)\s+betalar\b/i.test(normalized) ||
    /\btror\s+(jag|vi)\s+(har|använder|anvander|är|ar)\s+.*\d/i.test(normalized);
};

const hasBrowsingContext = (text) => (
  /kika|tittar runt|testa chatten|såg.*reklam|sag.*reklam|bara kollar|nyfiken/i.test(String(text || ''))
);

const hasEmotionContext = (text) => (
  /galen|trött|trott|stress|arg|irriterad|orkar inte|alla luras|frustrerad/i.test(String(text || ''))
);

const hasTrustMarker = (reply) => (
  /ersättning|partners|tillit|nuvarande avtal|pressa|sälja|salja|oberoende/i.test(String(reply || ''))
);

const hasUncertaintyMarker = (reply) => (
  /ungefär|gissning|inte exakt|kan inte garantera|räcker för att börja|osäker/i.test(String(reply || ''))
);

const alternateRepeatedReply = (reply, isEnglish = false) => {
  const text = String(reply || '').trim();
  if (/hur använder du mobilen/i.test(text)) {
    return isEnglish
      ? 'Roughly is enough: mostly Wi-Fi/social media, streaming/video, or maximum data?'
      : 'Ungefär räcker: mest wifi/sociala medier, streaming/video eller max surf?';
  }
  if (/hur många abonnemang/i.test(text)) {
    return isEnglish
      ? 'Roughly: is it just you, or several subscriptions?'
      : 'Är det bara till dig, eller flera abonnemang?';
  }
  if (/vilken operatör har/i.test(text)) {
    return isEnglish
      ? 'Which operator should we use as the rough starting point? If you do not know, write "do not know".'
      : 'Vilken operatör ska vi utgå från ungefär? Om du inte vet kan du skriva "vet inte".';
  }
  if (/bindningstid har du kvar/i.test(text)) {
    return isEnglish
      ? 'Roughly how much contract time is left? If you do not know, write "do not know".'
      : 'Ungefär hur lång bindningstid är kvar? Om du inte vet kan du skriva "vet inte".';
  }
  if (/vad betalar du per abonnemang/i.test(text)) {
    return isEnglish
      ? 'A rough price is enough: under 300, 300-400, or 400+ SEK?'
      : 'Ett ungefärligt pris räcker: under 300, 300-400 eller 400+ kr?';
  }
  return text;
};

const softenStrictQualification = (reply, recentText, isEnglish = false) => {
  let nextReply = String(reply || '');
  const sensitiveContext = hasSkepticalContext(recentText) || hasRewardContext(recentText) || hasBrowsingContext(recentText);
  if (!sensitiveContext) return nextReply;

  nextReply = nextReply.replace(
    /Hur många abonnemang vill du ha\?/g,
    isEnglish
      ? 'If you want to compare for real: is it just you or several subscriptions?'
      : 'Är det bara till dig, eller flera abonnemang?'
  );
  nextReply = nextReply.replace(
    /Vilken operatör har du idag\?/g,
    isEnglish
      ? 'Which operator should we use as the rough starting point?'
      : 'Vilken operatör ska vi utgå från ungefär?'
  );
  nextReply = nextReply.replace(
    /Hur lång bindningstid har du kvar\?/g,
    isEnglish
      ? 'Roughly how much contract time is left?'
      : 'Ungefär hur lång bindningstid är kvar?'
  );
  return nextReply;
};

const addContextMarkers = ({ reply, recentText, currentMessage, intent, isEnglish = false }) => {
  let nextReply = String(reply || '');
  if (!nextReply) return nextReply;
  const currentText = String(currentMessage || '');

  if (hasSkepticalContext(currentText) && !hasTrustMarker(nextReply)) {
    nextReply = isEnglish
      ? `Without pushing a sale: ${nextReply}`
      : `Utan att pressa fram ett byte: ${nextReply}`;
  } else if (hasCurrentRewardSignal(currentText) && !/presentkort|belöning|beloning|bonus|totalvärde|totalvarde/i.test(nextReply)) {
    nextReply = isEnglish
      ? `So the reward does not become a bad total deal: ${nextReply}`
      : `För att presentkortet inte ska bli en dålig totalaffär: ${nextReply}`;
  } else if (hasBrowsingContext(currentText) && !/kika|jämför|jamfor|ingen press|när du vill|nar du vill/i.test(nextReply)) {
    nextReply = isEnglish
      ? `No pressure while you browse: ${nextReply}`
      : `Ingen press medan du kikar: ${nextReply}`;
  } else if (hasEmotionContext(currentText) && !/förstår|forstar|lugnt|enkelt|steg|press/i.test(nextReply)) {
    nextReply = isEnglish
      ? `I understand, we can keep it simple: ${nextReply}`
      : `Jag förstår, vi håller det enkelt: ${nextReply}`;
  }

  if (
    hasCurrentApproximateFactualInput(currentMessage) &&
    !hasUncertaintyMarker(nextReply) &&
    !['dealett_trust', 'fake_condition'].includes(intent)
  ) {
    nextReply = /\?/.test(nextReply)
      ? (isEnglish ? `Roughly is enough here: ${nextReply}` : `Ungefär räcker här: ${nextReply}`)
      : (isEnglish ? `Treating this as approximate: ${nextReply}` : `Jag tar det som ungefärligt: ${nextReply}`);
  }

  if (
    ['mobile_offer', 'family_offer', 'market_intelligence'].includes(intent) &&
    /rekommenderar|bättre|värt|värde|passa bättre|billigare/i.test(nextReply) &&
    !/för att|därför|eftersom|because|kostnad|täckning|bindning|surf|total/i.test(nextReply)
  ) {
    nextReply += isEnglish
      ? ' The reason is that price, coverage, binding time and real usage all affect whether a switch is actually worth it.'
      : ' Det är för att pris, täckning, bindningstid och faktisk användning avgör om ett byte verkligen är värt det.';
  }

  return nextReply;
};

const stripPrefixPatterns = (reply, patterns = []) => patterns.reduce((nextReply, pattern) => (
  String(nextReply || '').replace(pattern, '').trimStart()
), String(reply || ''));

const sanitizeLeakedContextPrefixes = ({ reply, message }) => {
  let nextReply = String(reply || '').trim();
  if (!nextReply) return nextReply;

  const greeting = isGreetingOnly(message);
  const allowRewardPrefix = !greeting && hasCurrentRewardSignal(message);
  const allowApproximatePrefix = !greeting && hasCurrentApproximateFactualInput(message);
  const allowTrustPrefix = !greeting && hasSkepticalContext(message);
  const allowBrowsingPrefix = !greeting && hasBrowsingContext(message);
  const allowEmotionPrefix = !greeting && hasEmotionContext(message);
  const rewardPrefixPatterns = [
    /^För att presentkortet inte ska bli en dålig totalaffär:\s*/i,
    /^So the reward does not become a bad total deal:\s*/i,
  ];
  const approximatePrefixPatterns = [
    /^Jag tar det som ungefärligt:\s*/i,
    /^Ungefär räcker här:\s*/i,
    /^Ungefär räcker:\s*/i,
    /^Treating this as approximate:\s*/i,
    /^Roughly is enough here:\s*/i,
    /^Roughly is enough:\s*/i,
  ];
  const trustPrefixPatterns = [
    /^Utan att pressa fram ett byte:\s*/i,
    /^Without pushing a sale:\s*/i,
  ];
  const browsingPrefixPatterns = [
    /^Ingen press medan du kikar:\s*/i,
    /^No pressure while you browse:\s*/i,
  ];
  const emotionPrefixPatterns = [
    /^Jag förstår, vi håller det enkelt:\s*/i,
    /^I understand, we can keep it simple:\s*/i,
  ];

  for (let index = 0; index < 4; index += 1) {
    const before = nextReply;
    if (!allowRewardPrefix) nextReply = stripPrefixPatterns(nextReply, rewardPrefixPatterns);
    if (!allowApproximatePrefix) nextReply = stripPrefixPatterns(nextReply, approximatePrefixPatterns);
    if (!allowTrustPrefix) nextReply = stripPrefixPatterns(nextReply, trustPrefixPatterns);
    if (!allowBrowsingPrefix) nextReply = stripPrefixPatterns(nextReply, browsingPrefixPatterns);
    if (!allowEmotionPrefix) nextReply = stripPrefixPatterns(nextReply, emotionPrefixPatterns);
    if (nextReply === before) break;
  }

  return nextReply.trim();
};

const polishReplyForConversation = ({ reply, message, messages = [], language, intent, generated = false }) => {
  const isEnglish = language === 'en';
  const recentText = getRecentConversationText(message, messages);
  const previousAssistant = [...trimMessages(messages)]
    .reverse()
    .find((item) => item.role === 'assistant')?.content || '';
  let nextReply = String(reply || '').trim();

  if (generated) {
    return sanitizeLeakedContextPrefixes({
      reply: nextReply,
      message,
    }).slice(0, 1400);
  }

  if (previousAssistant && nextReply === String(previousAssistant).trim()) {
    nextReply = alternateRepeatedReply(nextReply, isEnglish);
  }

  nextReply = softenStrictQualification(nextReply, recentText, isEnglish);
  nextReply = addContextMarkers({
    reply: nextReply,
    recentText,
    currentMessage: message,
    intent,
    isEnglish,
  });

  nextReply = sanitizeLeakedContextPrefixes({
    reply: nextReply,
    message,
  });

  return nextReply.slice(0, 1400);
};

const generateReply = async (context) => {
  const mockOperatorSupportReply = buildMockOperatorSupportReply(context);
  if (mockOperatorSupportReply) {
    return { reply: mockOperatorSupportReply, generated: false };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (process.env.DEALETT_CHAT_FORCE_FALLBACK === '1') {
    return { reply: fallbackReply(context), generated: false };
  }
  if (!apiKey) {
    return { reply: fallbackReply(context), generated: false };
  }

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        input: buildPrompt(context),
        max_output_tokens: 350,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { reply: fallbackReply(context), generated: false };
    }
    const parsed = safeJsonParse(extractOutputText(body));
    if (parsed?.reply) {
      return { reply: String(parsed.reply).slice(0, 1400), generated: true };
    }
    return { reply: fallbackReply(context), generated: false };
  } catch {
    return { reply: fallbackReply(context), generated: false };
  }
};

const createChatCompletion = async ({
  message,
  messages,
  language = 'sv',
  page = {},
  cart = [],
  qualification = {},
  conversationStyle = null,
  context = {},
}) => {
  const latestMessage = String(message || '').trim();
  if (!latestMessage) {
    const error = new Error('Message is required');
    error.statusCode = 400;
    throw error;
  }

  const normalizedLanguage = language === 'en' ? 'en' : 'sv';
  const contextualMessage = normalizeContextualMessage(latestMessage, messages);
  const storedQualification = normalizeQualification(qualification);
  const shouldResetStoredQualification = isGreetingOnly(latestMessage) ||
    (isGenericTopicStart(latestMessage) && storedQualification.readyForOffer);
  const baseQualification = shouldResetStoredQualification ? createEmptyQualification() : qualification;
  const nextQualification = inferQualificationFromText(contextualMessage, baseQualification);
  const nextConversationStyle = detectConversationStyle({
    message: latestMessage,
    history: messages,
    context: {
      ...(context || {}),
      conversationStyle: conversationStyle || context?.conversationStyle || null,
    },
  });
  const intent = detectIntent({
    message: latestMessage,
    messages,
    page,
    qualification: nextQualification,
    conversationStyle: nextConversationStyle,
    appContext: context,
  });
  const initialToolResult = buildToolResult({
    intent,
    qualification: nextQualification,
    cart,
  });
  const marketClaim = buildMarketClaim({
    message: latestMessage,
    messages,
    qualification: nextQualification,
    offerCalculation: initialToolResult.offerCalculation || null,
  });
  const toolResult = applyMarketIntelligenceGate({
    intent,
    toolResult: initialToolResult,
    marketClaim,
  });
  const offerCalculation = toolResult.type === 'market_intelligence'
    ? emptyOfferCalculation(nextQualification)
    : (toolResult.offerCalculation || emptyOfferCalculation(nextQualification));
  const facts = retrieveKnowledge({
    message: latestMessage,
    intent,
    cart,
  });
  const suggestions = defaultSuggestions({
    intent,
    qualification: nextQualification,
    offerCalculation,
    cart,
    language: normalizedLanguage,
  });
  const rawReply = await generateReply({
    intent,
    language: normalizedLanguage,
    message: latestMessage,
    messages,
    qualification: nextQualification,
    toolResult,
    facts,
    conversationStyle: nextConversationStyle,
    appContext: context,
  });
  const reply = polishReplyForConversation({
    reply: rawReply.reply,
    message: latestMessage,
    messages,
    language: normalizedLanguage,
    intent,
    generated: rawReply.generated,
  });
  const shouldShowCoverageSelector = intent === 'coverage' ||
    (intent === 'soft_guidance' && /^coverage_/.test(String(getSoftGuidanceType(contextualMessage) || ''))) ||
    (intent === 'style_guided' && /täckning|tackning|coverage|nät|nat|bäst täckning|bast tackning/i.test(latestMessage));
  const embeddedWidget = getEmbeddedWidgetForChatState({
    intent: shouldShowCoverageSelector ? 'coverage' : intent,
    language: normalizedLanguage,
  });
  const uiResponse = buildChatResponse({
    message: reply,
    quickReplies: embeddedWidget
      ? []
      : getQuickRepliesForChatState({
        intent,
        language: normalizedLanguage,
        conversationStyle: nextConversationStyle,
      }),
    offerCards: buildOfferCardsFromOfferCalculation(offerCalculation, {
      language: normalizedLanguage,
    }),
    embeddedWidget,
  });

  return {
    reply,
    message: uiResponse.message,
    quickReplies: uiResponse.quickReplies,
    offerCards: uiResponse.offerCards,
    embeddedWidget: uiResponse.embeddedWidget,
    qualification: nextQualification,
    offerCalculation,
    marketClaim: toolResult.marketClaim || null,
    marketClassification: toolResult.marketClassification || null,
    conversationStyle: nextConversationStyle,
    suggestions,
    intent,
  };
};

module.exports = {
  createChatCompletion,
  inferQualificationFromText,
  loadChatRules,
  normalizeQualification,
};
