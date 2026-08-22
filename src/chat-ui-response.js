const MAX_QUICK_REPLIES = 5;
const MAX_OFFER_CARDS = 2;

const slugify = (value, fallback) => {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return slug || fallback;
};

const normalizeQualificationPatch = (patch) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const result = {};
  const peopleCount = Number(patch.peopleCount);
  if (Number.isInteger(peopleCount) && peopleCount >= 1 && peopleCount <= 10) result.peopleCount = peopleCount;
  if (Array.isArray(patch.operators)) result.operators = patch.operators.map(String).slice(0, 10);
  if (Array.isArray(patch.bindingEnds)) result.bindingEnds = patch.bindingEnds.map(String).slice(0, 10);
  if (['low', 'medium', 'high'].includes(patch.mobileUsage)) result.mobileUsage = patch.mobileUsage;
  if (['under300', '300-400', '400-500', 'no_limit'].includes(patch.priceRange)) result.priceRange = patch.priceRange;
  if (['under1000', '1000-1500', '1500-2000', 'over2000', 'unknown'].includes(patch.familyPriceRange)) {
    result.familyPriceRange = patch.familyPriceRange;
  }
  if (['none', 'include', 'unknown'].includes(patch.streamingCalculation)) {
    result.streamingCalculation = patch.streamingCalculation;
  }
  if (Array.isArray(patch.streamingServices)) {
    const allowedStreamingServices = ['netflix', 'hbo', 'disney', 'amazon', 'tv4'];
    result.streamingServices = [...new Set(patch.streamingServices
      .map((service) => String(service || '').trim().toLowerCase())
      .filter((service) => allowedStreamingServices.includes(service)))];
  }
  ['operatorAppliesToAll', 'bindingAppliesToAll', 'priceAppliesToAll'].forEach((field) => {
    if (typeof patch[field] === 'boolean') result[field] = patch[field];
  });
  return Object.keys(result).length ? result : null;
};

const normalizeQuickReply = (reply, index) => {
  const label = typeof reply === 'string' ? reply.trim() : String(reply?.label || '').trim();
  if (!label) return null;
  const qualificationPatch = normalizeQualificationPatch(reply?.qualificationPatch);
  const allowedActions = ['useHistoricalQuizAnswers', 'startFreshWithoutQuiz'];
  const action = typeof reply === 'object' && allowedActions.includes(reply?.action)
    ? reply.action
    : null;
  return {
    id: slugify(typeof reply === 'object' ? (reply?.id || label) : label, `reply-${index + 1}`),
    label: label.slice(0, 80),
    ...(qualificationPatch ? { qualificationPatch } : {}),
    ...(action ? { action } : {}),
  };
};

const normalizeQuickReplies = (quickReplies = []) => Array.isArray(quickReplies)
  ? quickReplies.map(normalizeQuickReply).filter(Boolean).slice(0, MAX_QUICK_REPLIES)
  : [];

const normalizeOfferCard = (card, index) => {
  if (!card || typeof card !== 'object') return null;
  const operator = String(card.operator || '').trim();
  const planName = String(card.planName || '').trim();
  if (!operator && !planName) return null;
  return {
    id: slugify(card.id || `${operator}-${planName}`, `offer-${index + 1}`),
    operator: operator.slice(0, 80),
    planName: planName.slice(0, 120),
    dataLabel: String(card.dataLabel || '').trim().slice(0, 80),
    monthlyPriceLabel: String(card.monthlyPriceLabel || '').trim().slice(0, 80),
    bindingLabel: String(card.bindingLabel || '').trim().slice(0, 100),
    reason: String(card.reason || '').trim().slice(0, 400),
    ctaLabel: String(card.ctaLabel || '').trim().slice(0, 80),
    ctaUrl: String(card.ctaUrl || '').trim().slice(0, 240),
    planId: String(card.planId || '').trim().slice(0, 120),
    resultLabel: String(card.resultLabel || '').trim().slice(0, 80),
    effectiveCostLabel: String(card.effectiveCostLabel || '').trim().slice(0, 80),
    savingsLabel: String(card.savingsLabel || '').trim().slice(0, 100),
    rewardLabel: String(card.rewardLabel || '').trim().slice(0, 80),
    benefits: Array.isArray(card.benefits)
      ? card.benefits.map((benefit) => String(benefit || '').trim()).filter(Boolean).slice(0, 5)
      : [],
  };
};

const normalizeOfferCards = (offerCards = []) => Array.isArray(offerCards)
  ? offerCards.map(normalizeOfferCard).filter(Boolean).slice(0, MAX_OFFER_CARDS)
  : [];

const formatMoney = (value, language) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '';
  return new Intl.NumberFormat(language || 'sv', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount).replace(/[\u00a0\u202f]/g, ' ');
};

const buildOfferCardsFromOfferCalculation = (offerCalculation = {}, { language = 'sv', copy = {} } = {}) => {
  if (!offerCalculation.validOfferAvailable) return [];
  const isEnglish = language === 'en';
  const entries = [
    {
      option: offerCalculation.bestValue,
      resultLabel: isEnglish ? 'Best value' : 'Bäst värde',
      reason: copy.bestValueReason,
      benefits: copy.bestValueBenefits,
    },
    {
      option: offerCalculation.lowestMonthlyPrice,
      resultLabel: isEnglish ? 'Lowest monthly price' : 'Lägst månadspris',
      reason: copy.lowestPriceReason,
      benefits: copy.lowestPriceBenefits,
    },
  ].filter((entry) => entry.option);

  return normalizeOfferCards(entries.map(({ option, resultLabel, reason, benefits }) => {
    const savingsAmount = Number(option.total24MonthResult);
    const hasSavings = Number.isFinite(savingsAmount);
    const supportingDetails = [
      ...(Array.isArray(benefits) ? benefits : []),
      option.giftCardReason,
      ...(Array.isArray(option.benefits) ? option.benefits : []),
    ].map((item) => String(item || '').trim()).filter(Boolean);
    const tradeoffDetails = (Array.isArray(option.tradeoffs) ? option.tradeoffs : [])
      .map((tradeoff) => String(tradeoff || '').trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((tradeoff) => `${isEnglish ? 'Trade-off' : 'Avvägning'}: ${tradeoff}`);
    const distinctSupportingDetails = [...new Set(supportingDetails)];
    const cardDetails = [
      ...distinctSupportingDetails.slice(0, Math.max(5 - tradeoffDetails.length, 0)),
      ...tradeoffDetails,
    ];
    return {
      id: option.planId,
      planId: option.planId,
      operator: option.operator,
      planName: option.title || option.planName,
      dataLabel: option.data,
      resultLabel,
      monthlyPriceLabel: `${formatMoney(option.planMonthlyPrice, language)}/${isEnglish ? 'month' : 'mån'}`,
      effectiveCostLabel: `${formatMoney(option.effectiveMonthlyCost, language)}/${isEnglish ? 'month' : 'mån'}`,
      savingsLabel: hasSavings
        ? `${savingsAmount >= 0 ? (isEnglish ? 'Better over time' : 'Bättre över tid') : (isEnglish ? 'Higher over time' : 'Högre över tid')} ${formatMoney(Math.abs(savingsAmount), language)}`
        : '',
      rewardLabel: isEnglish ? 'Gift card: XXX SEK' : 'Presentkort: XXX kr',
      bindingLabel: Number(option.bindingMonths) > 0
        ? `${option.bindingMonths} ${isEnglish ? 'months binding' : 'mån bindningstid'}`
        : '',
      reason: reason || option.reason,
      benefits: [...new Set(cardDetails)],
      ctaLabel: isEnglish ? 'Choose offer' : 'Välj erbjudande',
      ctaUrl: 'varukorg.html',
    };
  }));
};

const buildChatResponse = ({
  message,
  quickReplies = [],
  quickReplyMode = 'single',
  quickReplySubmitLabel = '',
  offerCards = [],
}) => ({
  message: String(message || ''),
  quickReplies: normalizeQuickReplies(quickReplies),
  quickReplyMode: quickReplyMode === 'multiple' ? 'multiple' : 'single',
  quickReplySubmitLabel: String(quickReplySubmitLabel || '').trim().slice(0, 40),
  offerCards: normalizeOfferCards(offerCards),
  embeddedWidget: null,
});

module.exports = {
  buildChatResponse,
  buildOfferCardsFromOfferCalculation,
  normalizeOfferCards,
  normalizeQuickReplies,
};
