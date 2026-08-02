const { getPlanCatalog } = require('./offer-service');

const PRICE_RANGE_MIDPOINTS = {
  under300: 275,
  '300-400': 350,
  '400-500': 450,
};

const USAGE_MINIMUM_GB = {
  low: 10,
  medium: 20,
  high: Infinity,
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const getStreamingServiceKey = (service) => {
  const value = String(
    typeof service === 'string'
      ? service
      : service?.service || service?.name || service?.title || ''
  ).trim().toLowerCase();

  if (/netflix/.test(value)) return 'netflix';
  if (/\bhbo\b|max/.test(value)) return 'hbo';
  if (/disney/.test(value)) return 'disney';
  if (/amazon|prime/.test(value)) return 'amazon';
  if (/tv4/.test(value)) return 'tv4';
  return slugify(value);
};

const getStreamingCosts = (qualification = {}) => {
  const source = qualification.streamingMonthlyCosts || qualification.streamingServiceCosts || {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

  return Object.entries(source).reduce((result, [service, price]) => {
    const key = getStreamingServiceKey(service);
    const amount = Math.max(Number(price) || 0, 0);
    if (key && amount > 0) result[key] = amount;
    return result;
  }, {});
};

const getSelectedStreamingKeys = (qualification = {}) => new Set(
  Array.isArray(qualification.streamingServices)
    ? qualification.streamingServices.map(getStreamingServiceKey).filter(Boolean)
    : []
);

const getIncludedStreaming = (plan = {}, streamingVariant = null) => {
  if (streamingVariant?.service) return [streamingVariant.service];
  if (plan.streaming?.mode === 'included_bundle' && Array.isArray(plan.streaming.services)) {
    return plan.streaming.services;
  }
  return [];
};

const getStreamingReplacement = (includedServices, qualification) => {
  if (qualification.streamingCalculation !== 'include') {
    return { services: [], monthlySavings: 0 };
  }

  const selected = getSelectedStreamingKeys(qualification);
  const costs = getStreamingCosts(qualification);
  const services = includedServices
    .map((service) => ({
      key: getStreamingServiceKey(service),
      name: String(service),
    }))
    .filter((service) => selected.has(service.key) && costs[service.key] > 0)
    .map((service) => ({ ...service, monthlyCost: costs[service.key] }));

  return {
    services,
    monthlySavings: roundMoney(services.reduce((sum, service) => sum + service.monthlyCost, 0)),
  };
};

const getRequiredDataGb = (qualification = {}) => {
  const explicit = Number(qualification.requiredDataGb);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return USAGE_MINIMUM_GB[qualification.mobileUsage] ?? 0;
};

const getPlanDataAmount = (plan = {}) => (
  plan.data?.type === 'unlimited' ? Infinity : Math.max(Number(plan.data?.gb) || 0, 0)
);

const planMeetsDataNeed = ({ operator, plan, peopleCount, requiredDataGb }) => {
  if (plan.data?.type === 'unlimited') return true;
  if (!Number.isFinite(requiredDataGb)) return false;

  const planDataGb = getPlanDataAmount(plan);
  if (operator.familyDataModel === 'shared_on_limited_plans' && peopleCount > 1) {
    return planDataGb >= requiredDataGb * peopleCount;
  }
  return planDataGb >= requiredDataGb;
};

const getInternationalCapabilities = (operator = {}, plan = {}) => {
  const operatorRoaming = operator.internationalRoaming || {};
  const planRoaming = plan.roaming || {};
  return {
    euEea: operator.euEeaRoamingCallsSmsIncluded === true,
    outsideEuData: operatorRoaming.dataIncluded === true ||
      Number(planRoaming.internationalDataCountries) > 0,
    outsideEuLocalCalls: operatorRoaming.localCallsIncluded === true ||
      planRoaming.localCallsIncludedAbroad === true,
    worldwideFamilyCalls: plan.internationalCalls?.freeCallsWithinFamilyWorldwide === true,
    euEeaIncludedHours: Number(plan.internationalCalls?.euEeaIncludedHours) || 0,
    countries: Number(operatorRoaming.countries || planRoaming.internationalDataCountries) || 0,
    internationalDataGb: Number(planRoaming.internationalDataGb) || null,
    euEeaDataGb: Number(planRoaming.euEeaDataGb) || null,
  };
};

const planMeetsTravelNeed = (capabilities, qualification = {}) => {
  if (qualification.internationalTravel === 'eu') return capabilities.euEea;
  if (qualification.internationalTravel !== 'outside_eu') return true;
  if (qualification.internationalUsage === 'calls') {
    return capabilities.outsideEuData && capabilities.outsideEuLocalCalls;
  }
  return capabilities.outsideEuData;
};

const getCurrentMonthlyTotal = (qualification, peopleCount) => {
  if (Number(qualification.familyTotalPrice) > 0) {
    return { amount: Number(qualification.familyTotalPrice), estimated: false };
  }

  const exactPrices = Array.isArray(qualification.exactMonthlyPrices)
    ? qualification.exactMonthlyPrices.map(Number).filter((price) => price > 0)
    : [];
  if (exactPrices.length >= peopleCount) {
    return {
      amount: exactPrices.slice(0, peopleCount).reduce((sum, price) => sum + price, 0),
      estimated: false,
    };
  }

  if (Number(qualification.exactMonthlyPrice) > 0) {
    return {
      amount: Number(qualification.exactMonthlyPrice) * peopleCount,
      estimated: false,
    };
  }

  const midpoint = PRICE_RANGE_MIDPOINTS[qualification.priceRange] || 0;
  return { amount: midpoint * peopleCount, estimated: midpoint > 0 };
};

const getPlanPrices = (plan, variant = null) => {
  const price = variant || plan.price || {};
  return {
    monthly: Number(price.monthly ?? price.monthlyPrice) || 0,
    regularMonthly: Number(price.regularMonthly ?? price.regularMonthlyPrice) || null,
    campaignMonths: Number(price.campaignMonths ?? plan.price?.campaignMonths) || null,
  };
};

const expandPlanVariants = (operator, plan) => {
  if (plan.streaming?.mode !== 'choose_one') return [{ plan, streamingVariant: null }];
  return plan.streaming.options.map((streamingVariant) => ({ plan, streamingVariant }));
};

const buildBenefits = ({ operator, plan, peopleCount, capabilities, includedStreaming }) => [
  plan.data?.type === 'unlimited'
    ? 'Obegränsad data'
    : `${plan.data.gb} GB ${operator.familyDataModel === 'shared_on_limited_plans' && peopleCount > 1 ? 'delas i familjen' : 'per användare'}`,
  peopleCount > 1 ? `${peopleCount} användare med tilläggspris` : '',
  capabilities.euEea ? 'Samtal, sms och roaming inom EU/EES' : '',
  capabilities.countries ? `Utlandsdata i ${capabilities.countries} länder` : '',
  capabilities.outsideEuLocalCalls ? 'Lokala samtal ingår utomlands' : '',
  capabilities.worldwideFamilyCalls ? 'Fria samtal inom familjen världen över' : '',
  capabilities.euEeaIncludedHours ? `${capabilities.euEeaIncludedHours} samtalstimmar inom EU/EES` : '',
  plan.extraSim?.included ? `Extra SIM med ${plan.extraSim.dataGb} GB ingår` : '',
  includedStreaming.length ? `${includedStreaming.join(', ')} ingår` : '',
].filter(Boolean);

const buildCandidate = ({ operator, plan, streamingVariant, qualification, peopleCount }) => {
  if (peopleCount > 1 && plan.familyEligible !== true) return null;

  const requiredDataGb = getRequiredDataGb(qualification);
  if (!planMeetsDataNeed({ operator, plan, peopleCount, requiredDataGb })) return null;

  const capabilities = getInternationalCapabilities(operator, plan);
  if (!planMeetsTravelNeed(capabilities, qualification)) return null;

  const prices = getPlanPrices(plan, streamingVariant);
  if (prices.monthly <= 0) return null;

  const extraUsers = Math.max(peopleCount - 1, 0);
  const additionalUserMonthlyPrice = Number(operator.additionalUser?.monthlyPrice) || 0;
  if (extraUsers > 0 && additionalUserMonthlyPrice <= 0) return null;

  const additionalUserRegularMonthlyPrice = Number(
    operator.additionalUser?.regularMonthlyPrice ?? operator.additionalUser?.monthlyPrice
  ) || 0;
  const planMonthlyPrice = prices.monthly + extraUsers * additionalUserMonthlyPrice;
  const regularMonthlyPlanPrice = (prices.regularMonthly || prices.monthly) +
    extraUsers * additionalUserRegularMonthlyPrice;
  const bindingMonths = Number(operator.bindingMonths) || 0;
  const campaignMonths = prices.campaignMonths && bindingMonths
    ? Math.min(prices.campaignMonths, bindingMonths)
    : 0;
  const averageMonthlyPlanCost = campaignMonths > 0
    ? (
      planMonthlyPrice * campaignMonths +
      regularMonthlyPlanPrice * Math.max(bindingMonths - campaignMonths, 0)
    ) / bindingMonths
    : planMonthlyPrice;
  const includedStreaming = getIncludedStreaming(plan, streamingVariant);
  const streamingReplacement = getStreamingReplacement(includedStreaming, qualification);
  const effectiveMonthlyCost = Math.max(averageMonthlyPlanCost - streamingReplacement.monthlySavings, 0);
  const current = getCurrentMonthlyTotal(qualification, peopleCount);
  const monthlySavings = current.amount > 0
    ? roundMoney(current.amount - effectiveMonthlyCost)
    : null;
  const id = streamingVariant
    ? `${plan.id}-${slugify(streamingVariant.service)}`
    : plan.id;
  const dataAmount = plan.data?.type === 'unlimited' ? 999 : Number(plan.data?.gb) || 0;
  const benefits = buildBenefits({
    operator,
    plan,
    peopleCount,
    capabilities,
    includedStreaming,
  });
  if (campaignMonths > 0 && regularMonthlyPlanPrice !== planMonthlyPrice) {
    benefits.push(`${planMonthlyPrice} kr/mån i ${campaignMonths} månader, därefter ${regularMonthlyPlanPrice} kr/mån`);
  }

  return {
    id,
    planId: id,
    sourcePlanId: plan.id,
    operatorId: operator.id,
    operator: operator.name,
    title: streamingVariant ? `${plan.name} – ${streamingVariant.service}` : plan.name,
    planName: plan.name,
    data: plan.data?.type === 'unlimited' ? 'Obegränsad' : `${dataAmount} GB`,
    dataAmount,
    dataType: plan.data?.type,
    familyEligible: plan.familyEligible === true,
    familyDataModel: operator.familyDataModel,
    peopleCount,
    additionalUserMonthlyPrice,
    planMonthlyPrice: roundMoney(planMonthlyPrice),
    monthlyPrice: roundMoney(planMonthlyPrice),
    regularMonthlyPlanPrice: roundMoney(regularMonthlyPlanPrice),
    campaignMonths: campaignMonths || null,
    averageMonthlyPlanCost: roundMoney(averageMonthlyPlanCost),
    pricePerPerson: roundMoney(planMonthlyPrice / peopleCount),
    effectiveMonthlyCost: roundMoney(effectiveMonthlyCost),
    effectivePricePerPerson: roundMoney(effectiveMonthlyCost / peopleCount),
    streamingSavings: streamingReplacement.monthlySavings,
    replacedStreamingServices: streamingReplacement.services,
    includedStreamingServices: includedStreaming,
    currentMonthlyTotal: roundMoney(current.amount),
    currentMonthlyTotalIsEstimate: current.estimated,
    monthlySavings,
    savingsVsStaying: monthlySavings,
    bindingMonths,
    international: capabilities,
    benefits,
    reason: [
      `${peopleCount} ${peopleCount === 1 ? 'användare' : 'användare'}`,
      plan.data?.type === 'unlimited' ? 'obegränsad data' : `${dataAmount} GB`,
      streamingReplacement.monthlySavings > 0
        ? `${streamingReplacement.monthlySavings} kr/mån i ersatt streaming`
        : '',
      qualification.internationalTravel === 'outside_eu' ? 'matchar behov utanför EU/EES' : '',
      qualification.internationalTravel === 'eu' ? 'EU/EES-roaming ingår' : '',
    ].filter(Boolean).join(', '),
    eligibleForOffer: true,
  };
};

const compareBestValue = (left, right) => (
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  left.planMonthlyPrice - right.planMonthlyPrice ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const compareLowestPrice = (left, right) => (
  left.planMonthlyPrice - right.planMonthlyPrice ||
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const uniqueBestByOperator = (candidates) => {
  const byOperator = new Map();
  [...candidates].sort(compareBestValue).forEach((candidate) => {
    if (!byOperator.has(candidate.operatorId)) byOperator.set(candidate.operatorId, candidate);
  });
  return [...byOperator.values()].sort(compareBestValue);
};

const calculateOfferOptions = (qualification = {}) => {
  if (!qualification.readyForOffer) {
    return {
      readyForOffer: false,
      missingFields: qualification.missingFields || [],
      validOfferAvailable: false,
      bestValue: null,
      lowestMonthlyPrice: null,
      options: [],
    };
  }

  const peopleCount = Math.max(Number(qualification.peopleCount) || 1, 1);
  const catalog = getPlanCatalog();
  const allCandidates = catalog.operators.flatMap((operator) => operator.plans
    .flatMap((plan) => expandPlanVariants(operator, plan)
      .map(({ streamingVariant }) => buildCandidate({
        operator,
        plan,
        streamingVariant,
        qualification,
        peopleCount,
      })))
    .filter(Boolean));
  const options = uniqueBestByOperator(allCandidates);
  const bestValue = [...allCandidates].sort(compareBestValue)[0] || null;
  const lowestMonthlyPrice = [...allCandidates].sort(compareLowestPrice)[0] || null;

  return {
    readyForOffer: true,
    missingFields: [],
    validOfferAvailable: options.length > 0,
    noOfferReason: options.length
      ? null
      : 'Inget abonnemang i mobilplansdatan matchar alla angivna behov.',
    bestValue: bestValue ? { ...bestValue, recommendationType: 'best_value' } : null,
    lowestMonthlyPrice: lowestMonthlyPrice
      ? { ...lowestMonthlyPrice, recommendationType: 'lowest_monthly_price' }
      : null,
    options: options.map((candidate) => ({
      ...candidate,
      recommendationTypes: [
        candidate.id === bestValue?.id ? 'best_value' : '',
        candidate.id === lowestMonthlyPrice?.id ? 'lowest_monthly_price' : '',
      ].filter(Boolean),
    })),
    assumptions: {
      planDataSource: 'data/plans.json',
      requiredDataGb: getRequiredDataGb(qualification),
      streamingSavingsRule: 'Only customer-supplied monthly costs for selected services included in the plan are deducted.',
      currentMonthlyTotalIsEstimate: getCurrentMonthlyTotal(qualification, peopleCount).estimated,
    },
  };
};

const buildCartItemFromCalculatedOffer = ({ qualification = {}, planId }) => {
  const calculation = calculateOfferOptions(qualification);
  const candidates = [calculation.bestValue, calculation.lowestMonthlyPrice, ...calculation.options].filter(Boolean);
  const option = candidates.find((candidate) => candidate.planId === planId) || calculation.bestValue;

  if (!calculation.readyForOffer || !option) {
    const error = new Error('Qualification is not ready for an offer');
    error.statusCode = 400;
    throw error;
  }

  const rewardTotal = 0;
  const cartItem = {
    cartItemId: `${option.operatorId}-${option.planId}-${Date.now()}`,
    offerId: option.planId,
    operator: option.operator,
    title: option.title,
    data: option.data,
    dataAmount: option.dataAmount,
    price: option.planMonthlyPrice,
    monthlyPrice: option.planMonthlyPrice,
    regularMonthlyPrice: option.regularMonthlyPlanPrice,
    pricePerPerson: option.pricePerPerson,
    persons: option.peopleCount,
    phoneLines: option.peopleCount,
    productType: option.peopleCount > 1 ? 'family' : 'mobile',
    unitLabel: 'abonnemang',
    rewardTotal,
    rewardMixLabel: '',
    rewards: {},
    answers: { qualification, offerCalculation: option },
    features: [
      ...option.benefits,
      `Effektiv kostnad ${option.effectiveMonthlyCost.toLocaleString('sv-SE')} kr/mån`,
      option.streamingSavings > 0
        ? `Ersatt streaming ${option.streamingSavings.toLocaleString('sv-SE')} kr/mån`
        : '',
    ].filter(Boolean),
  };

  return {
    cartItem,
    state: {
      persons: option.peopleCount,
      operator: option.operator,
      wishes: [option.peopleCount > 1 ? 'Familjabonnemang' : 'Mobilabonnemang'],
      answers: cartItem.answers,
    },
    calculation,
  };
};

module.exports = {
  buildCartItemFromCalculatedOffer,
  calculateOfferOptions,
  getStreamingServiceKey,
};
