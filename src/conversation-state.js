const hasValue = (value) => value !== null && value !== undefined && value !== '';

const mergeQualificationState = (current = {}, analyzed = {}) => {
  const merged = { ...current };
  const scalarFields = [
    'peopleCount', 'mobileUsage', 'requiredDataGb', 'priceRange', 'familyPriceRange',
    'streamingCalculation', 'internationalTravel', 'internationalUsage',
    'extraSimRequired', 'sharedDataRequired', 'exactMonthlyPrice',
    'internationalTripsPerYear', 'internationalDataPassCost',
    'internationalCallsMonthlyCost', 'extraSimMonthlyCost', 'sharedDataMonthlyCost',
    'customerSegment', 'familyTotalPrice', 'recommendationMode',
  ];
  const arrayFields = [
    'people', 'operators', 'bindingEnds', 'streamingServices', 'exactMonthlyPrices',
  ];

  scalarFields.forEach((field) => {
    if (hasValue(analyzed[field])) merged[field] = analyzed[field];
  });
  arrayFields.forEach((field) => {
    if (Array.isArray(analyzed[field]) && analyzed[field].length) merged[field] = analyzed[field];
  });
  if (analyzed.streamingMonthlyCosts && Object.values(analyzed.streamingMonthlyCosts).some(hasValue)) {
    merged.streamingMonthlyCosts = {
      ...(current.streamingMonthlyCosts || {}),
      ...analyzed.streamingMonthlyCosts,
    };
  }
  if (analyzed.needImportance && Object.values(analyzed.needImportance).some(hasValue)) {
    merged.needImportance = {
      ...(current.needImportance || {}),
      ...Object.fromEntries(Object.entries(analyzed.needImportance).filter(([, value]) => hasValue(value))),
    };
  }

  merged.operatorAppliesToAll = Boolean(current.operatorAppliesToAll || analyzed.operatorAppliesToAll);
  merged.bindingAppliesToAll = Boolean(current.bindingAppliesToAll || analyzed.bindingAppliesToAll);
  merged.priceAppliesToAll = Boolean(current.priceAppliesToAll || analyzed.priceAppliesToAll);

  if (new Set(merged.operators || []).size > 1) merged.operatorAppliesToAll = false;
  if (new Set(merged.bindingEnds || []).size > 1) merged.bindingAppliesToAll = false;
  return merged;
};

module.exports = {
  mergeQualificationState,
};
