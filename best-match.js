const compareText = (left, right) => String(left || '').localeCompare(String(right || ''), 'sv');

const getEffectiveCost = (option = {}) => {
  if (option.effectiveMonthlyCost === null || option.effectiveMonthlyCost === undefined) {
    const known = Number(option.knownEffectiveMonthlyCost);
    return Number.isFinite(known) ? known : Number.POSITIVE_INFINITY;
  }
  const exact = Number(option.effectiveMonthlyCost);
  if (Number.isFinite(exact)) return exact;
  const known = Number(option.knownEffectiveMonthlyCost);
  return Number.isFinite(known) ? known : Number.POSITIVE_INFINITY;
};

const hasUnavailableMustHaveNeed = (option = {}) => (
  (option.selectedNeeds || []).some((need) => (
    need.importance === 'must_have' && need.available !== true && need.covered !== true
  ))
);

const isEligible = (option = {}, qualification = {}) => {
  if (hasUnavailableMustHaveNeed(option)) return false;
  if (qualification.internationalTravel === 'eu' && option.international?.euEea !== true) return false;
  if (qualification.internationalTravel === 'outside_eu' && option.international?.outsideEuData !== true) return false;
  if (
    qualification.internationalTravel === 'outside_eu' &&
    qualification.internationalUsage === 'calls' &&
    option.international?.outsideEuLocalCalls !== true
  ) return false;
  if (
    qualification.extraSimRequired === true &&
    option.extraSim?.available !== true &&
    option.extraSim?.included !== true
  ) return false;
  if (qualification.sharedDataRequired === true && option.dataSharing !== 'shared') return false;
  return true;
};

const compareBestMatch = (qualification = {}) => (left, right) => {
  if (qualification.internationalTravel === 'outside_eu') {
    const countryDifference = (Number(right.international?.countries) || 0) -
      (Number(left.international?.countries) || 0);
    if (countryDifference) return countryDifference;
  }
  if (qualification.extraSimRequired === true) {
    const includedDifference = Number(right.extraSim?.included === true) - Number(left.extraSim?.included === true);
    if (includedDifference) return includedDifference;
    const dataDifference = (Number(right.extraSim?.dataGb) || 0) - (Number(left.extraSim?.dataGb) || 0);
    if (dataDifference) return dataDifference;
  }
  if (qualification.streamingCalculation === 'include') {
    const streamingDifference = (Number(right.streamingSavings) || 0) - (Number(left.streamingSavings) || 0);
    if (streamingDifference) return streamingDifference;
  }
  return getEffectiveCost(left) - getEffectiveCost(right) ||
    (Number(left.planMonthlyPrice) || 0) - (Number(right.planMonthlyPrice) || 0) ||
    (Number(right.dataAmount) || 0) - (Number(left.dataAmount) || 0) ||
    compareText(left.operator, right.operator) ||
    compareText(left.planId, right.planId);
};

const compareLowestEffectiveCost = (left, right) => (
  getEffectiveCost(left) - getEffectiveCost(right) ||
  (Number(left.planMonthlyPrice) || 0) - (Number(right.planMonthlyPrice) || 0) ||
  (Number(left.dataAmount) || 0) - (Number(right.dataAmount) || 0) ||
  compareText(left.operator, right.operator) ||
  compareText(left.planId, right.planId)
);

const decorateMatch = (option = {}) => {
  const matchedCapabilities = [];
  if (option.international?.outsideEuData) matchedCapabilities.push('outside_eu_data');
  if (option.international?.outsideEuLocalCalls) matchedCapabilities.push('local_calls_abroad');
  if (option.extraSim?.included) matchedCapabilities.push('extra_sim_included');
  else if (option.extraSim?.available) matchedCapabilities.push('extra_sim_available');
  if (option.dataSharing === 'shared') matchedCapabilities.push('shared_data');
  if (Number(option.streamingSavings) > 0) matchedCapabilities.push('streaming_replacement');

  return {
    ...option,
    match: {
      matchedCapabilities,
      internationalDataCountries: Number(option.international?.countries) || 0,
      internationalDataGb: Number(option.international?.internationalDataGb) || null,
      extraSimIncluded: option.extraSim?.included === true,
      extraSimAvailable: option.extraSim?.available === true,
      streamingSavings: Number(option.streamingSavings) || 0,
    },
  };
};

const bestPerOperator = (candidates, compare) => {
  const operators = new Map();
  [...candidates].sort(compare).forEach((candidate) => {
    const key = candidate.operatorId || candidate.operator;
    if (!operators.has(key)) operators.set(key, candidate);
  });
  return [...operators.values()].sort(compare);
};

const selectBestMatches = (candidates = [], qualification = {}) => {
  const eligible = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => isEligible(candidate, qualification))
    .map(decorateMatch);
  const compare = compareBestMatch(qualification);
  const options = bestPerOperator(eligible, compare);
  const bestMatch = options[0] || null;
  const lowestEffectiveCost = [...eligible].sort(compareLowestEffectiveCost)[0] || null;
  const bestTravelFit = qualification.internationalTravel && qualification.internationalTravel !== 'none'
    ? [...eligible].sort(compare)[0] || null
    : null;
  const bestStreamingFit = qualification.streamingCalculation === 'include'
    ? [...eligible]
      .filter((option) => Number(option.streamingSavings) > 0)
      .sort((left, right) => (
        (Number(right.streamingSavings) || 0) - (Number(left.streamingSavings) || 0) || compare(left, right)
      ))[0] || null
    : null;

  return {
    eligible,
    options,
    bestMatch,
    lowestEffectiveCost,
    bestTravelFit,
    bestStreamingFit,
  };
};

module.exports = {
  selectBestMatches,
};
