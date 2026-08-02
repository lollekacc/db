#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PLANS_PATH = path.join(ROOT_DIR, 'data', 'plans.json');

const COMPARISON_FIELDS = [
  'planName',
  'category',
  'segment',
  'dataGb',
  'isUnlimited',
  'monthlyPrice',
  'campaignPrice',
  'campaignMonths',
  'normalPriceAfterCampaign',
  'bindingMonths',
  'noticePeriodMonths',
  'supports5G',
  'supportsEsim',
  'roamingEuGb',
  'speedCapMbps',
  'familyDiscountAvailable',
  'studentDiscountAvailable',
  'seniorDiscountAvailable',
  'youthDiscountAvailable',
  'sourceUrl',
];

const readCurrentPlans = () => JSON.parse(fs.readFileSync(PLANS_PATH, 'utf8'));

const planKey = (plan) => {
  if (plan.planId) return `planId:${plan.planId}`;
  return [
    'fallback',
    plan.operatorId || 'unknown-operator',
    plan.category || 'unknown-category',
    plan.segment || 'unknown-segment',
    String(plan.planName || plan.title || 'unknown-plan').toLowerCase(),
  ].join(':');
};

const valuesEqual = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const getChanges = (currentPlan, nextPlan) => COMPARISON_FIELDS
  .filter((field) => !valuesEqual(currentPlan[field], nextPlan[field]))
  .map((field) => ({
    field,
    currentValue: currentPlan[field] ?? null,
    nextValue: nextPlan[field] ?? null,
  }));

const normalizePlansInput = (normalizedData) => {
  if (Array.isArray(normalizedData)) return normalizedData;
  if (Array.isArray(normalizedData?.plans)) return normalizedData.plans;
  return [];
};

const mergeMarketData = ({
  currentPlans = readCurrentPlans(),
  normalizedData = [],
  operatorIds = [],
  apply = false,
} = {}) => {
  const normalizedPlans = normalizePlansInput(normalizedData);
  if (!Array.isArray(currentPlans) && Array.isArray(currentPlans?.operators)) {
    const catalogPlanCount = currentPlans.operators.reduce((sum, operator) => (
      sum + (Array.isArray(operator.plans) ? operator.plans.length : 0)
    ), 0);
    return {
      generatedAt: new Date().toISOString(),
      applyMode: Boolean(apply),
      sourceProtected: true,
      warning: 'The operator-centric data/plans.json catalog is the runtime source of truth and is not overwritten by the legacy market merge pipeline.',
      scopedOperatorIds: currentPlans.operators.map((operator) => operator.id),
      counts: {
        normalizedPlans: normalizedPlans.length,
        currentPlans: catalogPlanCount,
        newPlans: 0,
        changedPlans: 0,
        removedOrMissingPlans: 0,
        blockedVerifiedOverwrites: normalizedPlans.length,
      },
      newPlans: [],
      changedPlans: [],
      removedOrMissingPlans: [],
      blockedVerifiedOverwrites: normalizedPlans.map((plan) => ({
        operatorId: plan.operatorId || null,
        planId: plan.planId || null,
        reason: 'Legacy normalized market data cannot overwrite the runtime mobile-plan catalog.',
      })),
      appliedChanges: {
        enabled: Boolean(apply),
        wrotePlansJson: false,
        addedPlans: 0,
        updatedPlans: 0,
        removedPlans: 0,
      },
    };
  }
  const normalizedByKey = new Map(normalizedPlans.map((plan) => [planKey(plan), plan]));
  const currentByKey = new Map(currentPlans.map((plan) => [planKey(plan), plan]));
  const scopedOperatorIds = new Set(operatorIds.length
    ? operatorIds
    : normalizedPlans.map((plan) => plan.operatorId).filter(Boolean));

  const newPlans = [];
  const changedPlans = [];
  const blockedVerifiedOverwrites = [];

  normalizedPlans.forEach((nextPlan) => {
    const key = planKey(nextPlan);
    const currentPlan = currentByKey.get(key);

    if (!currentPlan) {
      newPlans.push({
        key,
        operatorId: nextPlan.operatorId,
        planId: nextPlan.planId || null,
        planName: nextPlan.planName || nextPlan.title || null,
      });
      return;
    }

    const changes = getChanges(currentPlan, nextPlan);
    if (!changes.length) return;

    const changeRecord = {
      key,
      operatorId: nextPlan.operatorId,
      planId: nextPlan.planId || currentPlan.planId || null,
      planName: nextPlan.planName || currentPlan.planName || null,
      currentDataStatus: currentPlan.dataStatus || null,
      changes,
    };

    changedPlans.push(changeRecord);
    if (currentPlan.dataStatus === 'verified') {
      blockedVerifiedOverwrites.push({
        ...changeRecord,
        reason: 'Existing plan is verified. Pipeline will not overwrite verified data automatically.',
      });
    }
  });

  const removedOrMissingPlans = currentPlans
    .filter((plan) => scopedOperatorIds.has(plan.operatorId))
    .filter((plan) => !normalizedByKey.has(planKey(plan)))
    .map((plan) => ({
      key: planKey(plan),
      operatorId: plan.operatorId,
      planId: plan.planId || null,
      planName: plan.planName || plan.title || null,
      currentDataStatus: plan.dataStatus || null,
      reason: 'Plan exists in data/plans.json but was not present in the normalized collector output.',
    }));

  let mergedPlans = currentPlans;
  let appliedChanges = {
    enabled: Boolean(apply),
    wrotePlansJson: false,
    addedPlans: 0,
    updatedPlans: 0,
    removedPlans: 0,
  };

  if (apply) {
    const nextPlansByKey = new Map(currentPlans.map((plan) => [planKey(plan), { ...plan }]));

    normalizedPlans.forEach((nextPlan) => {
      const key = planKey(nextPlan);
      const currentPlan = nextPlansByKey.get(key);

      if (!currentPlan) {
        nextPlansByKey.set(key, {
          ...nextPlan,
          dataStatus: nextPlan.dataStatus === 'verified' ? 'placeholder' : (nextPlan.dataStatus || 'placeholder'),
        });
        appliedChanges.addedPlans += 1;
        return;
      }

      if (currentPlan.dataStatus === 'verified') return;

      const changes = getChanges(currentPlan, nextPlan);
      if (!changes.length) return;

      nextPlansByKey.set(key, {
        ...currentPlan,
        ...nextPlan,
        dataStatus: nextPlan.dataStatus === 'verified' ? 'placeholder' : (nextPlan.dataStatus || currentPlan.dataStatus || 'placeholder'),
      });
      appliedChanges.updatedPlans += 1;
    });

    mergedPlans = [...nextPlansByKey.values()];
    fs.writeFileSync(PLANS_PATH, `${JSON.stringify(mergedPlans, null, 2)}\n`);
    appliedChanges.wrotePlansJson = true;
  }

  return {
    generatedAt: new Date().toISOString(),
    applyMode: Boolean(apply),
    scopedOperatorIds: [...scopedOperatorIds],
    counts: {
      normalizedPlans: normalizedPlans.length,
      currentPlans: currentPlans.length,
      newPlans: newPlans.length,
      changedPlans: changedPlans.length,
      removedOrMissingPlans: removedOrMissingPlans.length,
      blockedVerifiedOverwrites: blockedVerifiedOverwrites.length,
    },
    newPlans,
    changedPlans,
    removedOrMissingPlans,
    blockedVerifiedOverwrites,
    appliedChanges,
  };
};

module.exports = {
  COMPARISON_FIELDS,
  mergeMarketData,
  planKey,
};
