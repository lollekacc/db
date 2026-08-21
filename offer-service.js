const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');

const mobileOperatorMeta = {
  Telia: {
    provider: 'Telia',
    logo: 'images/telia.png',
    accent: '#6E2380',
    reward: 0,
  },
  Telenor: {
    provider: 'Telenor',
    logo: 'images/telenor.jpg',
    accent: '#00437E',
    reward: 0,
  },
  Tre: {
    provider: 'Tre',
    logo: 'images/tre.jpg',
    accent: '#E65C00',
    reward: 0,
  },
  Tele2: {
    provider: 'Tele2',
    logo: 'images/tele2.png',
    accent: '#003A6E',
    reward: 0,
  },
};

const providerLogos = {
  Telia: 'images/telia.png',
  Tele2: 'images/tele2.png',
  Tre: 'images/tre.jpg',
  Telenor: 'images/telenor.jpg',
};

let planCatalogCache = null;
let plansCache = null;
let broadbandCache = null;
let recommendationRulesCache = null;

const readJson = (fileName) => JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
);

const slugify = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const getPlanCatalog = () => {
  if (!planCatalogCache) {
    const catalog = readJson('plans.json');
    if (!catalog || !Array.isArray(catalog.operators)) {
      throw new Error('data/plans.json must contain an operators array');
    }
    planCatalogCache = catalog;
  }
  return planCatalogCache;
};

const getDataAmount = (plan = {}) => (
  plan.data?.type === 'unlimited' ? 999 : Math.max(Number(plan.data?.gb) || 0, 0)
);

const getTier = (plan = {}) => {
  const amount = getDataAmount(plan);
  if (amount >= 999) return 'high';
  if (amount >= 20) return 'medium';
  return 'low';
};

const getMonthlyPrice = (price = {}) => Number(price?.monthly ?? price?.monthlyPrice) || 0;

const normalizeCatalogPlan = (operator, plan, price, suffix = '', includedStreaming = []) => ({
  id: suffix ? `${plan.id}-${suffix}` : plan.id,
  sourcePlanId: plan.id,
  operatorId: operator.id,
  operator: operator.name,
  logo: providerLogos[operator.name] || '',
  title: plan.name,
  name: plan.name,
  category: 'mobil',
  legacyCategory: 'mobil',
  data: plan.data?.type === 'unlimited' ? 'Obegränsad' : `${getDataAmount(plan)} GB`,
  dataAmount: getDataAmount(plan),
  isUnlimited: plan.data?.type === 'unlimited',
  tier: getTier(plan),
  price: getMonthlyPrice(price),
  monthlyPrice: getMonthlyPrice(price),
  bindingMonths: Number(operator.bindingMonths) || 0,
  giftCard: plan.giftCard || 'XXX',
  minUsers: Number(plan.minUsers) || 1,
  maxUsers: Number(plan.maxUsers) || (plan.familyEligible === true ? 10 : 1),
  familyEligible: plan.familyEligible === true,
  familyDataModel: operator.familyDataModel,
  dataSharing: plan.data?.sharing || null,
  includedStreaming,
  streaming: plan.streaming || null,
  roaming: plan.roaming || operator.internationalRoaming || null,
  internationalCalls: plan.internationalCalls || null,
  extraUserPrice: plan.extraUserPrice || operator.additionalUser?.price || null,
  extraSim: plan.extraSim || null,
  runtimeSellable: true,
});

const flattenPlanCatalog = (catalog) => catalog.operators.flatMap((operator) => {
  const plans = operator.plans.flatMap((plan) => {
    if (plan.streaming?.mode === 'choose_one') {
      return plan.streaming.options.map((option) => normalizeCatalogPlan(
        operator,
        plan,
        option.price || option,
        slugify(option.service),
        [option.service]
      ));
    }

    return [normalizeCatalogPlan(
      operator,
      plan,
      plan.price,
      '',
      plan.streaming?.mode === 'included_bundle' ? plan.streaming.services : []
    )];
  });

  if (!operator.additionalUser) return plans;
  return [
    ...plans,
    {
      id: `${operator.id}-additional-user`,
      operatorId: operator.id,
      operator: operator.name,
      title: 'Extra användare',
      category: 'mobil',
      isFamilyPlan: true,
      familyPriceType: 'addon',
      addonPrice: getMonthlyPrice(operator.additionalUser.price || operator.additionalUser),
      price: getMonthlyPrice(operator.additionalUser.price || operator.additionalUser),
      bindingMonths: Number(operator.bindingMonths) || 0,
      runtimeSellable: true,
    },
  ];
});

const getPlans = () => {
  if (!plansCache) plansCache = flattenPlanCatalog(getPlanCatalog());
  return plansCache;
};

const getBroadbandPlans = () => {
  if (!broadbandCache) broadbandCache = readJson('5Gbredband.json');
  return broadbandCache;
};

const getRecommendationRules = () => {
  if (!recommendationRulesCache) {
    recommendationRulesCache = readJson('recommendation-rules.json');
  }
  return recommendationRulesCache;
};

const formatCurrency = (value) => new Intl.NumberFormat('sv-SE').format(Math.max(Number(value) || 0, 0));

const getPlanDataLabel = (plan = {}) => {
  if (plan.data) return plan.data;
  if (Number(plan.dataAmount) >= 999) return 'Obegränsad';
  if (Number(plan.dataAmount) > 0) return `${plan.dataAmount} GB`;
  return plan.title || 'Mobilabonnemang';
};

const isMobilePlan = (plan = {}) => ['mobil', 'mobile_subscription'].includes(plan.category);
const isRuntimeSellablePlan = (plan = {}) => plan.runtimeSellable !== false;

const calculateBroadbandReward = (price) => {
  if (price < 299) return 1000;
  if (price < 399) return 2000;
  if (price < 499) return 3000;
  if (price < 699) return 4000;
  return 5000;
};

const formatBinding = (plan) => (
  `${Number(plan.bindingMonths) || 24} mån bindningstid`
);

const getMobileOperatorOffers = (operator) => {
  const plans = getPlans();
  const provider = mobileOperatorMeta[operator];

  if (!provider) {
    const error = new Error('Unknown operator');
    error.statusCode = 404;
    throw error;
  }

  const operatorPlans = plans
    .filter((plan) => isMobilePlan(plan) && isRuntimeSellablePlan(plan) && !plan.isFamilyPlan && plan.operator === operator)
    .sort((left, right) => (left.dataAmount || 0) - (right.dataAmount || 0))
    .map((plan) => ({
      ...plan,
      data: getPlanDataLabel(plan),
      reward: provider.reward,
      giftCard: plan.giftCard || 'XXX',
      accent: provider.accent,
    }));

  const addonPlan = plans.find((plan) =>
    isMobilePlan(plan) &&
    isRuntimeSellablePlan(plan) &&
    plan.isFamilyPlan &&
    plan.familyPriceType === 'addon' &&
    plan.operator === operator
  ) || null;

  return {
    provider,
    plans: operatorPlans,
    addonPlan,
  };
};

const sumRewards = (rewards) => {
  if (!rewards || typeof rewards !== 'object') return 0;
  return Object.values(rewards).reduce((sum, value) => sum + Math.max(Number(value) || 0, 0), 0);
};

const normalizeRewards = (rewards, expectedTotal) => {
  if (!rewards || typeof rewards !== 'object' || !Object.keys(rewards).length) {
    return expectedTotal > 0 ? { Presentkort: expectedTotal } : {};
  }

  const normalized = Object.entries(rewards).reduce((result, [name, value]) => {
    const amount = Math.max(Number(value) || 0, 0);
    if (name && amount > 0) result[name] = amount;
    return result;
  }, {});

  if (sumRewards(normalized) !== expectedTotal) {
    const error = new Error('Reward allocation does not match reward total');
    error.statusCode = 400;
    throw error;
  }

  return normalized;
};

const buildMobileCartItem = ({ planId, addonPlanId, rewards, answers = {} }) => {
  const plans = getPlans();
  const plan = plans.find((item) => item.id === planId && isMobilePlan(item) && isRuntimeSellablePlan(item) && !item.isFamilyPlan);

  if (!plan) {
    const error = new Error('Unknown mobile plan');
    error.statusCode = 404;
    throw error;
  }

  const provider = mobileOperatorMeta[plan.operator] || { reward: 0, accent: 'var(--accent)' };
  const addonPlan = addonPlanId
    ? plans.find((item) =>
      item.id === addonPlanId &&
      item.operator === plan.operator &&
      isRuntimeSellablePlan(item) &&
      item.isFamilyPlan &&
      item.familyPriceType === 'addon'
    )
    : null;
  const addonPrice = Number(addonPlan?.addonPrice ?? addonPlan?.price) || 0;
  const persons = addonPlan ? 2 : 1;
  const basePrice = Number(plan.price ?? plan.monthlyPrice) || 0;
  const monthlyPrice = basePrice + addonPrice;
  const regularMonthlyPrice = monthlyPrice;
  const rewardTotal = Number(provider.reward) || 0;
  const normalizedRewards = normalizeRewards(rewards, rewardTotal);

  const cartItem = {
    cartItemId: `${plan.operator}-${plan.id}-${Date.now()}`,
    offerId: plan.id,
    operator: plan.operator,
    title: plan.title || plan.data || 'Mobilabonnemang',
    logo: plan.logo,
    data: getPlanDataLabel(plan),
    price: monthlyPrice,
    monthlyPrice,
    regularMonthlyPrice,
    bindingMonths: Math.max(Number(plan.bindingMonths) || 0, 0),
    noticePeriodMonths: Math.max(Number(plan.noticePeriodMonths) || 0, 0),
    startFee: Math.max(Number(plan.startFee) || 0, 0),
    invoiceFee: Math.max(Number(plan.invoiceFee) || 0, 0),
    invoiceFeeOptional: plan.invoiceFeeOptional !== false,
    pricePerPerson: persons > 1 ? Math.round(monthlyPrice / persons) : 0,
    persons,
    phoneLines: persons,
    productType: 'mobile',
    unitLabel: 'abonnemang',
    rewardTotal,
    rewardMixLabel: rewardTotal ? 'Presentkort: XXX kr' : '',
    rewards: normalizedRewards,
    addon: addonPlan ? {
      id: addonPlan.id,
      title: addonPlan.title,
      price: addonPlan.price,
      addonPrice,
      text: addonPlan.text,
    } : null,
    answers,
    features: [
      'Fria samtal och sms',
      '5G & eSIM',
      addonPlan ? `${addonPlan.title} ${formatCurrency(addonPrice)} kr/mån` : '',
    ].filter(Boolean),
  };

  return {
    cartItem,
    state: {
      persons,
      operator: cartItem.operator,
      wishes: ['Mobilabonnemang'],
      answers,
    },
  };
};

const getBroadbandOffers = ({ tech = 'all', minSpeed = 0, sort = 'price' } = {}) => {
  let offers = getBroadbandPlans().map((plan) => ({
    ...plan,
    bindingMonths: 24,
    rewardTotal: calculateBroadbandReward(plan.price),
  }));

  if (tech !== 'all') {
    offers = offers.filter((plan) => plan.technology === tech);
  }

  const speedFloor = Number(minSpeed) || 0;
  if (speedFloor > 0) {
    offers = offers.filter((plan) => plan.speedMbps >= speedFloor);
  }

  if (sort === 'price') {
    offers.sort((a, b) => a.price - b.price);
  } else if (sort === 'speed') {
    offers.sort((a, b) => b.speedMbps - a.speedMbps);
  } else {
    offers.sort((a, b) => (b.speedMbps / Math.max(b.price, 1)) - (a.speedMbps / Math.max(a.price, 1)));
  }

  return offers;
};

const buildBroadbandCartItem = ({ planId, address }) => {
  const plan = getBroadbandPlans().find((item) => String(item.id) === String(planId));

  if (!plan) {
    const error = new Error('Unknown broadband plan');
    error.statusCode = 404;
    throw error;
  }

  const normalizedPlan = {
    ...plan,
    bindingMonths: 24,
  };
  const reward = calculateBroadbandReward(normalizedPlan.price);
  const logo = providerLogos[plan.operator] || '';
  const normalizedAddress = String(address || '').trim().slice(0, 120);
  const cartItem = {
    cartItemId: `${normalizedPlan.id}-${Date.now()}`,
    offerId: normalizedPlan.id,
    operator: normalizedPlan.operator,
    title: normalizedPlan.title || normalizedPlan.speed || '5G-bredband',
    logo,
    data: normalizedPlan.speed,
    price: normalizedPlan.price || 0,
    pricePerPerson: 0,
    persons: 1,
    phoneLines: 0,
    productType: 'broadband',
    unitLabel: 'bredband',
    rewardTotal: reward,
    rewardMixLabel: reward ? 'Presentkort: XXX kr' : '',
    rewards: { Presentkort: reward },
    answers: {
      broadbandAddress: normalizedAddress || null,
    },
    features: [
      normalizedAddress ? `Adress/plats: ${normalizedAddress}` : '',
      formatBinding(normalizedPlan),
      `${String(normalizedPlan.technology || '').toUpperCase()} · ${formatCurrency(normalizedPlan.speedMbps)} Mbit/s`,
      ...(normalizedPlan.features || []),
    ].filter(Boolean),
  };

  return {
    cartItem,
    state: {
      persons: 1,
      operator: cartItem.operator,
      wishes: ['5G-bredband'],
      answers: {
        broadbandAddress: normalizedAddress || null,
      },
    },
  };
};

module.exports = {
  buildBroadbandCartItem,
  buildMobileCartItem,
  getBroadbandOffers,
  getBroadbandPlans,
  getMobileOperatorOffers,
  getPlanCatalog,
  getRecommendationRules,
  getPlans,
};
