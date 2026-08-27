const CURRENT_OPERATORS = [
  'Telia',
  'Tele2',
  'Telenor',
  'Tre',
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

const STREAMING_SERVICES = ['netflix', 'hbo', 'disney', 'amazon', 'tv4'];

const normalizeOperator = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return CURRENT_OPERATORS.find((operator) => operator.toLowerCase() === normalized.toLowerCase()) ||
    (/annan|andra|annat|ingen|other/i.test(normalized) ? 'Annan / ingen' : normalized.slice(0, 40));
};

const normalizeBindingEnd = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/ingen|no contract|no binding/i.test(normalized)) return 'Ingen bindningstid';
  if (/vet|don't know|dont know/i.test(normalized)) return 'Vet inte';
  return null;
};

const normalizePositiveMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null;
};

const normalizeOptionalNonNegative = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null;
};

const normalizeNeedImportance = (value = {}) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalize = (importance) => ['flexible', 'must_have'].includes(importance) ? importance : null;
  return {
    streaming: normalize(source.streaming),
    outsideEuData: normalize(source.outsideEuData),
    internationalCalls: normalize(source.internationalCalls),
    extraSim: normalize(source.extraSim),
    sharedData: normalize(source.sharedData),
  };
};

const normalizeNonNegativeInteger = (value, fallback = 0) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return fallback;
  return Math.min(Math.round(amount), 120);
};

const normalizeKeepNumber = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (/scheduled|schemalagd|senare|planerad/i.test(normalized)) return 'scheduled_port';
  if (/temporary|tillf|tempor/i.test(normalized)) return 'temporary_number';
  if (/new|nytt|ny/i.test(normalized)) return 'new_number';
  if (/exclude|exklud/i.test(normalized)) return 'exclude';
  if (/no|nej/i.test(normalized)) return 'new_number';
  return 'port_number';
};

const normalizeCoverageLocations = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 5);
  }
  const normalized = String(value || '').trim();
  return normalized ? [normalized.slice(0, 120)] : [];
};

const normalizePerson = (person = {}, index = 0, fallback = {}) => {
  const currentOperator = normalizeOperator(
    person.currentOperator || person.operator || fallback.currentOperator
  ) || 'Annan / ingen';
  const bindingEnd = normalizeBindingEnd(
    person.bindingEnd || person.bindingEnds || person.binding || fallback.bindingEnd
  );
  const dataNeed = ['low', 'medium', 'high'].includes(person.dataNeed || person.mobileUsage)
    ? (person.dataNeed || person.mobileUsage)
    : fallback.dataNeed || null;
  const requiredDataGb = Number(person.requiredDataGb) > 0
    ? Math.round(Number(person.requiredDataGb))
    : null;

  return {
    id: String(person.id || `person-${index + 1}`).slice(0, 40),
    label: String(person.label || `Person ${index + 1}`).slice(0, 80),
    currentOperator,
    currentMonthlyCost: normalizePositiveMoney(
      person.currentMonthlyCost ?? person.monthlyCost ?? person.exactMonthlyPrice ?? fallback.currentMonthlyCost
    ),
    bindingEnd,
    remainingBindingMonths: normalizeNonNegativeInteger(person.remainingBindingMonths, null),
    noticePeriodMonths: normalizeNonNegativeInteger(person.noticePeriodMonths, 0),
    dataNeed,
    requiredDataGb,
    keepNumberPreference: normalizeKeepNumber(person.keepNumberPreference || person.keepNumber),
    mustKeepNumber: person.mustKeepNumber !== false && ['port_number', 'scheduled_port'].includes(normalizeKeepNumber(person.keepNumberPreference || person.keepNumber)),
    numberOwnerConfirmed: person.numberOwnerConfirmed === true,
    hasAddOns: Boolean(person.hasAddOns),
    addOnMonthlyCost: normalizePositiveMoney(person.addOnMonthlyCost ?? person.addonMonthlyCost) || 0,
    devicePaymentMonthlyCost: normalizePositiveMoney(person.devicePaymentMonthlyCost) || 0,
    devicePaymentRemainingMonths: normalizeNonNegativeInteger(person.devicePaymentRemainingMonths, 0),
    coverageLocations: normalizeCoverageLocations(person.coverageLocations),
    existingCustomer: person.existingCustomer !== false && currentOperator !== 'Annan / ingen',
    excluded: normalizeKeepNumber(person.keepNumberPreference || person.keepNumber) === 'exclude' || person.excluded === true,
  };
};

const createEmptyQualification = () => ({
  peopleCount: null,
  operators: [],
  bindingEnds: [],
  mobileUsage: null,
  requiredDataGb: null,
  priceRange: null,
  familyPriceRange: null,
  streamingCalculation: null,
  streamingServices: [],
  streamingMonthlyCosts: {},
  internationalTravel: null,
  internationalUsage: null,
  extraSimRequired: false,
  sharedDataRequired: false,
  needImportance: normalizeNeedImportance(),
  internationalTripsPerYear: null,
  internationalDataPassCost: null,
  internationalCallsMonthlyCost: null,
  extraSimMonthlyCost: null,
  sharedDataMonthlyCost: null,
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  people: [],
  customerSegment: null,
  familyTotalPrice: null,
  readyForOffer: false,
  missingFields: [
    'peopleCount', 'operators', 'bindingEnds', 'mobileUsage', 'priceRange',
    'streamingCalculation', 'internationalTravel',
  ],
});

const normalizeQualification = (qualification = {}) => {
  const recommendationMode = ['initial', 'refined'].includes(qualification.recommendationMode)
    ? qualification.recommendationMode
    : (qualification.initialRecommendation === true || qualification.allowInitialRecommendation === true ? 'initial' : 'refined');
  const peopleCount = Number.isFinite(Number(qualification.peopleCount)) && Number(qualification.peopleCount) > 0
    ? Math.min(Math.round(Number(qualification.peopleCount)), 10)
    : null;
  const rawPeopleInput = Array.isArray(qualification.people) ? qualification.people : [];
  const listedOperators = Array.isArray(qualification.operators)
    ? qualification.operators.map(normalizeOperator).filter(Boolean).slice(0, peopleCount || 10)
    : [];
  const peopleOperators = rawPeopleInput
    .map((person) => normalizeOperator(person?.currentOperator || person?.operator))
    .filter(Boolean)
    .slice(0, peopleCount || 10);
  const rawOperators = peopleCount && listedOperators.length < peopleCount && peopleOperators.length >= peopleCount
    ? peopleOperators
    : listedOperators;
  const listedBindingEnds = Array.isArray(qualification.bindingEnds)
    ? qualification.bindingEnds.map(normalizeBindingEnd).filter(Boolean).slice(0, peopleCount || 10)
    : [];
  const peopleBindingEnds = rawPeopleInput
    .map((person) => normalizeBindingEnd(person?.bindingEnd || person?.bindingEnds || person?.binding))
    .filter(Boolean)
    .slice(0, peopleCount || 10);
  const rawBindingEnds = peopleCount && listedBindingEnds.length < peopleCount && peopleBindingEnds.length >= peopleCount
    ? peopleBindingEnds
    : listedBindingEnds;
  const operators = peopleCount && qualification.operatorAppliesToAll && rawOperators.length === 1
    ? Array.from({ length: peopleCount }, () => rawOperators[0])
    : rawOperators;
  const bindingEnds = peopleCount && qualification.bindingAppliesToAll && rawBindingEnds.length === 1
    ? Array.from({ length: peopleCount }, () => rawBindingEnds[0])
    : rawBindingEnds;
  const mobileUsage = ['low', 'medium', 'high'].includes(qualification.mobileUsage)
    ? qualification.mobileUsage
    : null;
  const requiredDataGb = Number(qualification.requiredDataGb) > 0
    ? Math.round(Number(qualification.requiredDataGb))
    : null;
  const priceRange = ['under300', '300-400', '400-500', 'no_limit'].includes(qualification.priceRange)
    ? qualification.priceRange
    : null;
  const familyPriceRange = ['under1000', '1000-1500', '1500-2000', 'over2000', 'unknown']
    .includes(qualification.familyPriceRange)
    ? qualification.familyPriceRange
    : null;
  const streamingCalculation = ['none', 'include', 'unknown'].includes(qualification.streamingCalculation)
    ? qualification.streamingCalculation
    : null;
  const streamingServices = Array.isArray(qualification.streamingServices)
    ? [...new Set(qualification.streamingServices
      .map((service) => String(service || '').trim().toLowerCase())
      .filter((service) => STREAMING_SERVICES.includes(service)))]
    : [];
  const streamingMonthlyCosts = qualification.streamingMonthlyCosts &&
    typeof qualification.streamingMonthlyCosts === 'object' &&
    !Array.isArray(qualification.streamingMonthlyCosts)
    ? Object.entries(qualification.streamingMonthlyCosts).reduce((result, [service, price]) => {
      const key = String(service || '').trim().toLowerCase();
      const amount = Number(price);
      if (STREAMING_SERVICES.includes(key) && amount > 0) result[key] = Math.round(amount);
      return result;
    }, {})
    : {};
  const internationalTravel = ['none', 'eu', 'outside_eu'].includes(qualification.internationalTravel)
    ? qualification.internationalTravel
    : null;
  const internationalUsage = ['calls', 'data'].includes(qualification.internationalUsage)
    ? qualification.internationalUsage
    : null;
  const extraSimRequired = qualification.extraSimRequired === true;
  const sharedDataRequired = qualification.sharedDataRequired === true;
  const needImportance = normalizeNeedImportance(qualification.needImportance);
  const internationalTripsPerYear = normalizeOptionalNonNegative(qualification.internationalTripsPerYear);
  const internationalDataPassCost = normalizeOptionalNonNegative(qualification.internationalDataPassCost);
  const internationalCallsMonthlyCost = normalizeOptionalNonNegative(qualification.internationalCallsMonthlyCost);
  const extraSimMonthlyCost = normalizeOptionalNonNegative(qualification.extraSimMonthlyCost);
  const sharedDataMonthlyCost = normalizeOptionalNonNegative(qualification.sharedDataMonthlyCost);
  const exactMonthlyPrice = Number(qualification.exactMonthlyPrice) > 0
    ? Math.round(Number(qualification.exactMonthlyPrice))
    : null;
  const rawExactMonthlyPrices = Array.isArray(qualification.exactMonthlyPrices)
    ? qualification.exactMonthlyPrices
      .map(Number)
      .filter((price) => Number.isFinite(price) && price > 0)
      .map(Math.round)
      .slice(0, peopleCount || 10)
    : [];
  const exactMonthlyPrices = peopleCount && qualification.priceAppliesToAll && rawExactMonthlyPrices.length === 1
    ? Array.from({ length: peopleCount }, () => rawExactMonthlyPrices[0])
    : rawExactMonthlyPrices;
  const customerSegment = ['private', 'family', 'student', 'senior', 'youth', 'child', 'business']
    .includes(qualification.customerSegment)
    ? qualification.customerSegment
    : null;
  const familyTotalPrice = Number(qualification.familyTotalPrice) > 0
    ? Math.round(Number(qualification.familyTotalPrice))
    : null;
  const rawPeople = rawPeopleInput;
  const people = (rawPeople.length ? rawPeople : Array.from({ length: peopleCount || 0 }, (_, index) => ({
    currentOperator: operators[index] || 'Annan / ingen',
    bindingEnd: bindingEnds[index] || null,
    currentMonthlyCost: exactMonthlyPrices[index] || exactMonthlyPrice || null,
    dataNeed: mobileUsage,
    requiredDataGb,
    existingCustomer: !(qualification.customerStatus === 'none' || operators[index] === 'Annan / ingen'),
  })))
    .map((person, index) => normalizePerson(person, index, {
      currentOperator: operators[index] || 'Annan / ingen',
      bindingEnd: bindingEnds[index] || null,
      currentMonthlyCost: exactMonthlyPrices[index] || exactMonthlyPrice || null,
      dataNeed: mobileUsage,
    }))
    .slice(0, peopleCount || 10);

  const missingFields = [];
  if (!peopleCount) missingFields.push('peopleCount');
  if (!peopleCount || operators.length < peopleCount) missingFields.push('operators');
  if (!peopleCount || bindingEnds.length < peopleCount) missingFields.push('bindingEnds');
  if (recommendationMode !== 'initial' && !mobileUsage && !requiredDataGb) missingFields.push('mobileUsage');
  const hasAllPersonMonthlyCosts = peopleCount && people
    .slice(0, peopleCount)
    .every((person) => Number(person.currentMonthlyCost) > 0);
  const hasPerPersonPrice = Boolean(
    priceRange ||
    exactMonthlyPrice ||
    (peopleCount && exactMonthlyPrices.length >= peopleCount) ||
    hasAllPersonMonthlyCosts
  );
  if (!hasPerPersonPrice) {
    missingFields.push('priceRange');
  }
  if (!streamingCalculation) missingFields.push('streamingCalculation');
  if (streamingCalculation === 'include' && !streamingServices.length) {
    missingFields.push('streamingServices');
  }
  if (
    streamingCalculation === 'include' &&
    streamingServices.length &&
    streamingServices.some((service) => !streamingMonthlyCosts[service])
  ) {
    missingFields.push('streamingPrices');
  }
  if (!internationalTravel) missingFields.push('internationalTravel');
  if (internationalTravel === 'outside_eu' && !internationalUsage) {
    missingFields.push('internationalUsage');
  }
  if (peopleCount && people.length < peopleCount) missingFields.push('people');

  return {
    peopleCount,
    operators,
    bindingEnds,
    mobileUsage,
    requiredDataGb,
    priceRange,
    familyPriceRange,
    streamingCalculation,
    streamingServices,
    streamingMonthlyCosts,
    internationalTravel,
    internationalUsage,
    extraSimRequired,
    sharedDataRequired,
    needImportance,
    internationalTripsPerYear,
    internationalDataPassCost,
    internationalCallsMonthlyCost,
    extraSimMonthlyCost,
    sharedDataMonthlyCost,
    exactMonthlyPrice,
    exactMonthlyPrices,
    people,
    recommendationMode,
    customerSegment,
    familyTotalPrice,
    operatorAppliesToAll: Boolean(qualification.operatorAppliesToAll),
    bindingAppliesToAll: Boolean(qualification.bindingAppliesToAll),
    priceAppliesToAll: Boolean(qualification.priceAppliesToAll),
    readyForOffer: missingFields.length === 0,
    missingFields,
  };
};

module.exports = {
  createEmptyQualification,
  normalizeQualification,
};
