const { getPlanCatalog, getRecommendationRules } = require('./offer-service');

const PRICE_RANGE_MIDPOINTS = {
  under300: 275,
  '300-400': 350,
  '400-500': 450,
};

const FAMILY_PRICE_RANGE_MIDPOINTS = {
  under1000: 850,
  '1000-1500': 1250,
  '1500-2000': 1750,
  over2000: 2250,
};

const USAGE_MINIMUM_GB = {
  low: 10,
  medium: 20,
  high: Infinity,
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const getRules = () => getRecommendationRules();

const getCalculationTermMonths = () => Math.max(Number(getRules().calculation?.termMonths) || 24, 1);

const getReadyToSwitchMonths = (operator = {}) => {
  const rules = getRules().binding || {};
  const operatorKey = slugify(operator.id || operator.name);
  const operatorWindow = rules.salesWindowMonthsByTargetOperator?.[operatorKey];
  return Math.max(Number(operatorWindow ?? rules.defaultSalesWindowMonths) || 3, 0);
};

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
  const personRequirements = Array.isArray(qualification.people)
    ? qualification.people.map((person) => {
      const explicit = Number(person.requiredDataGb);
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      return USAGE_MINIMUM_GB[person.dataNeed || person.mobileUsage] ?? 0;
    })
    : [];
  if (personRequirements.includes(Infinity)) return Infinity;
  const maxPersonRequirement = Math.max(0, ...personRequirements.filter(Number.isFinite));
  if (maxPersonRequirement > 0) return maxPersonRequirement;

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
  const sharedLimitedData = plan.data?.sharing === 'shared' || operator.familyDataModel === 'shared_on_limited_plans';
  if (sharedLimitedData && peopleCount > 1) {
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
      planRoaming.outsideEuDataIncluded === true ||
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

const getTravelEvaluation = (capabilities, qualification = {}) => {
  if (qualification.internationalTravel === 'eu') {
    return capabilities.euEea
      ? {
        required: true,
        match: true,
        score: 2,
        penalty: 0,
        summary: 'Matchar EU/EES-resor med samtal, sms och roaming.',
        tradeoffs: [],
      }
      : {
        required: true,
        match: false,
        score: 0,
        penalty: 100,
        summary: 'EU/EES-resor kan kräva extra kontroll.',
        tradeoffs: ['EU/EES-roaming är inte tydligt inkluderad i vår data för det här alternativet.'],
      };
  }

  if (qualification.internationalTravel !== 'outside_eu') {
    return {
      required: false,
      match: true,
      score: 0,
      penalty: 0,
      summary: null,
      tradeoffs: [],
    };
  }

  const wantsLocalCalls = qualification.internationalUsage === 'calls';
  const tradeoffs = [];
  let score = 0;
  let penalty = 0;

  if (capabilities.outsideEuData) {
    score += 2;
  } else {
    penalty += 120;
    tradeoffs.push('Utanför EU/EES kan surf kräva tillägg eller separat roamingpaket.');
  }

  if (wantsLocalCalls) {
    if (capabilities.outsideEuLocalCalls) {
      score += 2;
    } else {
      penalty += 80;
      tradeoffs.push('Lokala samtal utanför EU/EES kan kosta extra.');
    }
  }

  const match = tradeoffs.length === 0;
  const summary = match
    ? (wantsLocalCalls
      ? 'Matchar utlandsbehovet: surf och lokala samtal utanför EU/EES.'
      : 'Matchar utlandsbehovet: surf utanför EU/EES.')
    : 'Starkt på andra behov, men utlandsdelen kräver en kompromiss.';

  return {
    required: true,
    match,
    score,
    penalty,
    summary,
    tradeoffs,
  };
};

const getSelectedStreamingCost = (qualification = {}) => {
  if (qualification.streamingCalculation !== 'include') return 0;

  const selected = getSelectedStreamingKeys(qualification);
  const costs = getStreamingCosts(qualification);
  return roundMoney([...selected].reduce((sum, service) => sum + (costs[service] || 0), 0));
};

const getStreamingEvaluation = ({ qualification = {}, streamingReplacement }) => {
  const selectedCost = getSelectedStreamingCost(qualification);
  if (selectedCost <= 0) {
    return {
      required: false,
      match: true,
      selectedCost,
      penalty: 0,
      summary: null,
      tradeoffs: [],
    };
  }

  const monthlySavings = Number(streamingReplacement.monthlySavings) || 0;
  if (monthlySavings >= selectedCost) {
    return {
      required: true,
      match: true,
      selectedCost,
      penalty: 0,
      summary: `Ersätter dina valda streamingkostnader (${monthlySavings} kr/mån).`,
      tradeoffs: [],
    };
  }

  if (monthlySavings > 0) {
    return {
      required: true,
      match: false,
      selectedCost,
      penalty: Math.min(selectedCost - monthlySavings, 120),
      summary: `Ersätter ${monthlySavings} kr/mån av dina ${selectedCost} kr/mån i streaming.`,
      tradeoffs: [`All streaming du valde ersätts inte; kvar att väga in är cirka ${selectedCost - monthlySavings} kr/mån.`],
    };
  }

  return {
    required: true,
    match: false,
    selectedCost,
    penalty: Math.min(selectedCost, 120),
    summary: null,
    tradeoffs: [`Ersätter inte dina valda streamingkostnader (${selectedCost} kr/mån).`],
  };
};

const getCurrentMonthlyTotal = (qualification, peopleCount) => {
  if (Number(qualification.familyTotalPrice) > 0) {
    return { amount: Number(qualification.familyTotalPrice), estimated: false };
  }

  const familyRangeMidpoint = FAMILY_PRICE_RANGE_MIDPOINTS[qualification.familyPriceRange] || 0;
  if (familyRangeMidpoint > 0) {
    return { amount: familyRangeMidpoint, estimated: true };
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
  const price = variant?.price || variant || plan.price || {};
  return {
    monthly: Number(price.monthly ?? price.monthlyPrice) || 0,
  };
};

const getPlanFees = (plan = {}) => roundMoney(
  Number(plan.fees?.startFee ?? plan.fees?.activationFee ?? plan.fees?.oneTimeFee ?? plan.startFee) || 0
);

const getPlanAdditionalUserMonthlyPrice = ({ operator = {}, plan = {} }) => Number(
  plan.extraUserPrice?.monthly ?? plan.extraUserPrice?.monthlyPrice ?? operator.additionalUser?.price?.monthly ?? operator.additionalUser?.monthlyPrice
) || 0;

const calculatePlanMonthlyPrice = ({ operator, plan, baseMonthlyPrice, peopleCount }) => {
  const extraUsers = Math.max(peopleCount - 1, 0);
  const additionalUserMonthlyPrice = getPlanAdditionalUserMonthlyPrice({ operator, plan });
  if (extraUsers > 0 && additionalUserMonthlyPrice <= 0) return null;
  return roundMoney(baseMonthlyPrice + extraUsers * additionalUserMonthlyPrice);
};

const getActivePeople = (qualification = {}, peopleCount = 1) => {
  const source = Array.isArray(qualification.people) && qualification.people.length
    ? qualification.people
    : Array.from({ length: peopleCount }, (_, index) => ({
      currentOperator: qualification.operators?.[index] || 'Annan / ingen',
      bindingEnd: qualification.bindingEnds?.[index] || 'Ingen bindningstid',
      currentMonthlyCost: qualification.exactMonthlyPrices?.[index] || qualification.exactMonthlyPrice || 0,
      dataNeed: qualification.mobileUsage,
    }));

  return source.slice(0, peopleCount).filter((person) => person?.excluded !== true);
};

const getMonthsUntil = (bindingEnd, now = new Date()) => {
  const normalized = String(bindingEnd || '').trim();
  if (!normalized || /ingen|no binding/i.test(normalized)) return 0;
  if (/vet inte|don't know|dont know/i.test(normalized)) return Number.POSITIVE_INFINITY;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 0;
  const end = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime()) || end <= now) return 0;
  const years = end.getUTCFullYear() - now.getUTCFullYear();
  const months = end.getUTCMonth() - now.getUTCMonth();
  const dayAdjustment = end.getUTCDate() > now.getUTCDate() ? 1 : 0;
  return Math.max(Math.min(years * 12 + months + dayAdjustment, 120), 0);
};

const getPersonRemainingBindingMonths = (person = {}) => {
  if (person.remainingBindingMonths !== null &&
      person.remainingBindingMonths !== undefined &&
      person.remainingBindingMonths !== '' &&
      Number.isFinite(Number(person.remainingBindingMonths))) {
    return Math.max(Math.round(Number(person.remainingBindingMonths)), 0);
  }
  return getMonthsUntil(person.bindingEnd);
};

const getPersonCurrentMonthlyCost = (person = {}) => roundMoney(
  (Number(person.currentMonthlyCost) || 0) +
  (Number(person.addOnMonthlyCost) || 0) +
  (Number(person.devicePaymentMonthlyCost) || 0)
);

const getPeopleCurrentMonthlyTotal = (people = []) => roundMoney(
  people.reduce((sum, person) => sum + getPersonCurrentMonthlyCost(person), 0)
);

const getRemainingOldCost = (person = {}) => {
  const termMonths = getCalculationTermMonths();
  const remainingBindingMonths = getPersonRemainingBindingMonths(person);
  const noticePeriodMonths = Math.max(Number(person.noticePeriodMonths) || 0, 0);
  const overlapMonths = Math.min(Math.max(remainingBindingMonths, noticePeriodMonths), termMonths);
  const subscriptionMonthly = (Number(person.currentMonthlyCost) || 0) + (Number(person.addOnMonthlyCost) || 0);
  const deviceMonths = Math.min(Number(person.devicePaymentRemainingMonths) || 0, termMonths);
  return roundMoney(subscriptionMonthly * overlapMonths + (Number(person.devicePaymentMonthlyCost) || 0) * deviceMonths);
};

const getGiftCardCustomerStatus = (people = [], operator = {}) => {
  const target = slugify(operator.name || operator.id);
  const statuses = people.map((person) => {
    const current = slugify(person.currentOperator);
    return current === target ? 'same_operator' : 'new_customer';
  });
  const newCustomerCount = statuses.filter((status) => status === 'new_customer').length;
  const sameOperatorCount = statuses.length - newCustomerCount;
  const tier = sameOperatorCount === 0
    ? 'maximum'
    : (newCustomerCount === 0 ? 'lower' : 'mixed');
  return { newCustomerCount, sameOperatorCount, tier };
};

const getGiftCardValue = ({ operator, plan, people }) => {
  const rules = getRules().giftCard || {};
  const placeholderValue = String(plan.giftCard || rules.placeholderValue || 'XXX');
  const label = placeholderValue.match(/\skr$/i) ? placeholderValue : `${placeholderValue} kr`;
  const amount = Math.max(Number(rules.numericValueUntilFinalized) || 0, 0);
  const status = getGiftCardCustomerStatus(people, operator);
  const eligible = status.sameOperatorCount === 0 || rules.sameOperatorEligible !== false;
  const reason = status.tier === 'maximum'
    ? 'Ny kund hos måloperatören: framtida maxnivå för presentkortet.'
    : (status.tier === 'lower'
      ? 'Befintlig kund hos måloperatören: framtida lägre nivå för presentkortet.'
      : 'Gruppen innehåller både nya och befintliga kunder; framtida presentkortsvärde blir blandat.');
  return {
    amount: eligible ? roundMoney(amount) : 0,
    label,
    eligible,
    tier: status.tier,
    newCustomerCount: status.newCustomerCount,
    sameOperatorCount: status.sameOperatorCount,
    reason,
  };
};

const getNumberHandlingNotes = (people = []) => people.map((person, index) => {
  const label = person.label || `Person ${index + 1}`;
  if (person.keepNumberPreference === 'scheduled_port') return `${label}: schemalagd nummerflytt när bindning/uppsägning passar.`;
  if (person.keepNumberPreference === 'new_number') return `${label}: nytt nummer valt.`;
  if (person.keepNumberPreference === 'temporary_number') return `${label}: kan starta med tillfälligt/nytt nummer och flytta senare.`;
  if (person.keepNumberPreference === 'exclude') return `${label}: exkluderas från bytet.`;
  return `${label}: nummerflytt planeras${person.numberOwnerConfirmed ? '' : ', kontrollera nummerägare först'}.`;
});

const splitSwitchPeople = (people = [], operator = {}) => {
  const readyToSwitchMonths = getReadyToSwitchMonths(operator);
  const eligiblePeople = people.filter((person) => person.keepNumberPreference !== 'exclude' && person.excluded !== true);
  const readyPeople = eligiblePeople.filter((person) => getPersonRemainingBindingMonths(person) <= readyToSwitchMonths);
  const delayedPeople = eligiblePeople.filter((person) => getPersonRemainingBindingMonths(person) > readyToSwitchMonths);
  return { eligiblePeople, readyPeople, delayedPeople, readyToSwitchMonths };
};

const getBaseline24MonthCost = ({ qualification, people, peopleCount }) => {
  const termMonths = getCalculationTermMonths();
  const peopleMonthly = getPeopleCurrentMonthlyTotal(people);
  const fallback = getCurrentMonthlyTotal(qualification, peopleCount);
  const monthly = peopleMonthly > 0 ? peopleMonthly : fallback.amount;
  return {
    amount: roundMoney(monthly * termMonths),
    monthly,
    estimated: peopleMonthly <= 0 && fallback.estimated,
  };
};

const createSwitchScenario = ({
  operator,
  plan,
  baseMonthlyPrice,
  qualification,
  participantPeople,
  delayedPeople = [],
  peopleCount,
  streamingReplacement,
  switchAction,
}) => {
  const termMonths = getCalculationTermMonths();
  const participantCount = participantPeople.length;
  if (participantCount <= 0) return null;
  if (participantCount > 1 && plan.familyEligible !== true) return null;
  const minUsers = Math.max(Number(plan.minUsers) || 1, 1);
  const maxUsers = Math.max(Number(plan.maxUsers) || minUsers, minUsers);
  if (participantCount < minUsers || participantCount > maxUsers) return null;
  const requiredDataGb = getRequiredDataGb({ ...qualification, people: participantPeople });
  if (!planMeetsDataNeed({ operator, plan, peopleCount: participantCount, requiredDataGb })) return null;

  const planMonthlyPrice = calculatePlanMonthlyPrice({
    operator,
    plan,
    baseMonthlyPrice,
    peopleCount: participantCount,
  });
  if (!planMonthlyPrice) return null;

  const oldCosts = participantPeople.reduce((sum, person) => sum + getRemainingOldCost(person), 0);
  const fees = getPlanFees(plan);
  const giftCard = getGiftCardValue({ operator, plan, people: participantPeople });
  const streamingSavings24 = roundMoney((Number(streamingReplacement.monthlySavings) || 0) * termMonths);
  const baseline = getBaseline24MonthCost({
    qualification,
    people: participantPeople,
    peopleCount,
  });
  const newCost24 = roundMoney(planMonthlyPrice * termMonths);
  const total24MonthCost = roundMoney(newCost24 + oldCosts + fees - giftCard.amount - streamingSavings24);
  const totalResult = baseline.amount > 0 ? roundMoney(baseline.amount - total24MonthCost) : null;
  const beneficial = totalResult === null ? true : totalResult > 0;

  return {
    switchAction,
    peopleCount: participantCount,
    switchNowPeopleCount: switchAction === 'delay_switch' ? 0 : participantCount,
    delayedPeopleCount: delayedPeople.length,
    excludedPeopleCount: Math.max((qualification.peopleCount || peopleCount) - participantPeople.length - delayedPeople.length, 0),
    delayedPeople: delayedPeople.map((person) => person.label || person.id).filter(Boolean),
    oldCostsDuringOverlap: roundMoney(oldCosts),
    fees,
    giftCardValue: giftCard.amount,
    giftCard: plan.giftCard || 'XXX',
    giftCardLabel: giftCard.label,
    giftCardEligible: giftCard.eligible,
    giftCardTier: giftCard.tier,
    giftCardNewCustomerCount: giftCard.newCustomerCount,
    giftCardSameOperatorCount: giftCard.sameOperatorCount,
    giftCardReason: giftCard.reason,
    streamingSavings24,
    current24MonthCost: baseline.amount,
    currentMonthlyTotal: roundMoney(baseline.monthly),
    currentMonthlyTotalIsEstimate: baseline.estimated,
    new24MonthPlanCost: newCost24,
    total24MonthCost,
    total24MonthResult: totalResult,
    totalResultBeneficial: beneficial,
    numberHandlingNotes: getNumberHandlingNotes(participantPeople),
  };
};

const chooseSwitchScenario = ({
  operator,
  plan,
  baseMonthlyPrice,
  qualification,
  people,
  peopleCount,
  streamingReplacement,
}) => {
  const { eligiblePeople, readyPeople, delayedPeople, readyToSwitchMonths } = splitSwitchPeople(people, operator);
  if (!readyPeople.length) return null;

  if (delayedPeople.length) {
    const partialScenario = createSwitchScenario({
      operator,
      plan,
      baseMonthlyPrice,
      qualification,
      participantPeople: readyPeople,
      delayedPeople,
      peopleCount,
      streamingReplacement,
      switchAction: 'switch_some_now',
    });
    return partialScenario ? { ...partialScenario, salesWindowMonths: readyToSwitchMonths } : null;
  }

  const fullScenario = createSwitchScenario({
    operator,
    plan,
    baseMonthlyPrice,
    qualification,
    participantPeople: eligiblePeople,
    delayedPeople: [],
    peopleCount,
    streamingReplacement,
    switchAction: 'switch_now',
  });
  return fullScenario ? { ...fullScenario, salesWindowMonths: readyToSwitchMonths } : null;
};

const expandPlanVariants = (operator, plan) => {
  if (plan.streaming?.mode !== 'choose_one') return [{ plan, streamingVariant: null }];
  return plan.streaming.options.map((streamingVariant) => ({ plan, streamingVariant }));
};

const buildBenefits = ({ operator, plan, peopleCount, capabilities, includedStreaming }) => [
  plan.data?.type === 'unlimited'
    ? 'Obegränsad data'
    : `${plan.data.gb} GB ${((plan.data?.sharing === 'shared' || operator.familyDataModel === 'shared_on_limited_plans') && peopleCount > 1) ? 'delas i familjen' : 'per användare'}`,
  peopleCount > 1 ? `${peopleCount} användare med tilläggspris` : '',
  capabilities.euEea ? 'Samtal, SMS, MMS och roaming inom EU/EES' : '',
  capabilities.countries ? `Utlandsdata i ${capabilities.countries} länder` : '',
  capabilities.outsideEuLocalCalls ? 'Lokala samtal ingår utomlands' : '',
  capabilities.worldwideFamilyCalls ? 'Fria samtal inom familjen världen över' : '',
  capabilities.euEeaIncludedHours ? `${capabilities.euEeaIncludedHours} samtalstimmar inom EU/EES` : '',
  plan.extraSim?.included ? `Extra SIM med ${plan.extraSim.dataGb} GB ingår` : '',
  includedStreaming.length ? `${includedStreaming.join(', ')} ingår` : '',
].filter(Boolean);

const compareMaybeNumber = (left, right) => {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftValid = Number.isFinite(leftNumber);
  const rightValid = Number.isFinite(rightNumber);
  if (leftValid && rightValid) return leftNumber - rightNumber;
  if (leftValid) return -1;
  if (rightValid) return 1;
  return 0;
};

const buildReasonText = (parts = []) => parts
  .map((part) => String(part || '').trim())
  .filter(Boolean)
  .map((part) => /[.!?]$/.test(part) ? part : `${part}.`)
  .join(' ');

const buildCandidate = ({ operator, plan, streamingVariant, qualification, peopleCount }) => {
  const capabilities = getInternationalCapabilities(operator, plan);
  const travelEvaluation = getTravelEvaluation(capabilities, qualification);

  const prices = getPlanPrices(plan, streamingVariant);
  if (prices.monthly <= 0) return null;

  const bindingMonths = Number(operator.bindingMonths) || 0;
  const includedStreaming = getIncludedStreaming(plan, streamingVariant);
  const streamingReplacement = getStreamingReplacement(includedStreaming, qualification);
  const streamingEvaluation = getStreamingEvaluation({ qualification, streamingReplacement });
  const activePeople = getActivePeople(qualification, peopleCount);
  const scenario = chooseSwitchScenario({
    operator,
    plan,
    baseMonthlyPrice: prices.monthly,
    qualification,
    people: activePeople,
    peopleCount,
    streamingReplacement,
  });
  if (!scenario) return null;

  const planMonthlyPrice = calculatePlanMonthlyPrice({
    operator,
    plan,
    baseMonthlyPrice: prices.monthly,
    peopleCount: scenario.peopleCount,
  });
  if (!planMonthlyPrice) return null;

  const regularMonthlyPlanPrice = planMonthlyPrice;
  const averageMonthlyPlanCost = planMonthlyPrice;
  const effectiveMonthlyCost = Math.max(averageMonthlyPlanCost - streamingReplacement.monthlySavings, 0);
  const total24MonthAdjustedCost = scenario.total24MonthCost + (travelEvaluation.penalty + streamingEvaluation.penalty) * 24;
  const matchAdjustedCost = effectiveMonthlyCost + travelEvaluation.penalty + streamingEvaluation.penalty;
  const monthlySavings = Number.isFinite(Number(scenario.total24MonthResult))
    ? roundMoney(Number(scenario.total24MonthResult) / 24)
    : null;
  const id = streamingVariant
    ? `${plan.id}-${slugify(streamingVariant.service)}`
    : plan.id;
  const dataAmount = plan.data?.type === 'unlimited' ? 999 : Number(plan.data?.gb) || 0;
  const benefits = buildBenefits({
    operator,
    plan,
    peopleCount: scenario.peopleCount,
    capabilities,
    includedStreaming,
  });
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
    peopleCount: scenario.peopleCount,
    totalHouseholdPeople: peopleCount,
    switchNowPeopleCount: scenario.switchNowPeopleCount,
    delayedPeopleCount: scenario.delayedPeopleCount,
    excludedPeopleCount: scenario.excludedPeopleCount,
    delayedPeople: scenario.delayedPeople,
    switchAction: scenario.switchAction,
    additionalUserMonthlyPrice: getPlanAdditionalUserMonthlyPrice({ operator, plan }),
    planMonthlyPrice: roundMoney(planMonthlyPrice),
    monthlyPrice: roundMoney(planMonthlyPrice),
    regularMonthlyPlanPrice: roundMoney(regularMonthlyPlanPrice),
    averageMonthlyPlanCost: roundMoney(averageMonthlyPlanCost),
    pricePerPerson: roundMoney(planMonthlyPrice / scenario.peopleCount),
    effectiveMonthlyCost: roundMoney(effectiveMonthlyCost),
    effectivePricePerPerson: roundMoney(effectiveMonthlyCost / scenario.peopleCount),
    streamingSavings: streamingReplacement.monthlySavings,
    replacedStreamingServices: streamingReplacement.services,
    includedStreamingServices: includedStreaming,
    currentMonthlyTotal: roundMoney(scenario.currentMonthlyTotal),
    currentMonthlyTotalIsEstimate: scenario.currentMonthlyTotalIsEstimate,
    monthlySavings,
    savingsVsStaying: monthlySavings,
    current24MonthCost: scenario.current24MonthCost,
    new24MonthPlanCost: scenario.new24MonthPlanCost,
    remainingOldCosts: scenario.oldCostsDuringOverlap,
    fees: scenario.fees,
    giftCardValue: scenario.giftCardValue,
    giftCard: scenario.giftCard,
    giftCardLabel: scenario.giftCardLabel,
    giftCardEligible: scenario.giftCardEligible,
    giftCardTier: scenario.giftCardTier,
    giftCardNewCustomerCount: scenario.giftCardNewCustomerCount,
    giftCardSameOperatorCount: scenario.giftCardSameOperatorCount,
    giftCardReason: scenario.giftCardReason,
    streamingSavings24: scenario.streamingSavings24,
    total24MonthCost: scenario.total24MonthCost,
    total24MonthAdjustedCost: roundMoney(total24MonthAdjustedCost),
    total24MonthResult: scenario.total24MonthResult,
    totalResultBeneficial: scenario.totalResultBeneficial,
    bindingMonths,
    salesWindowMonths: scenario.salesWindowMonths || getReadyToSwitchMonths(operator),
    international: capabilities,
    benefits,
    reason: buildReasonText([
      scenario.switchAction === 'switch_some_now'
        ? `${scenario.switchNowPeopleCount} kan byta nu; ${scenario.delayedPeopleCount} bör vänta tills bindningen är kortare.`
        : '',
      scenario.switchAction === 'delay_switch'
        ? 'Bytet är inte fördelaktigt just nu, så rekommendationen är att vänta eller exkludera bundna abonnemang.'
        : '',
      [
        `${scenario.peopleCount} ${scenario.peopleCount === 1 ? 'användare' : 'användare'}`,
        plan.data?.type === 'unlimited' ? 'obegränsad data' : `${dataAmount} GB`,
      ].join(', '),
      scenario.giftCardReason,
      scenario.oldCostsDuringOverlap > 0
        ? 'Det kan finnas en gammal kostnad kvar en period, och den är med i bedömningen.'
        : '',
      streamingEvaluation.summary || '',
      travelEvaluation.summary || '',
      ...streamingEvaluation.tradeoffs,
      ...travelEvaluation.tradeoffs,
      ...scenario.numberHandlingNotes,
      'Kontrollera nummerägare, befintliga tillägg, delbetalning på mobil och uppsägningstid innan beställning.',
    ]),
    eligibleForOffer: true,
    matchAdjustedCost: roundMoney(matchAdjustedCost),
    travelMatch: travelEvaluation.match,
    travelScore: travelEvaluation.score,
    travelRequired: travelEvaluation.required,
    streamingMatch: streamingEvaluation.match,
    selectedStreamingCost: streamingEvaluation.selectedCost,
    tradeoffs: [
      ...streamingEvaluation.tradeoffs,
      ...travelEvaluation.tradeoffs,
      ...(scenario.totalResultBeneficial ? [] : ['Byt inte nu om överlappande gammal kostnad äter upp värdet.']),
    ],
  };
};

const compareBestValue = (left, right) => (
  Number(right.totalResultBeneficial) - Number(left.totalResultBeneficial) ||
  compareMaybeNumber(left.total24MonthAdjustedCost, right.total24MonthAdjustedCost) ||
  compareMaybeNumber(left.total24MonthCost, right.total24MonthCost) ||
  compareMaybeNumber(right.total24MonthResult, left.total24MonthResult) ||
  left.matchAdjustedCost - right.matchAdjustedCost ||
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  left.planMonthlyPrice - right.planMonthlyPrice ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const compareOperatorFit = (left, right) => (
  Number(right.totalResultBeneficial) - Number(left.totalResultBeneficial) ||
  Number(right.travelRequired && right.travelMatch) - Number(left.travelRequired && left.travelMatch) ||
  Number(right.streamingMatch) - Number(left.streamingMatch) ||
  compareBestValue(left, right)
);

const compareLowestPrice = (left, right) => (
  left.planMonthlyPrice - right.planMonthlyPrice ||
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const compareTravelFit = (left, right) => (
  Number(right.travelMatch) - Number(left.travelMatch) ||
  right.travelScore - left.travelScore ||
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  left.planMonthlyPrice - right.planMonthlyPrice ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const compareStreamingFit = (left, right) => (
  right.streamingSavings - left.streamingSavings ||
  Number(right.streamingMatch) - Number(left.streamingMatch) ||
  left.effectiveMonthlyCost - right.effectiveMonthlyCost ||
  left.planMonthlyPrice - right.planMonthlyPrice ||
  right.dataAmount - left.dataAmount ||
  left.operator.localeCompare(right.operator, 'sv')
);

const uniqueBestByOperator = (candidates) => {
  const byOperator = new Map();
  [...candidates].sort(compareOperatorFit).forEach((candidate) => {
    if (!byOperator.has(candidate.operatorId)) byOperator.set(candidate.operatorId, candidate);
  });
  return [...byOperator.values()].sort(compareBestValue);
};

const ensureExplicitTradeoffs = (candidates = []) => {
  const lowestPlanMonthlyPrice = Math.min(...candidates.map((candidate) => candidate.planMonthlyPrice));
  return candidates.map((candidate) => {
    if (candidate.tradeoffs.length) return candidate;
    const monthlyDifference = roundMoney(candidate.planMonthlyPrice - lowestPlanMonthlyPrice);
    const tradeoff = monthlyDifference > 0
      ? `Ordinarie månadspriset är ${monthlyDifference.toLocaleString('sv-SE')} kr högre än det billigaste säljbara alternativet som klarar surfbehovet.`
      : 'Detta alternativ prioriterar lägsta ordinarie pris; dyrare alternativ kan innehålla andra förmåner.';
    return {
      ...candidate,
      tradeoffs: [tradeoff],
      reason: buildReasonText([candidate.reason, tradeoff]),
    };
  });
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
  const allCandidates = ensureExplicitTradeoffs(catalog.operators.flatMap((operator) => operator.plans
    .flatMap((plan) => expandPlanVariants(operator, plan)
      .map(({ streamingVariant }) => buildCandidate({
        operator,
        plan,
        streamingVariant,
        qualification,
        peopleCount,
      })))
    .filter(Boolean)));
  const options = uniqueBestByOperator(allCandidates);
  const rules = getRules();
  const bestValue = [...allCandidates].sort(compareBestValue)[0] || null;
  const bestTravelFit = qualification.internationalTravel && qualification.internationalTravel !== 'none'
    ? [...allCandidates].sort(compareTravelFit)[0] || null
    : null;
  const selectedStreamingCost = getSelectedStreamingCost(qualification);
  const bestStreamingFit = selectedStreamingCost > 0
    ? [...allCandidates].filter((candidate) => candidate.streamingSavings > 0).sort(compareStreamingFit)[0] || null
    : null;
  const lowestMonthlyCandidates = [...allCandidates].sort(compareLowestPrice);
  const lowestMonthlyPrice = rules.results?.ifFeaturedWinnersAreIdenticalShowNextBestDistinctAlternative === true
    ? (lowestMonthlyCandidates.find((candidate) => candidate.id !== bestValue?.id) || lowestMonthlyCandidates[0] || null)
    : (lowestMonthlyCandidates[0] || null);

  return {
    readyForOffer: true,
    missingFields: [],
    validOfferAvailable: options.length > 0,
    noOfferReason: options.length
      ? null
      : 'Ingen person är just nu inom måloperatörernas säljfönster eller så matchar inget abonnemang alla angivna behov. Tele2 kräver högst 2 månader kvar; Telia, Telenor och Tre högst 3 månader.',
    bestValue: bestValue ? { ...bestValue, recommendationType: 'best_value' } : null,
    bestTravelFit: bestTravelFit ? { ...bestTravelFit, recommendationType: 'best_travel_fit' } : null,
    bestStreamingFit: bestStreamingFit ? { ...bestStreamingFit, recommendationType: 'best_streaming_fit' } : null,
    lowestMonthlyPrice: lowestMonthlyPrice
      ? { ...lowestMonthlyPrice, recommendationType: 'lowest_monthly_price' }
      : null,
    options: options.map((candidate) => ({
      ...candidate,
      recommendationTypes: [
        candidate.id === bestValue?.id ? 'best_value' : '',
        candidate.id === bestTravelFit?.id ? 'best_travel_fit' : '',
        candidate.id === bestStreamingFit?.id ? 'best_streaming_fit' : '',
        candidate.id === lowestMonthlyPrice?.id ? 'lowest_monthly_price' : '',
      ].filter(Boolean),
    })),
    assumptions: {
      planDataSource: 'data/plans.json',
      recommendationRulesSource: 'data/recommendation-rules.json',
      giftCardRuleSource: 'data/recommendation-rules.json',
      requiredDataGb: getRequiredDataGb(qualification),
      streamingSavingsRule: rules.streaming?.deductOnlyMatchedIncludedServices
        ? 'Only customer-supplied monthly costs for selected services included in the plan are deducted.'
        : 'Streaming savings follow data/recommendation-rules.json.',
      resultRule: rules.calculation?.formula || '24-month new cost + remaining old costs + fees - gift card - matching streaming savings.',
      switchingRule: 'Tele2 accepts orders with at most 2 months remaining; Telia, Telenor, and Tre accept orders with at most 3 months remaining. People outside the target operator window are excluded until eligible.',
      allOperatorsLabel: rules.results?.featured?.find((result) => result.key === 'allOperators')?.label || 'Visa alla operatörer',
      currentMonthlyTotalIsEstimate: getCurrentMonthlyTotal(qualification, peopleCount).estimated,
    },
  };
};

const buildCartItemFromCalculatedOffer = ({ qualification = {}, planId }) => {
  const calculation = calculateOfferOptions(qualification);
  const candidates = [
    calculation.bestValue,
    calculation.bestTravelFit,
    calculation.bestStreamingFit,
    calculation.lowestMonthlyPrice,
    ...calculation.options,
  ].filter(Boolean);
  const option = candidates.find((candidate) => candidate.planId === planId) || calculation.bestValue;

  if (!calculation.readyForOffer || !option) {
    const error = new Error('Qualification is not ready for an offer');
    error.statusCode = 400;
    throw error;
  }

  const rewardTotal = Math.max(Number(option.giftCardValue) || 0, 0);
  const displayMonthlyPrice = option.peopleCount > 1 ? option.pricePerPerson : option.planMonthlyPrice;
  const displayEffectiveMonthlyCost = option.peopleCount > 1 ? option.effectivePricePerPerson : option.effectiveMonthlyCost;
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
    displayMonthlyPrice,
    pricePerPerson: option.pricePerPerson,
    persons: option.peopleCount,
    phoneLines: option.peopleCount,
    productType: option.peopleCount > 1 ? 'family' : 'mobile',
    unitLabel: 'abonnemang',
    rewardTotal,
    giftCard: option.giftCard || 'XXX',
    giftCardLabel: option.giftCardLabel || 'XXX kr',
    rewardMixLabel: `Presentkort: ${option.giftCardLabel || 'XXX kr'}`,
    rewards: rewardTotal ? { Presentkort: rewardTotal } : {},
    answers: { qualification, offerCalculation: option },
    features: [
      ...option.benefits,
      `Effektiv kostnad ${displayEffectiveMonthlyCost.toLocaleString('sv-SE')} kr/${option.peopleCount > 1 ? 'person' : 'mån'}`,
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
