#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const readJson = (fileName) => JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
);

const operators = readJson('operators.json');
const plans = readJson('plans.json');
const partnerOffers = readJson('partner-offers.json');
const recommendationRules = readJson('recommendation-rules.json');

const errors = [];
const allowedCatalogOperators = new Set(['telia', 'telenor', 'tele2', 'tre']);
const forbiddenCampaignFields = [
  'monthlyPrice',
  'regularMonthlyPrice',
  'campaignPrice',
  'campaignMonthlyPrice',
  'campaignMonths',
  'campaignPeriodMonths',
  'normalPriceAfterCampaign',
  'regularPriceAfterCampaign',
  'temporaryPrice',
  'temporaryCampaign',
  'campaign',
  'campaigns',
];

const hasOwn = (object, field) => Object.prototype.hasOwnProperty.call(object, field);

const rejectForbiddenFields = (object, prefix) => {
  if (!object || typeof object !== 'object') return;
  forbiddenCampaignFields.forEach((field) => {
    if (hasOwn(object, field)) errors.push(`${prefix} must not contain campaign field ${field}`);
  });
};

const validatePlanCatalog = (catalog) => {
  const operatorIds = new Set();
  const planIds = new Set();

  if (!recommendationRules || recommendationRules.sourceOfTruth !== 'mobile-recommendation-rules') {
    errors.push('recommendation-rules.json must define mobile-recommendation-rules as sourceOfTruth');
  }
  if (!(Number(recommendationRules.calculation?.termMonths) > 0)) {
    errors.push('recommendation-rules.json calculation.termMonths must be positive');
  }
  if (recommendationRules.giftCard?.placeholderValue !== 'XXX') {
    errors.push('recommendation-rules.json giftCard.placeholderValue must be XXX');
  }

  catalog.operators.forEach((operator, operatorIndex) => {
    const prefix = `plans.operators[${operatorIndex}]`;
    rejectForbiddenFields(operator, prefix);
    ['id', 'name', 'bindingMonths', 'euEeaRoamingCallsSmsIncluded', 'familyDataModel', 'additionalUser', 'plans']
      .forEach((field) => {
        if (!hasOwn(operator, field)) errors.push(`${prefix} missing ${field}`);
      });
    if (!allowedCatalogOperators.has(operator.id)) errors.push(`${prefix}.id must be Telia, Telenor, Tele2 or Tre`);
    if (operatorIds.has(operator.id)) errors.push(`duplicate operator id ${operator.id}`);
    operatorIds.add(operator.id);
    if (!Array.isArray(operator.plans) || !operator.plans.length) errors.push(`${prefix}.plans must be a non-empty array`);
    if (!(Number(operator.additionalUser?.price?.monthly ?? operator.additionalUser?.monthlyPrice) > 0)) {
      errors.push(`${prefix}.additionalUser.price.monthly must be positive`);
    }

    (operator.plans || []).forEach((plan, planIndex) => {
      const planPrefix = `${prefix}.plans[${planIndex}]`;
      rejectForbiddenFields(plan, planPrefix);
      rejectForbiddenFields(plan.price, `${planPrefix}.price`);
      ['id', 'name', 'data', 'familyEligible', 'giftCard', 'minUsers', 'maxUsers', 'roaming', 'internationalCalls', 'streaming', 'extraUserPrice'].forEach((field) => {
        if (!hasOwn(plan, field)) errors.push(`${planPrefix} missing ${field}`);
      });
      if (planIds.has(plan.id)) errors.push(`duplicate plan id ${plan.id}`);
      planIds.add(plan.id);
      if (plan.giftCard !== 'XXX') errors.push(`${planPrefix}.giftCard must be XXX`);
      if (!(Number(plan.minUsers) >= 1)) errors.push(`${planPrefix}.minUsers must be at least 1`);
      if (!(Number(plan.maxUsers) >= Number(plan.minUsers))) errors.push(`${planPrefix}.maxUsers must be greater than or equal to minUsers`);
      if (!['limited', 'unlimited'].includes(plan.data?.type)) errors.push(`${planPrefix}.data.type is invalid`);
      if (plan.data?.type === 'limited' && !(Number(plan.data.gb) > 0)) errors.push(`${planPrefix}.data.gb must be positive`);
      if (!['per_user', 'shared'].includes(plan.data?.sharing)) errors.push(`${planPrefix}.data.sharing must be per_user or shared`);
      const hasPrice = Number(plan.price?.monthly) > 0;
      const hasStreamingPrices = plan.streaming?.mode === 'choose_one' &&
        Array.isArray(plan.streaming.options) &&
        plan.streaming.options.every((option) => option.service && Number(option.price?.monthly ?? option.monthlyPrice) > 0);
      if (!hasPrice && !hasStreamingPrices) errors.push(`${planPrefix} must define a monthly price`);
      if (!['none', 'choose_one', 'included_bundle'].includes(plan.streaming?.mode)) errors.push(`${planPrefix}.streaming.mode is invalid`);
      if (!(Number(plan.extraUserPrice?.monthly) >= 0)) errors.push(`${planPrefix}.extraUserPrice.monthly must be zero or positive`);
      if (typeof plan.roaming?.euEeaIncluded !== 'boolean') errors.push(`${planPrefix}.roaming.euEeaIncluded must be boolean`);
      if (typeof plan.roaming?.outsideEuDataIncluded !== 'boolean') errors.push(`${planPrefix}.roaming.outsideEuDataIncluded must be boolean`);
      if (typeof plan.roaming?.localCallsIncludedAbroad !== 'boolean') errors.push(`${planPrefix}.roaming.localCallsIncludedAbroad must be boolean`);
      if (typeof plan.internationalCalls?.freeCallsWithinFamilyWorldwide !== 'boolean') errors.push(`${planPrefix}.internationalCalls.freeCallsWithinFamilyWorldwide must be boolean`);
    });
  });
};

if (plans && !Array.isArray(plans) && Array.isArray(plans.operators)) {
  validatePlanCatalog(plans);
  if (errors.length) {
    console.error('Mobile plan catalog validation failed:');
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log('Mobile plan catalog validation passed');
  }
  return;
}

const operatorRequiredFields = [
  'operatorId',
  'name',
  'brandType',
  'networkUsed',
  'customerSegments',
  'supports5G',
  'supportsEsim',
  'hasFamilyPlans',
  'hasStudentPlans',
  'hasSeniorPlans',
  'hasYouthPlans',
  'hasChildPlans',
  'hasBusinessPlans',
  'websiteUrl',
  'sourceUrls',
  'lastChecked',
  'dataStatus',
  'notes',
];

const planRequiredFields = [
  'planId',
  'operatorId',
  'planName',
  'category',
  'segment',
  'dataGb',
  'isUnlimited',
  'monthlyPrice',
  'campaignPrice',
  'campaignMonths',
  'normalPriceAfterCampaign',
  'totalCostFirst12Months',
  'totalCostFirst24Months',
  'bindingMonths',
  'noticePeriodMonths',
  'startFee',
  'simFee',
  'includesCallsSms',
  'supports5G',
  'supportsEsim',
  'roamingEuGb',
  'speedCapMbps',
  'saveUnusedData',
  'familyDiscountAvailable',
  'supportsFamilySharing',
  'maxFamilyMembers',
  'extraSimAvailable',
  'studentDiscountAvailable',
  'seniorDiscountAvailable',
  'youthDiscountAvailable',
  'childPlan',
  'bundleDiscountAvailable',
  'includedStreaming',
  'internationalCallingIncluded',
  'fairUsePolicy',
  'sourceUrl',
  'lastChecked',
  'dataStatus',
  'notes',
];

const offerRequiredFields = [
  'partnerOfferId',
  'operatorId',
  'planId',
  'dealettRewardAmount',
  'dealettRewardType',
  'isActive',
  'priority',
  'sourceUrl',
  'notes',
];

const allowedDataStatuses = new Set(['placeholder', 'verified', 'stale']);
const allowedRewardTypes = new Set(['gift_card', 'cashback', 'none']);
const operatorIds = new Set(operators.map((operator) => operator.operatorId));
const planIds = new Set(plans.map((plan) => plan.planId));

operators.forEach((operator, index) => {
  operatorRequiredFields.forEach((field) => {
    if (!hasOwn(operator, field)) errors.push(`operators[${index}] missing required field ${field}`);
  });

  if (!Array.isArray(operator.customerSegments)) {
    errors.push(`operator ${operator.operatorId || index} customerSegments must be an array`);
  }

  if (!Array.isArray(operator.sourceUrls)) {
    errors.push(`operator ${operator.operatorId || index} sourceUrls must be an array`);
  }

  if (!operator.lastChecked) {
    errors.push(`operator ${operator.operatorId || index} lastChecked is required`);
  }

  if (!allowedDataStatuses.has(operator.dataStatus)) {
    errors.push(`operator ${operator.operatorId || index} has invalid dataStatus`);
  }
});

plans.forEach((plan, index) => {
  planRequiredFields.forEach((field) => {
    if (!hasOwn(plan, field)) errors.push(`plans[${index}] missing required field ${field}`);
  });

  if (!operatorIds.has(plan.operatorId)) {
    errors.push(`plan ${plan.planId || index} references missing operatorId ${plan.operatorId}`);
  }

  if (plan.dataStatus === 'verified' && !plan.sourceUrl) {
    errors.push(`plan ${plan.planId || index} cannot be verified without sourceUrl`);
  }

  if (!plan.lastChecked) {
    errors.push(`plan ${plan.planId || index} lastChecked is required`);
  }

  if (plan.campaignPrice !== null && plan.campaignPrice !== undefined && !plan.campaignMonths) {
    errors.push(`plan ${plan.planId || index} campaignPrice cannot exist without campaignMonths`);
  }

  if (plan.campaignPrice !== null && plan.campaignPrice !== undefined && !plan.normalPriceAfterCampaign) {
    errors.push(`plan ${plan.planId || index} normalPriceAfterCampaign should exist if campaignPrice exists`);
  }

  if (plan.isUnlimited === true && plan.dataGb !== null) {
    errors.push(`plan ${plan.planId || index} dataGb must be null if isUnlimited is true`);
  }

  if (!Array.isArray(plan.includedStreaming)) {
    errors.push(`plan ${plan.planId || index} includedStreaming must be an array`);
  }

  if (!allowedDataStatuses.has(plan.dataStatus)) {
    errors.push(`plan ${plan.planId || index} has invalid dataStatus`);
  }
});

partnerOffers.forEach((offer, index) => {
  offerRequiredFields.forEach((field) => {
    if (!hasOwn(offer, field)) errors.push(`partnerOffers[${index}] missing required field ${field}`);
  });

  if (!operatorIds.has(offer.operatorId)) {
    errors.push(`partner offer ${offer.partnerOfferId || index} references missing operatorId ${offer.operatorId}`);
  }

  if (!planIds.has(offer.planId)) {
    errors.push(`partner offer ${offer.partnerOfferId || index} references missing planId ${offer.planId}`);
  }

  if (!allowedRewardTypes.has(offer.dealettRewardType)) {
    errors.push(`partner offer ${offer.partnerOfferId || index} has invalid dealettRewardType`);
  }
});

if (errors.length) {
  console.error('Market data validation failed:');
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log('Market data validation passed');
}
