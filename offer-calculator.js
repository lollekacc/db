const { getPlans } = require('./offer-service');

const CONTRACT_MONTHS = 24;
const DEFAULT_REWARD = 4000;
const MAX_ALLOWED_BINDING_MONTHS = 6;

const streamingServiceMonthlyPrices = {
  netflix: 169,
  'netflix standard': 169,
  hbo: 89,
  'hbo max': 99,
  'hbo max basic med reklam': 89,
  max: 89,
  disney: 59,
  'disney+': 59,
  'disney+ standard med reklam': 59,
  'amazon prime': 59,
  'tv4 play plus': 69,
};

const priceRangeMidpoints = {
  under300: 275,
  '300-400': 350,
  '400-500': 450,
};

const providerLogos = {
  Telia: 'images/telia.png',
  Tele2: 'images/tele2.png',
  Tre: 'images/tre.jpg',
  Telenor: 'images/telenor.jpg',
  Halebop: 'images/halebop.webp',
};

const tierOrder = {
  low: 1,
  medium: 2,
  high: 3,
};

const isMobilePlan = (plan = {}) => ['mobil', 'mobile_subscription'].includes(plan.category);
const isRuntimeSellablePlan = (plan = {}) => plan.runtimeSellable !== false;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const monthsBetween = (fromDate, toDate) => {
  const start = new Date(fromDate);
  const end = new Date(toDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return 0;
  }

  const yearDiff = end.getFullYear() - start.getFullYear();
  const monthDiff = end.getMonth() - start.getMonth();
  const dayFraction = Math.max(end.getDate() - start.getDate(), 0) / 30;
  return Math.ceil(yearDiff * 12 + monthDiff + dayFraction);
};

const getRemainingBindingMonths = (bindingEnd, today = new Date()) => {
  const value = String(bindingEnd || '').trim();
  if (!value || /ingen/i.test(value)) return 0;
  if (/vet/i.test(value)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return monthsBetween(today, value);

  const monthMatch = value.match(/(\d+)\s*(mån|man|month|months)/i);
  if (monthMatch) return Math.max(Number(monthMatch[1]) || 0, 0);

  return null;
};

const getCurrentMonthlyPrice = (priceRange) => priceRangeMidpoints[priceRange] || 0;

const getCurrentMonthlyPrices = (qualification, peopleCount) => {
  const fallbackPrice = Number(qualification.exactMonthlyPrice) > 0
    ? Number(qualification.exactMonthlyPrice)
    : getCurrentMonthlyPrice(qualification.priceRange);
  const exactPrices = Array.isArray(qualification.exactMonthlyPrices)
    ? qualification.exactMonthlyPrices
      .map((price) => Number(price))
      .filter((price) => Number.isFinite(price) && price > 0)
    : [];

  return Array.from({ length: peopleCount }, (_, index) => exactPrices[index] || fallbackPrice);
};

const buildPersonProfiles = (qualification, peopleCount, today) => {
  const currentMonthlyPrices = getCurrentMonthlyPrices(qualification, peopleCount);

  return Array.from({ length: peopleCount }, (_, index) => {
    const bindingEnd = qualification.bindingEnds?.[index] || '';
    const remainingBindingMonths = getRemainingBindingMonths(bindingEnd, today);

    return {
      index: index + 1,
      operator: qualification.operators?.[index] || null,
      bindingEnd,
      remainingBindingMonths,
      currentMonthlyPrice: currentMonthlyPrices[index],
    };
  });
};

const getDataTier = (plan) => {
  if (plan.tier) return plan.tier;
  if (Number(plan.dataAmount) >= 100 || Number(plan.dataAmount) >= 999) return 'high';
  if (Number(plan.dataAmount) >= 20) return 'medium';
  return 'low';
};

const planMatchesUsage = (plan, usageTier) => {
  if (!usageTier) return true;
  return (tierOrder[getDataTier(plan)] || 0) >= (tierOrder[usageTier] || 0);
};

const getAddonForOperator = (operator, plans) => plans.find((plan) =>
  plan.operator === operator &&
  isRuntimeSellablePlan(plan) &&
  plan.isFamilyPlan === true &&
  plan.familyPriceType === 'addon'
) || null;

const getStreamingServicePrice = (service) => {
  if (typeof service === 'number') return Math.max(service, 0);
  if (typeof service === 'string') {
    return streamingServiceMonthlyPrices[service.trim().toLowerCase()] || 0;
  }
  if (!service || typeof service !== 'object') return 0;

  const explicitPrice = Number(
    service.monthlyPrice ??
    service.monthlyValue ??
    service.price ??
    service.value
  );

  if (Number.isFinite(explicitPrice) && explicitPrice > 0) return explicitPrice;

  return getStreamingServicePrice(service.name || service.service || service.title);
};

const getStreamingServiceKey = (service) => {
  const source = typeof service === 'string'
    ? service
    : String(service?.name || service?.service || service?.title || '');
  const value = source.trim().toLowerCase();

  if (/netflix/.test(value)) return 'netflix';
  if (/\bhbo\b|max/.test(value)) return 'hbo';
  if (/disney/.test(value)) return 'disney';
  if (/amazon|prime/.test(value)) return 'amazon';
  if (/tv4/.test(value)) return 'tv4';
  return value;
};

const getSelectedStreamingServiceKeys = (qualification = {}) => (
  Array.isArray(qualification.streamingServices)
    ? new Set(qualification.streamingServices.map(getStreamingServiceKey).filter(Boolean))
    : new Set()
);

const getIncludedStreamingServices = (plan = {}) => {
  if (Array.isArray(plan.includedStreaming) && plan.includedStreaming.length) {
    return plan.includedStreaming;
  }

  const text = String(plan.text || '');
  const services = [];
  if (/netflix/i.test(text)) services.push('Netflix');
  if (/\bhbo\b|max/i.test(text)) services.push('HBO');
  if (/disney/i.test(text)) services.push('Disney+');
  if (/amazon|prime/i.test(text)) services.push('Amazon Prime');
  if (/tv4/i.test(text)) services.push('TV4 Play Plus');
  return services;
};

const getIncludedStreamingValue = (plan = {}, qualification = {}) => {
  if (qualification.streamingCalculation !== 'include' || plan.operator !== 'Telia') return 0;

  const selectedServices = getSelectedStreamingServiceKeys(qualification);
  return getIncludedStreamingServices(plan)
    .filter((service) => !selectedServices.size || selectedServices.has(getStreamingServiceKey(service)))
    .reduce((sum, service) => sum + getStreamingServicePrice(service), 0);
};

const buildCandidate = ({ basePlan, addonPlan, peopleCount, qualification, today }) => {
  const extraCount = Math.max(peopleCount - 1, 0);
  const addonPrice = extraCount * (Number(addonPlan?.addonPrice ?? addonPlan?.price) || 0);
  const listedMonthlyPrice = Number(basePlan.price) + addonPrice;
  const includedServiceMonthlyValue = getIncludedStreamingValue(basePlan, qualification);
  const monthlyPrice = Math.max(listedMonthlyPrice - includedServiceMonthlyValue, 0);
  const pricePerPerson = peopleCount > 0 ? Math.round(monthlyPrice / peopleCount) : monthlyPrice;
  const personProfiles = buildPersonProfiles(qualification, peopleCount, today);
  const currentMonthlyTotal = personProfiles.reduce((sum, person) => sum + person.currentMonthlyPrice, 0);
  const currentMonthlyPricePerPerson = peopleCount > 0
    ? Math.round(currentMonthlyTotal / peopleCount)
    : currentMonthlyTotal;
  const remainingMonths = personProfiles.map((person) => person.remainingBindingMonths);
  const unknownBindingCount = remainingMonths.filter((months) => months === null).length;
  const overLimitBindingCount = remainingMonths.filter((months) =>
    months !== null && months > MAX_ALLOWED_BINDING_MONTHS
  ).length;
  const maxRemainingBindingMonths = remainingMonths.reduce((max, months) => (
    months === null ? max : Math.max(max, months)
  ), 0);
  const knownOverlapCost = personProfiles.reduce((sum, person) => (
    person.remainingBindingMonths === null
      ? sum
      : sum + person.remainingBindingMonths * person.currentMonthlyPrice
  ), 0);
  const dealettContractCost = monthlyPrice * CONTRACT_MONTHS;
  const oldContractCost = currentMonthlyTotal * CONTRACT_MONTHS;
  const effectiveCostWithOverlap = dealettContractCost + knownOverlapCost - DEFAULT_REWARD;
  const savingsVsStaying = oldContractCost - effectiveCostWithOverlap;
  const isWithinBindingRule = unknownBindingCount === 0 && overLimitBindingCount === 0;
  const isBetterByCost = savingsVsStaying > 0 && isWithinBindingRule;
  const hasExactCurrentPrices = Number(qualification.exactMonthlyPrice) > 0 ||
    (Array.isArray(qualification.exactMonthlyPrices) && qualification.exactMonthlyPrices.length >= peopleCount);
  const disqualificationReasons = [
    unknownBindingCount
      ? 'Exakt bindningstid saknas, så 6-månadersregeln kan inte kontrolleras.'
      : '',
    overLimitBindingCount
      ? `Kunden har bindningstid över ${MAX_ALLOWED_BINDING_MONTHS} månader.`
      : '',
    savingsVsStaying <= 0
      ? 'Dealett-erbjudandet blir inte billigare efter dubbelkostnad och presentkort.'
      : '',
  ].filter(Boolean);

  return {
    planId: basePlan.id,
    operator: basePlan.operator,
    title: basePlan.title,
    data: basePlan.data,
    dataAmount: basePlan.dataAmount,
    tier: getDataTier(basePlan),
    peopleCount,
    monthlyPrice,
    listedMonthlyPrice,
    includedServiceMonthlyValue,
    includedStreamingServices: getIncludedStreamingServices(basePlan),
    pricePerPerson,
    addonPrice,
    rewardTotal: DEFAULT_REWARD,
    contractMonths: CONTRACT_MONTHS,
    currentMonthlyPricePerPerson,
    currentMonthlyPrices: personProfiles.map((person) => person.currentMonthlyPrice),
    currentMonthlyPriceIsEstimate: !hasExactCurrentPrices,
    currentMonthlyTotal,
    personProfiles,
    remainingBindingMonths: remainingMonths,
    unknownBindingCount,
    overLimitBindingCount,
    maxRemainingBindingMonths,
    maxAllowedBindingMonths: MAX_ALLOWED_BINDING_MONTHS,
    overlapCostKnown: roundMoney(knownOverlapCost),
    dealettContractCost: roundMoney(dealettContractCost),
    currentContractCost: roundMoney(oldContractCost),
    effectiveCostWithOverlap: roundMoney(effectiveCostWithOverlap),
    savingsVsStaying: roundMoney(savingsVsStaying),
    isWithinBindingRule,
    isBetterByCost,
    eligibleForOffer: isBetterByCost,
    disqualificationReasons,
    notes: [
      unknownBindingCount
        ? `${unknownBindingCount} bindningstidssvar är okända, så 6-månadersregeln kan inte kontrolleras.`
        : '',
      overLimitBindingCount
        ? `${overLimitBindingCount} abonnemang har mer än ${MAX_ALLOWED_BINDING_MONTHS} månader kvar.`
        : '',
      !hasExactCurrentPrices
        ? 'Nuvarande pris är uppskattat från valt prisintervall.'
        : '',
      includedServiceMonthlyValue > 0
        ? `Telia streamingvärde ${roundMoney(includedServiceMonthlyValue)} kr/mån är avräknat från totalpriset.`
        : '',
      knownOverlapCost > 0
        ? `Beräknad dubbelkostnad under kvarvarande bindningstid: ${roundMoney(knownOverlapCost)} kr.`
        : 'Ingen beräknad dubbelkostnad från kvarvarande bindningstid.',
    ].filter(Boolean),
  };
};

const calculateOfferOptions = (qualification = {}, options = {}) => {
  if (!qualification.readyForOffer) {
    return {
      readyForOffer: false,
      missingFields: qualification.missingFields || [],
      options: [],
    };
  }

  const plans = getPlans();
  const peopleCount = Math.max(Number(qualification.peopleCount) || 1, 1);
  const currentMonthlyPrices = getCurrentMonthlyPrices(qualification, peopleCount);
  const hasExactCurrentPrices = Number(qualification.exactMonthlyPrice) > 0 ||
    (Array.isArray(qualification.exactMonthlyPrices) && qualification.exactMonthlyPrices.length >= peopleCount);
  const basePlans = plans.filter((plan) =>
    isMobilePlan(plan) &&
    isRuntimeSellablePlan(plan) &&
    !plan.isFamilyPlan &&
    planMatchesUsage(plan, qualification.mobileUsage)
  );
  const allCandidates = basePlans
    .map((basePlan) => {
      const addonPlan = peopleCount > 1 ? getAddonForOperator(basePlan.operator, plans) : null;
      if (peopleCount > 1 && !addonPlan) return null;

      return buildCandidate({
        basePlan,
        addonPlan,
        peopleCount,
        qualification,
        today: options.today || new Date(),
      });
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (Number(right.eligibleForOffer) !== Number(left.eligibleForOffer)) {
        return Number(right.eligibleForOffer) - Number(left.eligibleForOffer);
      }

      if (right.savingsVsStaying !== left.savingsVsStaying) {
        return right.savingsVsStaying - left.savingsVsStaying;
      }

      if (left.effectiveCostWithOverlap !== right.effectiveCostWithOverlap) {
        return left.effectiveCostWithOverlap - right.effectiveCostWithOverlap;
      }

      return left.monthlyPrice - right.monthlyPrice;
    });
  const candidates = allCandidates
    .filter((candidate) => candidate.eligibleForOffer)
    .slice(0, 3);
  const rejectedOptions = allCandidates
    .filter((candidate) => !candidate.eligibleForOffer)
    .slice(0, 3);
  const hasUnknownBinding = rejectedOptions.some((candidate) => candidate.unknownBindingCount > 0);
  const hasOverLimitBinding = rejectedOptions.some((candidate) => candidate.overLimitBindingCount > 0);

  return {
    readyForOffer: true,
    missingFields: [],
    validOfferAvailable: candidates.length > 0,
    noOfferReason: candidates.length ? null : (
      hasUnknownBinding
        ? 'Kunden behöver ange exakt bindningstid för att Dealett ska kunna kontrollera 6-månadersregeln.'
        : hasOverLimitBinding
          ? `Kunden har mer än ${MAX_ALLOWED_BINDING_MONTHS} månader kvar i bindningstid.`
          : 'Inget Dealett-erbjudande blir billigare efter dubbelkostnad och presentkort.'
    ),
    assumptions: {
      currentMonthlyPricePerPerson: peopleCount > 0
        ? Math.round(currentMonthlyPrices.reduce((sum, price) => sum + price, 0) / peopleCount)
        : 0,
      currentMonthlyPrices,
      currentMonthlyPriceIsEstimate: !hasExactCurrentPrices,
      contractMonths: CONTRACT_MONTHS,
      rewardTotal: DEFAULT_REWARD,
      maxAllowedBindingMonths: MAX_ALLOWED_BINDING_MONTHS,
      bindingEndUnknownMeans: 'No valid offer is made until exact binding time is known and no subscription has more than 6 months remaining.',
      validOfferRule: 'A Dealett offer is valid only when remaining binding time is 6 months or less and savingsVsStaying is greater than 0 after overlap cost and gift card.',
    },
    options: candidates,
    rejectedOptions,
  };
};

const buildCartItemFromCalculatedOffer = ({ qualification = {}, planId }) => {
  const calculation = calculateOfferOptions(qualification);
  const option = calculation.options.find((item) => item.planId === planId) || calculation.options[0];

  if (!calculation.readyForOffer || !option) {
    const error = new Error('Qualification is not ready for an offer');
    error.statusCode = 400;
    throw error;
  }

  const cartItem = {
    cartItemId: `${option.operator}-${option.planId}-${Date.now()}`,
    offerId: option.planId,
    operator: option.operator,
    title: option.title || option.data || 'Mobilabonnemang',
    logo: providerLogos[option.operator] || '',
    data: option.data,
    dataAmount: option.dataAmount,
    price: option.monthlyPrice,
    pricePerPerson: option.pricePerPerson,
    persons: option.peopleCount,
    phoneLines: option.peopleCount,
    productType: option.peopleCount > 1 ? 'family' : 'mobile',
    unitLabel: 'abonnemang',
    rewardTotal: option.rewardTotal,
    rewardMixLabel: `Presentkort ${option.rewardTotal.toLocaleString('sv-SE')} kr`,
    rewards: { Presentkort: option.rewardTotal },
    answers: {
      qualification,
      offerCalculation: option,
    },
    features: [
      `${option.peopleCount} abonnemang`,
      `${option.contractMonths} mån bindningstid`,
      option.overlapCostKnown > 0 ? `Dubbelkostnad ca ${option.overlapCostKnown.toLocaleString('sv-SE')} kr` : 'Ingen beräknad dubbelkostnad',
      `Presentkort ${option.rewardTotal.toLocaleString('sv-SE')} kr`,
      `Uppskattad vinst ${option.savingsVsStaying.toLocaleString('sv-SE')} kr`,
    ],
  };

  return {
    cartItem,
    state: {
      persons: option.peopleCount,
      data: option.tier,
      operator: option.operator,
      binding: 'yes',
      wishes: [option.peopleCount > 1 ? 'Familjabonnemang' : 'Mobilabonnemang'],
      answers: cartItem.answers,
      operatorsByPerson: qualification.operators || [],
      bindingEndDatesByPerson: qualification.bindingEnds || [],
    },
    calculation,
  };
};

module.exports = {
  buildCartItemFromCalculatedOffer,
  calculateOfferOptions,
  getRemainingBindingMonths,
  MAX_ALLOWED_BINDING_MONTHS,
};
