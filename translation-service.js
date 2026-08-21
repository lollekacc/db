const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_ITEMS = 120;
const MAX_ITEM_LENGTH = 1200;
const MAX_TOTAL_LENGTH = 40_000;
const MAX_CACHE_ENTRIES = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const BRAND_NAMES = [
  'Amazon Prime',
  'Apollo',
  'Apple',
  'BankID',
  'Dealett',
  'Disney+',
  'Elgiganten',
  'Facebook',
  'Google',
  'H&M',
  'HBO',
  'ICA Maxi',
  'Instagram',
  'Kivra',
  'Mio',
  'Netflix',
  'Swish',
  'Tele2',
  'Telia',
  'Telenor',
  'Ticketmaster',
  'TikTok',
  'Tre',
  'TV4',
  'Viaplay',
  'YouTube',
  'Zalando',
];

const languageNames = {
  am: 'Amharic',
  ar: 'Arabic',
  bn: 'Bengali',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hu: 'Hungarian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  ku: 'Kurdish',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  so: 'Somali',
  sv: 'Swedish',
  th: 'Thai',
  ti: 'Tigrinya',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  zh: 'Simplified Chinese',
};

const translationCache = new Map();

const createHttpError = (message, statusCode) => (
  Object.assign(new Error(message), { statusCode })
);

const extractOutputText = (response) => {
  if (typeof response?.output_text === 'string') return response.output_text;
  return (response?.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === 'output_text' && content.text)
    .map((content) => content.text)
    .join('');
};

const parseJsonOutput = (value) => {
  const cleaned = String(value || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(cleaned);
};

const normalizeRequest = ({ language, texts }) => {
  const targetLanguage = String(language || '').toLowerCase();
  if (!languageNames[targetLanguage]) {
    throw createHttpError('Unsupported translation language', 400);
  }
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_ITEMS) {
    throw createHttpError(`texts must contain between 1 and ${MAX_ITEMS} items`, 400);
  }

  const normalizedTexts = texts.map((text) => String(text || '').trim());
  if (normalizedTexts.some((text) => !text || text.length > MAX_ITEM_LENGTH)) {
    throw createHttpError(`Each translation text must contain 1-${MAX_ITEM_LENGTH} characters`, 400);
  }
  if (normalizedTexts.reduce((total, text) => total + text.length, 0) > MAX_TOTAL_LENGTH) {
    throw createHttpError('Translation request is too large', 413);
  }

  return { targetLanguage, texts: normalizedTexts };
};

const cacheKey = (language, text) => `${language}\u0000${text}`;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const brandPattern = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${BRAND_NAMES
    .slice()
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|')})(?![\\p{L}\\p{N}])`,
  'gu'
);

const protectBrandNames = (text) => {
  const brands = [];
  const protectedText = text.replace(brandPattern, (brand) => {
    const token = `__DEALETT_BRAND_${brands.length}__`;
    brands.push({ token, brand });
    return token;
  });
  return { protectedText, brands };
};

const restoreBrandNames = (text, brands) => {
  let restored = text;
  brands.forEach(({ token, brand }) => {
    if (!restored.includes(token)) {
      throw createHttpError('Translation provider altered a protected company name', 502);
    }
    restored = restored.split(token).join(brand);
  });
  return restored;
};

const storeTranslation = (language, source, translated) => {
  if (translationCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(cacheKey(language, source), translated);
};

const buildPrompt = ({ targetLanguage, texts }) => [
  `Translate this website UI copy from Swedish to ${languageNames[targetLanguage]}.`,
  'Return JSON only, with exactly this shape: {"translations":["...", "..."]}.',
  'Keep the same number and order of strings.',
  'Use clear, natural language suitable for a Swedish telecom comparison and checkout service.',
  'Translate every human-language word, including product descriptions, plan names, form placeholders, accessibility labels and legal UI copy.',
  'Preserve tokens matching __DEALETT_BRAND_0__, numbers, currencies, URLs, email addresses, technical units and established technical abbreviations.',
  'Do not add explanations, legal claims, markdown or quotation marks around individual UI labels.',
  `Strings: ${JSON.stringify(texts)}`,
].join('\n');

const requestTranslations = async ({ targetLanguage, texts }) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw createHttpError('Translation service is not configured', 503);
  }

  const protectedItems = texts.map(protectBrandNames);
  const protectedTexts = protectedItems.map(({ protectedText }) => protectedText);
  const totalCharacters = protectedTexts.reduce((total, text) => total + text.length, 0);
  const configuredTimeout = Number(process.env.OPENAI_TRANSLATION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TRANSLATION_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
        input: buildPrompt({ targetLanguage, texts: protectedTexts }),
        max_output_tokens: Math.min(12_000, Math.max(800, Math.ceil(totalCharacters * 1.6))),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw createHttpError('Translation provider request timed out', 504);
    }
    throw createHttpError('Translation provider request failed', 502);
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw createHttpError('Translation provider request failed', 502);
  }

  let parsed;
  try {
    parsed = parseJsonOutput(extractOutputText(body));
  } catch {
    throw createHttpError('Translation provider returned invalid JSON', 502);
  }

  if (
    !Array.isArray(parsed?.translations) ||
    parsed.translations.length !== texts.length ||
    parsed.translations.some((translation) => typeof translation !== 'string' || !translation.trim())
  ) {
    throw createHttpError('Translation provider returned an incomplete translation', 502);
  }

  return parsed.translations.map((translation, index) => (
    restoreBrandNames(translation.trim(), protectedItems[index].brands)
  ));
};

const translateTexts = async (request) => {
  const { targetLanguage, texts } = normalizeRequest(request);
  if (targetLanguage === 'sv') {
    return {
      language: targetLanguage,
      translations: texts.map((source) => ({ source, translated: source })),
    };
  }

  const uniqueTexts = [...new Set(texts)];
  const missingTexts = uniqueTexts.filter((text) => !translationCache.has(cacheKey(targetLanguage, text)));

  if (missingTexts.length) {
    const translatedTexts = await requestTranslations({
      targetLanguage,
      texts: missingTexts,
    });
    missingTexts.forEach((source, index) => {
      storeTranslation(targetLanguage, source, translatedTexts[index]);
    });
  }

  return {
    language: targetLanguage,
    translations: texts.map((source) => ({
      source,
      translated: translationCache.get(cacheKey(targetLanguage, source)) || source,
    })),
  };
};

module.exports = {
  BRAND_NAMES,
  languageNames,
  translateTexts,
};
