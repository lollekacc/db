const DEFAULT_TERM_MONTHS = 24;

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const hasNonNegativeNumber = (value) => (
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
);

const getReplacementCostForTerm = (need = {}, termMonths = DEFAULT_TERM_MONTHS) => {
  if (hasNonNegativeNumber(need.costForTerm)) return roundMoney(need.costForTerm);
  if (hasNonNegativeNumber(need.monthlyCost)) return roundMoney(Number(need.monthlyCost) * termMonths);
  if (hasNonNegativeNumber(need.yearlyCost)) return roundMoney(Number(need.yearlyCost) * termMonths / 12);
  if (hasNonNegativeNumber(need.occurrencesPerYear) && hasNonNegativeNumber(need.costPerOccurrence)) {
    return roundMoney(Number(need.occurrencesPerYear) * Number(need.costPerOccurrence) * termMonths / 12);
  }
  return null;
};

const evaluateNeeds = (needs = [], termMonths = DEFAULT_TERM_MONTHS) => (
  (Array.isArray(needs) ? needs : []).map((need, index) => {
    const replacementCostForTerm = getReplacementCostForTerm(need, termMonths);
    const covered = need.covered === true;
    return {
      key: String(need.key || `need-${index + 1}`),
      importance: need.importance === 'must_have' ? 'must_have' : 'flexible',
      covered,
      available: need.available === true || covered,
      costKnown: replacementCostForTerm !== null,
      replacementCostForTerm,
      uncoveredCostForTerm: covered ? 0 : replacementCostForTerm,
    };
  })
);

const calculateCost = ({
  newMonthlyCost,
  remainingOldCosts = 0,
  oneTimeFees = 0,
  giftCardValue = 0,
  selectedNeeds = [],
  currentMonthlyCost = 0,
  termMonths = DEFAULT_TERM_MONTHS,
} = {}) => {
  const months = Math.max(Math.round(Number(termMonths) || DEFAULT_TERM_MONTHS), 1);
  const planMonthlyCost = Math.max(Number(newMonthlyCost) || 0, 0);
  const overlapCost = Math.max(Number(remainingOldCosts) || 0, 0);
  const fees = Math.max(Number(oneTimeFees) || 0, 0);
  const giftCard = Math.max(Number(giftCardValue) || 0, 0);
  const currentPlanMonthlyCost = Math.max(Number(currentMonthlyCost) || 0, 0);
  const needs = evaluateNeeds(selectedNeeds, months);
  const uncoveredNeeds = needs.filter((need) => !need.covered);
  const unknownUncoveredNeeds = uncoveredNeeds.filter((need) => !need.costKnown).map((need) => need.key);
  const unknownCurrentNeeds = needs.filter((need) => !need.costKnown).map((need) => need.key);
  const uncoveredNeedsCostForTerm = roundMoney(uncoveredNeeds.reduce(
    (sum, need) => sum + (need.uncoveredCostForTerm || 0),
    0
  ));
  const currentNeedsCostForTerm = roundMoney(needs.reduce(
    (sum, need) => sum + (need.replacementCostForTerm || 0),
    0
  ));
  const matchingNeedsSavingsForTerm = roundMoney(needs
    .filter((need) => need.covered)
    .reduce((sum, need) => sum + (need.replacementCostForTerm || 0), 0));

  const newCostForTerm = roundMoney(planMonthlyCost * months);
  const baseOfferCostForTerm = roundMoney(newCostForTerm + overlapCost + fees - giftCard);
  const knownTotalCostForTerm = roundMoney(
    baseOfferCostForTerm + uncoveredNeedsCostForTerm - matchingNeedsSavingsForTerm
  );
  const totalCostForTerm = unknownUncoveredNeeds.length ? null : knownTotalCostForTerm;
  const effectiveMonthlyCost = totalCostForTerm === null ? null : roundMoney(totalCostForTerm / months);
  const knownCurrentCostForTerm = roundMoney(currentPlanMonthlyCost * months + currentNeedsCostForTerm);
  const currentCostForTerm = unknownCurrentNeeds.length ? null : knownCurrentCostForTerm;
  const savingsForTerm = currentCostForTerm === null || totalCostForTerm === null || currentCostForTerm <= 0
    ? null
    : roundMoney(currentCostForTerm - totalCostForTerm);

  return {
    termMonths: months,
    newMonthlyCost: roundMoney(planMonthlyCost),
    newCostForTerm,
    remainingOldCosts: roundMoney(overlapCost),
    oneTimeFees: roundMoney(fees),
    giftCardValue: roundMoney(giftCard),
    selectedNeeds: needs,
    uncoveredNeeds,
    unknownUncoveredNeeds,
    unknownCurrentNeeds,
    uncoveredNeedsCostForTerm,
    currentNeedsCostForTerm,
    matchingNeedsSavingsForTerm,
    baseOfferCostForTerm,
    knownTotalCostForTerm,
    totalCostForTerm,
    effectiveMonthlyCost,
    currentMonthlyCost: roundMoney(currentPlanMonthlyCost),
    knownCurrentCostForTerm,
    currentCostForTerm,
    savingsForTerm,
    effectiveMonthlySavings: savingsForTerm === null ? null : roundMoney(savingsForTerm / months),
  };
};

module.exports = {
  DEFAULT_TERM_MONTHS,
  calculateCost,
  evaluateNeeds,
  getReplacementCostForTerm,
  roundMoney,
};
