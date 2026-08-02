#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { getPlans } = require('../offer-service');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const REPORT_DIR = path.join(ROOT_DIR, 'reports');
const JSON_REPORT_PATH = path.join(REPORT_DIR, 'market-verification-report.json');
const MD_REPORT_PATH = path.join(REPORT_DIR, 'market-verification-report.md');

const readJson = (fileName) => JSON.parse(
  fs.readFileSync(path.join(DATA_DIR, fileName), 'utf8')
);

const operators = readJson('operators.json');
const plans = getPlans();
const checklist = readJson('market-verification-checklist.json');

const hasOwn = (object, field) => Object.prototype.hasOwnProperty.call(object, field);
const hasValue = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== '';
};

const operatorById = new Map(operators.map((operator) => [operator.operatorId, operator]));

const planLabel = (plan) => [
  plan.operatorId || 'unknown-operator',
  plan.planId || plan.id || 'unknown-plan',
  plan.planName || plan.title || 'unnamed plan',
].join(' / ');

const moneyIsMissing = (plan) => !Number.isFinite(Number(plan.monthlyPrice));

const categoryIsExpected = (operator, category) => {
  if (category.required === true) return true;
  const flags = Array.isArray(category.requiredIfAnyOperatorFlag)
    ? category.requiredIfAnyOperatorFlag
    : [];
  return flags.some((flag) => operator?.[flag] === true);
};

const categoryPlanMatches = (plan, category) => {
  const planCategories = Array.isArray(category.planCategories) ? category.planCategories : [];
  const segments = Array.isArray(category.segments) ? category.segments : [];
  return planCategories.includes(plan.category) && segments.includes(plan.segment);
};

const findPlansForCategory = (operatorId, category) => plans.filter((plan) => (
  plan.operatorId === operatorId && categoryPlanMatches(plan, category)
));

const missingRequiredPlanFields = plans
  .map((plan) => ({
    planId: plan.planId || plan.id || null,
    operatorId: plan.operatorId || null,
    missingFields: checklist.requiredPlanFields.filter((field) => !hasOwn(plan, field)),
  }))
  .filter((item) => item.missingFields.length > 0);

const missingPrices = plans
  .filter(moneyIsMissing)
  .map((plan) => ({
    planId: plan.planId || plan.id || null,
    operatorId: plan.operatorId || null,
    planName: plan.planName || plan.title || null,
    category: plan.category || null,
    segment: plan.segment || null,
  }));

const missingPlanSourceUrls = plans
  .filter((plan) => !hasValue(plan.sourceUrl))
  .map((plan) => ({
    planId: plan.planId || plan.id || null,
    operatorId: plan.operatorId || null,
    planName: plan.planName || plan.title || null,
  }));

const missingOperatorSourceUrls = checklist.operators
  .map((item) => operatorById.get(item.operatorId))
  .filter(Boolean)
  .filter((operator) => !hasValue(operator.sourceUrls))
  .map((operator) => ({
    operatorId: operator.operatorId,
    name: operator.name,
  }));

const missingLastChecked = [
  ...plans
    .filter((plan) => !hasValue(plan.lastChecked))
    .map((plan) => ({
      type: 'plan',
      id: plan.planId || plan.id || null,
      operatorId: plan.operatorId || null,
      name: plan.planName || plan.title || null,
    })),
  ...checklist.operators
    .map((item) => operatorById.get(item.operatorId))
    .filter(Boolean)
    .filter((operator) => !hasValue(operator.lastChecked))
    .map((operator) => ({
      type: 'operator',
      id: operator.operatorId,
      operatorId: operator.operatorId,
      name: operator.name,
    })),
];

const placeholderRows = {
  operators: checklist.operators
    .map((item) => operatorById.get(item.operatorId))
    .filter(Boolean)
    .filter((operator) => operator.dataStatus === 'placeholder')
    .map((operator) => ({
      operatorId: operator.operatorId,
      name: operator.name,
    })),
  plans: plans
    .filter((plan) => plan.dataStatus === 'placeholder')
    .map((plan) => ({
      planId: plan.planId || plan.id || null,
      operatorId: plan.operatorId || null,
      planName: plan.planName || plan.title || null,
    })),
};

const cannotVerifyYet = plans
  .filter((plan) => (
    plan.dataStatus !== 'verified' ||
    !hasValue(plan.sourceUrl) ||
    !hasValue(plan.lastChecked)
  ))
  .map((plan) => ({
    planId: plan.planId || plan.id || null,
    operatorId: plan.operatorId || null,
    planName: plan.planName || plan.title || null,
    reasons: [
      plan.dataStatus !== 'verified' ? `dataStatus is ${plan.dataStatus || 'missing'}` : null,
      !hasValue(plan.sourceUrl) ? 'sourceUrl missing' : null,
      !hasValue(plan.lastChecked) ? 'lastChecked missing' : null,
    ].filter(Boolean),
  }));

const categoryCoverage = checklist.operators.map((checkOperator) => {
  const operator = operatorById.get(checkOperator.operatorId);
  const categories = checkOperator.categories.map((category) => {
    const expected = categoryIsExpected(operator, category);
    const matchingPlans = findPlansForCategory(checkOperator.operatorId, category);
    return {
      categoryId: category.categoryId,
      label: category.label,
      expected,
      planCount: matchingPlans.length,
      matchingPlanIds: matchingPlans.map((plan) => plan.planId || plan.id || null),
      status: expected
        ? (matchingPlans.length ? 'covered_placeholder_or_verified' : 'missing')
        : (matchingPlans.length ? 'unexpected_plan_present' : 'not_expected_by_current_operator_flags'),
    };
  });
  return {
    operatorId: checkOperator.operatorId,
    name: checkOperator.name,
    operatorFound: Boolean(operator),
    categories,
  };
});

const incompleteCategoryCoverage = categoryCoverage
  .map((operator) => ({
    operatorId: operator.operatorId,
    name: operator.name,
    missingCategories: operator.categories
      .filter((category) => category.expected && category.status === 'missing')
      .map((category) => ({
        categoryId: category.categoryId,
        label: category.label,
      })),
  }))
  .filter((operator) => operator.missingCategories.length > 0);

const report = {
  generatedAt: new Date().toISOString(),
  scope: checklist.operators.map((operator) => operator.operatorId),
  rules: checklist.rules,
  requiredPlanFields: checklist.requiredPlanFields,
  missingRequiredPlanFields,
  missingPrices,
  missingSourceUrls: {
    operators: missingOperatorSourceUrls,
    plans: missingPlanSourceUrls,
  },
  missingLastChecked,
  placeholderRows,
  cannotVerifyYet,
  categoryCoverage,
  incompleteCategoryCoverage,
};

const renderList = (items, emptyText, formatter) => {
  if (!items.length) return `- ${emptyText}`;
  return items.map(formatter).join('\n');
};

const renderMarkdown = () => {
  const incompleteRows = incompleteCategoryCoverage.flatMap((operator) => (
    operator.missingCategories.map((category) => (
      `| ${operator.name} | ${category.label} | ${category.categoryId} |`
    ))
  ));

  return [
    '# Market Verification Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Scope',
    '',
    checklist.operators.map((operator) => `- ${operator.name}`).join('\n'),
    '',
    '## Rules',
    '',
    checklist.rules.map((rule) => `- ${rule}`).join('\n'),
    '',
    '## Missing Prices',
    '',
    renderList(missingPrices, 'No missing monthlyPrice values found.', (plan) => (
      `- ${plan.operatorId} / ${plan.planId}: ${plan.planName}`
    )),
    '',
    '## Missing Source URLs',
    '',
    '### Operators',
    '',
    renderList(missingOperatorSourceUrls, 'No operator sourceUrls missing.', (operator) => (
      `- ${operator.operatorId}: ${operator.name}`
    )),
    '',
    '### Plans',
    '',
    renderList(missingPlanSourceUrls, 'No plan sourceUrl values missing.', (plan) => (
      `- ${plan.operatorId} / ${plan.planId}: ${plan.planName}`
    )),
    '',
    '## Missing lastChecked',
    '',
    renderList(missingLastChecked, 'No missing lastChecked values found.', (item) => (
      `- ${item.type} / ${item.operatorId} / ${item.id}: ${item.name}`
    )),
    '',
    '## Placeholder Rows',
    '',
    `- Operators: ${placeholderRows.operators.length}`,
    `- Plans: ${placeholderRows.plans.length}`,
    '',
    '## Plans That Cannot Be Verified Yet',
    '',
    renderList(cannotVerifyYet, 'No blocked plan rows found.', (plan) => (
      `- ${plan.operatorId} / ${plan.planId}: ${plan.planName} (${plan.reasons.join(', ')})`
    )),
    '',
    '## Operators With Incomplete Category Coverage',
    '',
    '| Operator | Missing category | Category ID |',
    '|---|---|---|',
    incompleteRows.length ? incompleteRows.join('\n') : '| none | none | none |',
    '',
    '## Required Plan Fields Readiness',
    '',
    renderList(missingRequiredPlanFields, 'Every current plan row has the required verification fields.', (item) => (
      `- ${item.operatorId} / ${item.planId}: missing ${item.missingFields.join(', ')}`
    )),
    '',
  ].join('\n');
};

fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.writeFileSync(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(MD_REPORT_PATH, renderMarkdown());

console.log('Market verification report generated');
console.log(`JSON: ${JSON_REPORT_PATH}`);
console.log(`Markdown: ${MD_REPORT_PATH}`);
console.log('');
console.log(`Missing prices: ${missingPrices.length}`);
console.log(`Missing plan source URLs: ${missingPlanSourceUrls.length}`);
console.log(`Missing operator source URLs: ${missingOperatorSourceUrls.length}`);
console.log(`Missing lastChecked: ${missingLastChecked.length}`);
console.log(`Placeholder plan rows: ${placeholderRows.plans.length}`);
console.log(`Plans that cannot be verified yet: ${cannotVerifyYet.length}`);
console.log(`Operators with incomplete category coverage: ${incompleteCategoryCoverage.length}`);

if (incompleteCategoryCoverage.length) {
  console.log('');
  console.log('Incomplete categories:');
  incompleteCategoryCoverage.forEach((operator) => {
    const labels = operator.missingCategories.map((category) => category.label).join(', ');
    console.log(`- ${operator.name}: ${labels}`);
  });
}
