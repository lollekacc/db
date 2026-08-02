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
  return normalized.slice(0, 40);
};

const createEmptyQualification = () => ({
  peopleCount: null,
  operators: [],
  bindingEnds: [],
  mobileUsage: null,
  requiredDataGb: null,
  priceRange: null,
  streamingCalculation: null,
  streamingServices: [],
  streamingMonthlyCosts: {},
  internationalTravel: null,
  internationalUsage: null,
  exactMonthlyPrice: null,
  exactMonthlyPrices: [],
  customerSegment: null,
  familyTotalPrice: null,
  readyForOffer: false,
  missingFields: ['peopleCount', 'operators', 'bindingEnds', 'mobileUsage', 'priceRange'],
});

const normalizeQualification = (qualification = {}) => {
  const peopleCount = Number.isFinite(Number(qualification.peopleCount)) && Number(qualification.peopleCount) > 0
    ? Math.min(Math.round(Number(qualification.peopleCount)), 10)
    : null;
  const rawOperators = Array.isArray(qualification.operators)
    ? qualification.operators.map(normalizeOperator).filter(Boolean).slice(0, peopleCount || 10)
    : [];
  const rawBindingEnds = Array.isArray(qualification.bindingEnds)
    ? qualification.bindingEnds.map(normalizeBindingEnd).filter(Boolean).slice(0, peopleCount || 10)
    : [];
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
  const priceRange = ['under300', '300-400', '400-500'].includes(qualification.priceRange)
    ? qualification.priceRange
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

  const missingFields = [];
  if (!peopleCount) missingFields.push('peopleCount');
  if (!peopleCount || operators.length < peopleCount) missingFields.push('operators');
  if (!peopleCount || bindingEnds.length < peopleCount) missingFields.push('bindingEnds');
  if (!mobileUsage && !requiredDataGb) missingFields.push('mobileUsage');
  if (!priceRange && !exactMonthlyPrice && !familyTotalPrice && (!peopleCount || exactMonthlyPrices.length < peopleCount)) {
    missingFields.push('priceRange');
  }

  return {
    peopleCount,
    operators,
    bindingEnds,
    mobileUsage,
    requiredDataGb,
    priceRange,
    streamingCalculation,
    streamingServices,
    streamingMonthlyCosts,
    internationalTravel,
    internationalUsage,
    exactMonthlyPrice,
    exactMonthlyPrices,
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
