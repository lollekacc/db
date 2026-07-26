const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');

const mobileOperatorMeta = {
  Telia: {
    provider: 'Telia',
    logo: 'images/telia.png',
    accent: '#6E2380',
    reward: 4000,
  },
  Telenor: {
    provider: 'Telenor',
    logo: 'images/telenor.jpg',
    accent: '#00437E',
    reward: 4000,
  },
  Tre: {
    provider: 'Tre',
    logo: 'images/tre.jpg',
    accent: '#E65C00',
    reward: 4000,
  },
  Tele2: {
    provider: 'Tele2',
    logo: 'images/tele2.png',
    accent: '#003A6E',
    reward: 4000,
  },
};

const providerLogos = {
  Telia: 'images/telia.png',
  Tele2: 'images/tele2.png',
  Tre: 'images/tre.jpg',
  Telenor: 'images/telenor.jpg',
};

let plansCache = null;
let broadbandCache = null;

const readJson = (fileName) => JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
);

const getPlans = () => {
  if (!plansCache) plansCache = readJson('plans.json');
  return plansCache;
};

const getBroadbandPlans = () => {
  if (!broadbandCache) broadbandCache = readJson('5Gbredband.json');
  return broadbandCache;
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

  const provider = mobileOperatorMeta[plan.operator] || { reward: 4000, accent: 'var(--accent)' };
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
  const monthlyPrice = (Number(plan.price) || 0) + addonPrice;
  const rewardTotal = provider.reward || 4000;
  const normalizedRewards = normalizeRewards(rewards, rewardTotal);

  const cartItem = {
    cartItemId: `${plan.operator}-${plan.id}-${Date.now()}`,
    offerId: plan.id,
    operator: plan.operator,
    title: plan.title || plan.data || 'Mobilabonnemang',
    logo: plan.logo,
    data: getPlanDataLabel(plan),
    price: monthlyPrice,
    pricePerPerson: persons > 1 ? Math.round(monthlyPrice / persons) : 0,
    persons,
    phoneLines: persons,
    productType: 'mobile',
    unitLabel: 'abonnemang',
    rewardTotal,
    rewardMixLabel: `Presentkort ${formatCurrency(rewardTotal)} kr`,
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
    rewardMixLabel: `Presentkort ${formatCurrency(reward)} kr`,
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

const matchesPriceExpectation = (priceExpectation, pricePerPerson) => {
  if (!priceExpectation) return true;
  if (priceExpectation === 'under300') return pricePerPerson < 300;
  if (priceExpectation === '300-400') return pricePerPerson >= 300 && pricePerPerson < 400;
  if (priceExpectation === '400-500') return pricePerPerson >= 400;
  return true;
};

const enrichPlanForRecommendation = (plan, allPlans, state) => {
  const persons = state.persons || 1;
  let finalPrice = plan.price;
  let pricePerPerson = plan.price;

  if (persons > 1) {
    const addon = allPlans.find((candidate) =>
      candidate.operator === plan.operator &&
      isRuntimeSellablePlan(candidate) &&
      candidate.isFamilyPlan === true &&
      candidate.familyPriceType === 'addon'
    );

    if (!addon) return null;
    finalPrice = plan.price + (persons - 1) * addon.addonPrice;
    pricePerPerson = Math.round(finalPrice / persons);
  }

  return {
    ...plan,
    finalPrice,
    pricePerPerson,
  };
};

const scorePlan = (plan, state, currentOperators) => {
  let score = 0;

  if (matchesPriceExpectation(state.price, plan.pricePerPerson)) score += 4;
  if (currentOperators.has(plan.operator)) score += 2;
  if (state.binding === 'yes' && currentOperators.has(plan.operator)) score += 1;
  if (state.binding === 'no' && !currentOperators.has(plan.operator)) score += 1;

  return score;
};

const uniqueByOperator = (items = []) => {
  const seenOperators = new Set();

  return items.filter((item) => {
    const operatorKey = String(item?.operator || '').trim().toLowerCase();
    if (!operatorKey || seenOperators.has(operatorKey)) return false;
    seenOperators.add(operatorKey);
    return true;
  });
};

const getMobileRecommendations = (state = {}) => {
  const allPlans = getPlans();
  const basePlans = allPlans.filter((plan) => isMobilePlan(plan) && isRuntimeSellablePlan(plan) && !plan.isFamilyPlan);
  const currentOperators = new Set(
    (state.operators || [])
      .filter(Boolean)
      .filter((operator) => !['Other', 'Andra / Ingen'].includes(operator))
  );

  const rankedPlans = basePlans
    .map((plan) => enrichPlanForRecommendation(plan, allPlans, state))
    .filter(Boolean)
    .filter((plan) => !state.data || plan.tier === state.data)
    .map((plan) => ({
      ...plan,
      score: scorePlan(plan, state, currentOperators),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.finalPrice !== right.finalPrice) return left.finalPrice - right.finalPrice;
      return left.operator.localeCompare(right.operator, 'sv');
    });

  return uniqueByOperator(rankedPlans).slice(0, 4);
};

module.exports = {
  buildBroadbandCartItem,
  buildMobileCartItem,
  getBroadbandOffers,
  getBroadbandPlans,
  getMobileOperatorOffers,
  getMobileRecommendations,
  getPlans,
};
