const { getPlanCatalog } = require('./offer-service');
const { DEFAULT_TERM_MONTHS, calculateCost, roundMoney } = require('./cost-calculator');
const { selectBestMatches } = require('./best-match');

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

const getCalculationTermMonths = () => DEFAULT_TERM_MONTHS;

const getReadyToSwitchMonths = () => 3;

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

const getSelectedStreamingCost = (qualification = {}) => {
  if (qualification.streamingCalculation !== 'include') return 0;

  const selected = getSelectedStreamingKeys(qualification);
  const costs = getStreamingCosts(qualification);
  return roundMoney([...selected].reduce((sum, service) => sum + (costs[service] || 0), 0));
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return 0;
  const end = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime()) || end <= now) return 0;
  const years = end.getUTCFullYear() - now.getUTCFullYear();
  const months = end.getUTCMonth() - now.getUTCMonth();
  const dayAdjustment = end.getUTCDate() > now.getUTCDate() ? 1 : 0;
  return Math.max(Math.min(years * 12 + months + dayAdjustment, 120), 0);
};

const getPersonRemainingBindingMonths = (person = {}) => {
  if (Number.isFinite(Number(person.remainingBindingMonths))) {
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

const hasDifferentOperator = (people = [], operator = {}) => {
  const target = slugify(operator.name || operator.id);
  return people.some((person) => {
    const current = slugify(person.currentOperator);
    return current && current !== 'annan-ingen' && current !== target;
  });
};

const getGiftCardValue = ({ operator, plan, people }) => {
  const placeholderValue = String(plan.giftCard || 'XXX');
  const label = placeholderValue.match(/\skr$/i) ? placeholderValue : `${placeholderValue} kr`;
  const amount = Math.max(Number(plan.giftCardValue) || Number(placeholderValue) || 0, 0);
  const requiresOperatorChange = plan.giftCardRequiresOperatorChange !== false;
  const eligible = requiresOperatorChange ? hasDifferentOperator(people, operator) : true;
  if (!eligible) {
    return {
      amount: 0,
      label,
      eligible: false,
    };
  }
  return {
    amount: roundMoney(amount),
    label,
    eligible: true,
  };
};

const getNeedImportance = (qualification = {}, key) => (
  qualification.needImportance?.[key] === 'must_have' ? 'must_have' : 'flexible'
);

const getSelectedNeeds = ({ qualification = {}, capabilities = {}, plan = {}, streamingReplacement = {} }) => {
  const needs = [];
  const coveredStreaming = new Set((streamingReplacement.services || []).map((service) => service.key));
  const streamingCosts = getStreamingCosts(qualification);
  if (qualification.streamingCalculation === 'include') {
    getSelectedStreamingKeys(qualification).forEach((service) => {
      needs.push({
        key: `streaming:${service}`,
        importance: getNeedImportance(qualification, 'streaming'),
        covered: coveredStreaming.has(service),
        available: coveredStreaming.has(service),
        monthlyCost: streamingCosts[service] ?? null,
      });
    });
  }
  if (qualification.internationalTravel === 'outside_eu') {
    needs.push({
      key: 'outside_eu_data',
      importance: getNeedImportance(qualification, 'outsideEuData'),
      covered: capabilities.outsideEuData === true,
      available: capabilities.outsideEuData === true,
      occurrencesPerYear: qualification.internationalTripsPerYear,
      costPerOccurrence: qualification.internationalDataPassCost,
    });
  }
  if (qualification.internationalTravel === 'outside_eu' && qualification.internationalUsage === 'calls') {
    needs.push({
      key: 'international_calls',
      importance: getNeedImportance(qualification, 'internationalCalls'),
      covered: capabilities.outsideEuLocalCalls === true,
      available: capabilities.outsideEuLocalCalls === true,
      monthlyCost: qualification.internationalCallsMonthlyCost,
    });
  }
  if (qualification.extraSimRequired === true) {
    const available = plan.extraSim?.available === true || plan.extraSim?.included === true;
    needs.push({
      key: 'extra_sim',
      importance: getNeedImportance(qualification, 'extraSim'),
      covered: plan.extraSim?.included === true,
      available,
      monthlyCost: qualification.extraSimMonthlyCost,
    });
  }
  if (qualification.sharedDataRequired === true) {
    const covered = plan.data?.sharing === 'shared';
    needs.push({
      key: 'shared_data',
      importance: getNeedImportance(qualification, 'sharedData'),
      covered,
      available: covered,
      monthlyCost: qualification.sharedDataMonthlyCost,
    });
  }
  return needs;
};

const splitSwitchPeople = (people = []) => {
  const readyToSwitchMonths = getReadyToSwitchMonths();
  const eligiblePeople = people.filter((person) => person.keepNumberPreference !== 'exclude' && person.excluded !== true);
  const readyPeople = eligiblePeople.filter((person) => getPersonRemainingBindingMonths(person) <= readyToSwitchMonths);
  const delayedPeople = eligiblePeople.filter((person) => getPersonRemainingBindingMonths(person) > readyToSwitchMonths);
  return { eligiblePeople, readyPeople, delayedPeople };
};

const getCurrentCostBaseline = ({ qualification, people, peopleCount }) => {
  const peopleMonthly = getPeopleCurrentMonthlyTotal(people);
  const fallback = getCurrentMonthlyTotal(qualification, peopleCount);
  const monthly = peopleMonthly > 0 ? peopleMonthly : fallback.amount;
  return {
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
  selectedNeeds,
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
  const giftCard = getGiftCardValue({ operator, plan, people: participantPeople });
  const baseline = getCurrentCostBaseline({
    qualification,
    people: participantPeople,
    peopleCount,
  });
  const cost = calculateCost({
    newMonthlyCost: planMonthlyPrice,
    remainingOldCosts: oldCosts,
    oneTimeFees: 0,
    giftCardValue: giftCard.amount,
    selectedNeeds,
    currentMonthlyCost: baseline.monthly,
    termMonths,
  });
  const totalResult = cost.savingsForTerm;
  const beneficial = totalResult === null ? true : totalResult > 0;

  return {
    switchAction,
    peopleCount: participantCount,
    switchNowPeopleCount: switchAction === 'delay_switch' ? 0 : participantCount,
    delayedPeopleCount: delayedPeople.length,
    excludedPeopleCount: Math.max((qualification.peopleCount || peopleCount) - participantPeople.length - delayedPeople.length, 0),
    delayedPeople: delayedPeople.map((person) => person.label || person.id).filter(Boolean),
    oldCostsDuringOverlap: roundMoney(oldCosts),
    fees: cost.oneTimeFees,
    giftCardValue: giftCard.amount,
    giftCard: plan.giftCard || 'XXX',
    giftCardLabel: giftCard.label,
    giftCardEligible: giftCard.eligible,
    streamingSavings24: roundMoney(cost.selectedNeeds
      .filter((need) => need.covered && need.key.startsWith('streaming:'))
      .reduce((sum, need) => sum + (need.replacementCostForTerm || 0), 0)),
    current24MonthCost: cost.currentCostForTerm,
    knownCurrent24MonthCost: cost.knownCurrentCostForTerm,
    currentMonthlyTotal: roundMoney(baseline.monthly),
    currentMonthlyTotalIsEstimate: baseline.estimated,
    new24MonthPlanCost: cost.newCostForTerm,
    total24MonthCost: cost.totalCostForTerm,
    knownTotal24MonthCost: cost.knownTotalCostForTerm,
    effectiveMonthlyCost: cost.effectiveMonthlyCost,
    knownEffectiveMonthlyCost: roundMoney(cost.knownTotalCostForTerm / termMonths),
    uncoveredNeedsCost24: cost.uncoveredNeedsCostForTerm,
    selectedNeeds: cost.selectedNeeds,
    uncoveredNeeds: cost.uncoveredNeeds,
    unknownUncoveredNeeds: cost.unknownUncoveredNeeds,
    total24MonthResult: totalResult,
    totalResultBeneficial: beneficial,
  };
};

const chooseSwitchScenario = ({
  operator,
  plan,
  baseMonthlyPrice,
  qualification,
  people,
  peopleCount,
  selectedNeeds,
}) => {
  const { eligiblePeople, readyPeople, delayedPeople } = splitSwitchPeople(people);
  const fullScenario = createSwitchScenario({
    operator,
    plan,
    baseMonthlyPrice,
    qualification,
    participantPeople: eligiblePeople,
    delayedPeople: [],
    peopleCount,
    selectedNeeds,
    switchAction: delayedPeople.length ? 'switch_all_now_with_overlap' : 'switch_now',
  });

  if (fullScenario && (delayedPeople.length === 0 || fullScenario.totalResultBeneficial)) {
    return fullScenario;
  }

  const readyScenario = createSwitchScenario({
    operator,
    plan,
    baseMonthlyPrice,
    qualification,
    participantPeople: readyPeople,
    delayedPeople,
    peopleCount,
    selectedNeeds,
    switchAction: delayedPeople.length ? 'switch_some_now' : 'switch_now',
  });
  if (readyScenario && readyScenario.totalResultBeneficial) return readyScenario;

  if (fullScenario) {
    return {
      ...fullScenario,
      switchAction: delayedPeople.length ? 'delay_switch' : 'review_before_switch',
      switchNowPeopleCount: 0,
      delayedPeopleCount: delayedPeople.length || fullScenario.peopleCount,
      delayedPeople: (delayedPeople.length ? delayedPeople : eligiblePeople)
        .map((person) => person.label || person.id)
        .filter(Boolean),
      totalResultBeneficial: false,
    };
  }

  return readyScenario;
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
  capabilities.euEea ? 'Samtal, sms och roaming inom EU/EES' : '',
  capabilities.countries ? `Utlandsdata i ${capabilities.countries} länder` : '',
  capabilities.outsideEuLocalCalls ? 'Lokala samtal ingår utomlands' : '',
  capabilities.worldwideFamilyCalls ? 'Fria samtal inom familjen världen över' : '',
  capabilities.euEeaIncludedHours ? `${capabilities.euEeaIncludedHours} samtalstimmar inom EU/EES` : '',
  plan.extraSim?.included ? `Extra SIM med ${plan.extraSim.dataGb} GB ingår` : '',
  includedStreaming.length ? `${includedStreaming.join(', ')} ingår` : '',
].filter(Boolean);

const buildCandidate = ({ operator, plan, streamingVariant, qualification, peopleCount }) => {
  const capabilities = getInternationalCapabilities(operator, plan);

  const prices = getPlanPrices(plan, streamingVariant);
  if (prices.monthly <= 0) return null;

  const bindingMonths = Number(operator.bindingMonths) || 0;
  const includedStreaming = getIncludedStreaming(plan, streamingVariant);
  const streamingReplacement = getStreamingReplacement(includedStreaming, qualification);
  const selectedStreamingCost = getSelectedStreamingCost(qualification);
  const selectedNeeds = getSelectedNeeds({ qualification, capabilities, plan, streamingReplacement });
  const activePeople = getActivePeople(qualification, peopleCount);
  const scenario = chooseSwitchScenario({
    operator,
    plan,
    baseMonthlyPrice: prices.monthly,
    qualification,
    people: activePeople,
    peopleCount,
    selectedNeeds,
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
  const effectiveMonthlyCost = scenario.effectiveMonthlyCost;
  const monthlySavings = scenario.total24MonthResult !== null && Number.isFinite(Number(scenario.total24MonthResult))
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
    dataSharing: plan.data?.sharing || null,
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
    pricePerPerson: roundMoney(planMonthlyPrice / peopleCount),
    effectiveMonthlyCost: effectiveMonthlyCost === null ? null : roundMoney(effectiveMonthlyCost),
    knownEffectiveMonthlyCost: scenario.knownEffectiveMonthlyCost,
    effectivePricePerPerson: effectiveMonthlyCost === null
      ? null
      : roundMoney(effectiveMonthlyCost / peopleCount),
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
    streamingSavings24: scenario.streamingSavings24,
    total24MonthCost: scenario.total24MonthCost,
    knownTotal24MonthCost: scenario.knownTotal24MonthCost,
    uncoveredNeedsCost24: scenario.uncoveredNeedsCost24,
    selectedNeeds: scenario.selectedNeeds,
    uncoveredNeeds: scenario.uncoveredNeeds,
    unknownUncoveredNeeds: scenario.unknownUncoveredNeeds,
    total24MonthResult: scenario.total24MonthResult,
    totalResultBeneficial: scenario.totalResultBeneficial,
    bindingMonths,
    international: capabilities,
    extraSim: {
      available: plan.extraSim?.available === true || plan.extraSim?.included === true,
      included: plan.extraSim?.included === true,
      dataGb: Number(plan.extraSim?.dataGb) || null,
    },
    benefits,
    eligibleForOffer: scenario.totalResultBeneficial,
    selectedStreamingCost,
  };
};

const calculateOfferOptions = (qualification = {}) => {
  if (!qualification.readyForOffer) {
    return {
      readyForOffer: false,
      missingFields: qualification.missingFields || [],
      validOfferAvailable: false,
      bestMatch: null,
      lowestEffectiveCost: null,
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
  const selection = selectBestMatches(allCandidates, qualification);
  const options = selection.options;
  const bestMatch = selection.bestMatch;
  const lowestEffectiveCost = selection.lowestEffectiveCost;
  const bestTravelFit = selection.bestTravelFit;
  const bestStreamingFit = selection.bestStreamingFit;

  return {
    readyForOffer: true,
    missingFields: [],
    validOfferAvailable: options.length > 0,
    noOfferReason: options.length
      ? null
      : 'Inget abonnemang i mobilplansdatan matchar alla angivna behov.',
    bestMatch: bestMatch ? { ...bestMatch, recommendationType: 'best_match' } : null,
    lowestEffectiveCost: lowestEffectiveCost
      ? { ...lowestEffectiveCost, recommendationType: 'lowest_effective_cost' }
      : null,
    bestTravelFit: bestTravelFit ? { ...bestTravelFit, recommendationType: 'best_travel_fit' } : null,
    bestStreamingFit: bestStreamingFit ? { ...bestStreamingFit, recommendationType: 'best_streaming_fit' } : null,
    options: options.map((candidate) => ({
      ...candidate,
      recommendationTypes: [
        candidate.id === bestMatch?.id ? 'best_match' : '',
        candidate.id === bestTravelFit?.id ? 'best_travel_fit' : '',
        candidate.id === bestStreamingFit?.id ? 'best_streaming_fit' : '',
        candidate.id === lowestEffectiveCost?.id ? 'lowest_effective_cost' : '',
      ].filter(Boolean),
    })),
    assumptions: {
      planDataSource: 'data/plans.json',
      requiredDataGb: getRequiredDataGb(qualification),
      calculationId: 'effective_monthly_cost_24_months',
      termMonths: getCalculationTermMonths(),
      readyToSwitchRemainingMonths: getReadyToSwitchMonths(),
      currentMonthlyTotalIsEstimate: getCurrentMonthlyTotal(qualification, peopleCount).estimated,
    },
  };
};

const buildCartItemFromCalculatedOffer = ({ qualification = {}, planId }) => {
  const calculation = calculateOfferOptions(qualification);
  const candidates = [
    calculation.bestMatch,
    calculation.bestTravelFit,
    calculation.bestStreamingFit,
    calculation.lowestEffectiveCost,
    ...calculation.options,
  ].filter(Boolean);
  const option = candidates.find((candidate) => candidate.planId === planId) || calculation.bestMatch;

  if (!calculation.readyForOffer || !option) {
    const error = new Error('Qualification is not ready for an offer');
    error.statusCode = 400;
    throw error;
  }

  const rewardTotal = Math.max(Number(option.giftCardValue) || 0, 0);
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
    giftCard: option.giftCard || 'XXX',
    giftCardLabel: option.giftCardLabel || 'XXX kr',
    rewardMixLabel: `Presentkort: ${option.giftCardLabel || 'XXX kr'}`,
    rewards: rewardTotal ? { Presentkort: rewardTotal } : {},
    answers: { qualification, offerCalculation: option },
    features: [
      ...option.benefits,
      option.effectiveMonthlyCost !== null
        ? `Effektiv kostnad ${option.effectiveMonthlyCost.toLocaleString('sv-SE')} kr/mån`
        : '',
      option.streamingSavings > 0
        ? `Ersatt streaming ${option.streamingSavings.toLocaleString('sv-SE')} kr/mån`
        : '',
      option.total24MonthCost
        ? `24 mån total ${option.total24MonthCost.toLocaleString('sv-SE')} kr`
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
