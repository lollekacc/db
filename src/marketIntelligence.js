const fs = require('node:fs');
const path = require('node:path');
const { getPlans } = require('../offer-service');

const DATA_DIR = path.join(__dirname, '..', 'data');

const readJson = (fileName) => JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
);

const operators = readJson('operators.json');
const marketRules = readJson('market-rules.json');

const normalizeId = (value) => String(value || '').trim().toLowerCase();

const getOperatorById = (operatorId) => {
  const normalized = normalizeId(operatorId);
  if (!normalized) return null;
  return operators.find((operator) => operator.operatorId === normalized) || null;
};

const getPlansByOperator = (operatorId) => {
  const normalized = normalizeId(operatorId);
  if (!normalized) return [];
  return getPlans().filter((plan) => normalizeId(plan.operatorId) === normalized && !plan.isFamilyPlan);
};

const getPlansBySegment = (segment) => {
  const normalized = normalizeId(segment);
  if (!normalized) return [];
  const plans = getPlans().filter((plan) => !plan.isFamilyPlan);
  if (normalized === 'family') return plans.filter((plan) => plan.familyEligible === true);
  if (normalized === 'private') return plans;
  return [];
};

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const hasPositiveNumber = (value) => {
  if (value === null || value === undefined || value === '') return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
};

const getRangeBucket = ({ dataGb, isUnlimited }) => {
  if (isUnlimited) {
    return marketRules.heuristicMarketRanges.find((range) => range.isUnlimited) || null;
  }

  const gb = Number(dataGb);
  if (!Number.isFinite(gb)) return null;

  return marketRules.heuristicMarketRanges.find((range) => (
    !range.isUnlimited &&
    gb >= Number(range.dataGbMin || 0) &&
    gb <= Number(range.dataGbMax || 0)
  )) || null;
};

const estimateMarketRange = ({ dataGb = null, isUnlimited = false, segment = 'private' } = {}) => {
  const bucket = getRangeBucket({ dataGb, isUnlimited });
  if (!bucket) {
    return {
      min: null,
      max: null,
      suspiciousBelow: null,
      probablyNotSellableBelow: null,
      confidence: 0.2,
      dataStatus: marketRules.dataStatus,
      reason: 'Missing or unsupported data amount for market-range estimate.',
    };
  }

  const segmentKey = normalizeId(segment) || 'private';
  const multiplier = Number(marketRules.segmentAdjustments?.[segmentKey]) || 1;

  return {
    min: roundMoney(bucket.realisticMonthlyMin * multiplier),
    max: roundMoney(bucket.realisticMonthlyMax * multiplier),
    suspiciousBelow: roundMoney(bucket.suspiciousBelow * multiplier),
    probablyNotSellableBelow: roundMoney(bucket.probablyNotSellableBelow * multiplier),
    rangeId: bucket.rangeId,
    confidence: marketRules.dataStatus === 'verified' ? 0.8 : 0.55,
    dataStatus: marketRules.dataStatus,
    reason: `${bucket.description} Segment adjustment: ${segmentKey}.`,
  };
};

const hasKnownException = (claim = {}) => Boolean(
  claim.isCampaignPrice ||
  claim.campaignMonths ||
  claim.familyBundle ||
  claim.sharedPlan ||
  claim.studentDiscount ||
  claim.seniorDiscount ||
  claim.youthDiscount ||
  claim.childPlan ||
  claim.employerPaid ||
  claim.oldRetainedContract ||
  claim.bundledDiscount ||
  claim.winbackOffer
);

const baseQuestions = [
  'Är priset ett kampanjpris eller ordinarie pris?',
  'Hur länge gäller priset och vad blir priset efter kampanjen?',
  'Ingår priset i ett familje-/delat abonnemang?',
  'Är det student-, senior-, ungdoms- eller barnrabatt?',
  'Betalas hela eller delar av abonnemanget av arbetsgivare?',
  'Är det ett äldre behållet avtal, paketpris eller winback-erbjudande?'
];

const getClarifyingQuestions = (customerClaim = {}) => {
  const questions = [];

  if (!hasPositiveNumber(customerClaim.claimedPrice)) {
    questions.push('Vad betalar du per månad per abonnemang idag?');
  }
  if (!customerClaim.isUnlimited && !Number.isFinite(Number(customerClaim.dataGb))) {
    questions.push('Hur mycket surf ingår per månad, eller är det obegränsad surf?');
  }
  if (customerClaim.isCampaignPrice && !hasPositiveNumber(customerClaim.campaignMonths)) {
    questions.push('Hur många månader gäller kampanjpriset?');
  }
  if (customerClaim.isCampaignPrice && !hasPositiveNumber(customerClaim.normalPriceAfterCampaign)) {
    questions.push('Vad blir ordinarie pris efter kampanjen?');
  }
  if (customerClaim.segment && !marketRules.segments.includes(customerClaim.segment)) {
    questions.push('Vilken kundtyp gäller priset för: privat, familj, student, senior, ungdom, barn eller företag?');
  }

  if (!questions.length) return baseQuestions.slice(0, 4);
  return [...questions, ...baseQuestions].filter((question, index, list) => list.indexOf(question) === index).slice(0, 6);
};

const classifyCustomerClaim = (customerClaim = {}) => {
  const claimedPrice = Number(customerClaim.claimedPrice);
  const segment = customerClaim.segment || 'private';
  const operator = getOperatorById(customerClaim.operatorId);
  const range = estimateMarketRange({
    dataGb: customerClaim.dataGb,
    isUnlimited: Boolean(customerClaim.isUnlimited),
    segment,
  });
  const nextQuestions = getClarifyingQuestions(customerClaim);

  if (!Number.isFinite(claimedPrice) || claimedPrice < 0) {
    return {
      status: 'human_review',
      confidence: 0.35,
      reason: 'Claimed monthly price is missing or invalid.',
      recommendedResponse: 'Jag behöver veta ungefärligt månadspris innan jag kan bedöma om Dealett kan slå avtalet.',
      nextQuestions,
    };
  }

  if (claimedPrice === 0) {
    return {
      status: 'probably_not_sellable',
      confidence: 0.9,
      reason: 'Customer claims a free subscription price, which is an exceptional deal Dealett should not try to beat automatically.',
      recommendedResponse: 'Det låter som ett extremt starkt undantagsavtal. Då kan det faktiskt vara bättre att behålla det tills vidare.',
      nextQuestions,
    };
  }

  if (
    customerClaim.isCampaignPrice &&
    (!hasPositiveNumber(customerClaim.campaignMonths) || !hasPositiveNumber(customerClaim.normalPriceAfterCampaign))
  ) {
    return {
      status: 'possible_needs_clarification',
      confidence: 0.75,
      reason: 'Customer gave a campaign price but campaign length or normal price is missing.',
      recommendedResponse: 'Det kan absolut vara ett kampanjpris. För att jämföra rätt behöver jag en kampanjuppgift till.',
      nextQuestions,
    };
  }

  if (!range.min || !range.max) {
    return {
      status: 'human_review',
      confidence: 0.4,
      reason: `Missing market range for this claim.${operator ? '' : ' Operator is unknown or not in the market reference.'}`,
      recommendedResponse: 'Jag saknar tillräcklig marknadsdata för att bedöma priset tryggt. Jag kan ställa några frågor och sedan jämföra försiktigt.',
      nextQuestions,
    };
  }

  if (customerClaim.canDealettBeat === false && claimedPrice <= range.suspiciousBelow) {
    return {
      status: 'probably_not_sellable',
      confidence: 0.85,
      reason: 'Customer claims a price below the placeholder range and Dealett is marked as unable to beat it.',
      recommendedResponse: 'Om priset stämmer är det troligen redan ett väldigt starkt avtal. Då ska Dealett inte pressa fram ett byte, utan hjälpa dig kontrollera villkoren.',
      nextQuestions,
    };
  }

  if (claimedPrice <= range.probablyNotSellableBelow && hasKnownException(customerClaim)) {
    return {
      status: 'probably_not_sellable',
      confidence: 0.8,
      reason: 'Claim is exceptionally low and has a plausible exception such as family, student, employer or winback context.',
      recommendedResponse: 'Det låter som ett undantagserbjudande. Om villkoren stämmer kan det vara bättre att behålla det än att byta.',
      nextQuestions,
    };
  }

  if (claimedPrice < range.suspiciousBelow) {
    return {
      status: hasKnownException(customerClaim) ? 'possible_needs_clarification' : 'suspicious_low',
      confidence: hasKnownException(customerClaim) ? 0.7 : 0.78,
      reason: 'Claim is far below the placeholder market range, but possible exceptions must be checked.',
      recommendedResponse: 'Det är ovanligt lågt jämfört med normal marknadsnivå. Jag säger inte att det är fel, men jag behöver veta om det är kampanj, familjepris, rabatt, arbetsgivare eller winback.',
      nextQuestions,
    };
  }

  if (claimedPrice < range.min) {
    return {
      status: 'possible_needs_clarification',
      confidence: 0.68,
      reason: 'Claim is below the placeholder range but not impossible.',
      recommendedResponse: 'Det priset kan vara möjligt, särskilt med rabatt eller kampanj. Jag behöver bara förstå villkoren innan jag jämför.',
      nextQuestions,
    };
  }

  if (claimedPrice <= range.max) {
    return {
      status: 'realistic',
      confidence: 0.72,
      reason: 'Claim is inside the placeholder market range.',
      recommendedResponse: 'Det låter som en rimlig nivå. Jag kan jämföra om Dealett kan förbättra helheten efter surf, bindningstid, totalpris och presentkort.',
      nextQuestions: [],
    };
  }

  return {
    status: 'realistic',
    confidence: 0.62,
    reason: 'Claim is above the placeholder range, but high current prices are believable and safe to compare.',
    recommendedResponse: 'Det låter högre än normal placeholder-nivå. Då är det rimligt att jämföra om Dealett kan hitta en bättre total.',
    nextQuestions: [],
  };
};

const shouldContinueSalesAttempt = (customerClaim = {}) => {
  const classification = classifyCustomerClaim(customerClaim);
  return !['probably_not_sellable'].includes(classification.status);
};

module.exports = {
  classifyCustomerClaim,
  estimateMarketRange,
  getClarifyingQuestions,
  getOperatorById,
  getPlansByOperator,
  getPlansBySegment,
  shouldContinueSalesAttempt,
};
