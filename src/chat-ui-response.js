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

const normalizeQuickReply = (reply, index) => {
  const label = typeof reply === 'string' ? reply.trim() : String(reply?.label || '').trim();
  if (!label) return null;
  const allowedActions = [
    'send_message', 'open_coverage_map', 'open_broadband_page',
    'open_broadband_address', 'open_cart', 'open_account', 'open_contact',
  ];
  const action = typeof reply === 'object' && allowedActions.includes(reply?.action)
    ? reply.action
    : 'send_message';
  return {
    id: slugify(typeof reply === 'object' ? (reply?.id || label) : label, `reply-${index + 1}`),
    label: label.slice(0, 80),
    action,
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
    dataTitle: String(card.dataTitle || '').trim().slice(0, 80),
    monthlyPriceTitle: String(card.monthlyPriceTitle || '').trim().slice(0, 80),
    bindingTitle: String(card.bindingTitle || '').trim().slice(0, 80),
    dataLabel: String(card.dataLabel || '').trim().slice(0, 80),
    monthlyPriceLabel: String(card.monthlyPriceLabel || '').trim().slice(0, 80),
    monthlyPriceSubLabel: String(card.monthlyPriceSubLabel || '').trim().slice(0, 100),
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

const removeRepeatedCardFacts = (benefits = [], option = {}) => {
  const primaryPrice = Number(option.pricePerPerson);
  const totalPrice = Number(option.planMonthlyPrice);
  const bindingMonths = Number(option.bindingMonths);
  const priceNumbers = [primaryPrice, totalPrice]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => String(Math.round(value)));

  return (Array.isArray(benefits) ? benefits : []).filter((benefit) => {
    const text = String(benefit || '').trim();
    const normalized = text.toLocaleLowerCase('sv').replace(/[\s\u00a0\u202f,.]/g, '');
    const repeatsPrice = priceNumbers.some((price) => normalized.includes(price)) &&
      /(kr|sek|person|month|månad|mån)/i.test(text) &&
      !/(spar|saving|billigare|less|lägre)/i.test(text);
    const repeatsBinding = bindingMonths > 0 && normalized.includes(String(bindingMonths)) &&
      /(bind|contract)/i.test(text);
    return !repeatsPrice && !repeatsBinding;
  });
};

const buildOfferCardsFromOfferCalculation = (offerCalculation = {}, { language = 'sv', copy = {} } = {}) => {
  if (!offerCalculation.validOfferAvailable) return [];
  const cardCopy = copy.offerCardCopy || {};
  const entries = [
    {
      option: offerCalculation.bestMatch,
      resultLabel: cardCopy.bestMatchLabel,
      reason: copy.bestMatchReason,
      benefits: copy.bestMatchBenefits,
    },
    {
      option: offerCalculation.lowestEffectiveCost,
      resultLabel: cardCopy.lowestEffectiveCostLabel,
      reason: copy.lowestEffectiveCostReason,
      benefits: copy.lowestEffectiveCostBenefits,
    },
  ].filter((entry, index, all) => entry.option && all.findIndex((candidate) => (
    candidate.option?.planId === entry.option.planId
  )) === index);

  return normalizeOfferCards(entries.map(({ option, resultLabel, reason, benefits }) => {
    const isGroupOffer = Number(option.peopleCount) > 1;
    return {
      id: option.planId,
      planId: option.planId,
      operator: option.operator,
      planName: option.title || option.planName,
      dataLabel: option.data,
      dataTitle: cardCopy.dataTitle,
      monthlyPriceTitle: isGroupOffer
        ? (cardCopy.perPersonPriceTitle || cardCopy.monthlyPriceTitle)
        : cardCopy.monthlyPriceTitle,
      bindingTitle: cardCopy.bindingTitle,
      resultLabel,
      monthlyPriceLabel: `${formatMoney(
        isGroupOffer ? option.pricePerPerson : option.planMonthlyPrice,
        language
      )}${isGroupOffer ? (cardCopy.perPersonSuffix || cardCopy.perMonthSuffix) : cardCopy.perMonthSuffix}`,
      monthlyPriceSubLabel: isGroupOffer
        ? `${cardCopy.totalPriceTitle || cardCopy.monthlyPriceTitle}: ${formatMoney(option.planMonthlyPrice, language)}${cardCopy.perMonthSuffix}`
        : '',
      effectiveCostLabel: `${formatMoney(option.effectiveMonthlyCost, language)}${cardCopy.perMonthSuffix}`,
      savingsLabel: '',
      rewardLabel: cardCopy.rewardLabel,
      bindingLabel: Number(option.bindingMonths) > 0
        ? `${option.bindingMonths}${cardCopy.bindingMonthsSuffix}`
        : '',
      reason,
      benefits: removeRepeatedCardFacts(benefits, option),
      ctaLabel: cardCopy.ctaLabel,
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
