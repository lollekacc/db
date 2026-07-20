#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const collectTeliaMarketData = require('./collectors/telia.collector');
const collectTele2MarketData = require('./collectors/tele2.collector');
const collectTelenorMarketData = require('./collectors/telenor.collector');
const collectTreMarketData = require('./collectors/tre.collector');
const { normalizeSnapshots } = require('./normalize-market-data');
const { mergeMarketData } = require('./merge-market-data');

const ROOT_DIR = path.join(__dirname, '..', '..');
const MARKET_DIR = path.join(ROOT_DIR, 'data', 'market');
const RAW_DIR = path.join(MARKET_DIR, 'raw');
const NORMALIZED_DIR = path.join(MARKET_DIR, 'normalized');
const REPORT_DIR = path.join(MARKET_DIR, 'reports');

const collectors = [
  collectTeliaMarketData,
  collectTele2MarketData,
  collectTelenorMarketData,
  collectTreMarketData,
];

const ensureDirs = () => {
  [RAW_DIR, NORMALIZED_DIR, REPORT_DIR].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
};

const timestampForFile = () => new Date().toISOString().replace(/[:.]/g, '-');

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const renderReportMarkdown = ({ runId, fetchedAt, rawSnapshots, normalizedData, mergeReport, applyMode }) => {
  const collectorRows = rawSnapshots.map((snapshot) => (
    `| ${snapshot.operatorId} | ${snapshot.status} | ${snapshot.rawPlans.length} | ${snapshot.sourceUrl || ''} |`
  )).join('\n');
  const missingRows = mergeReport.removedOrMissingPlans.length
    ? mergeReport.removedOrMissingPlans.map((plan) => (
      `| ${plan.operatorId} | ${plan.planId || ''} | ${plan.planName || ''} | ${plan.currentDataStatus || ''} |`
    )).join('\n')
    : '| none | none | none | none |';
  const newRows = mergeReport.newPlans.length
    ? mergeReport.newPlans.map((plan) => (
      `| ${plan.operatorId} | ${plan.planId || ''} | ${plan.planName || ''} |`
    )).join('\n')
    : '| none | none | none |';
  const changedRows = mergeReport.changedPlans.length
    ? mergeReport.changedPlans.map((plan) => (
      `| ${plan.operatorId} | ${plan.planId || ''} | ${plan.planName || ''} | ${plan.changes.map((change) => change.field).join(', ')} |`
    )).join('\n')
    : '| none | none | none | none |';
  const blockedRows = mergeReport.blockedVerifiedOverwrites.length
    ? mergeReport.blockedVerifiedOverwrites.map((plan) => (
      `| ${plan.operatorId} | ${plan.planId || ''} | ${plan.planName || ''} | ${plan.reason} |`
    )).join('\n')
    : '| none | none | none | none |';

  return [
    '# Market Update Report',
    '',
    `Run ID: ${runId}`,
    `Fetched at: ${fetchedAt}`,
    `Apply mode: ${applyMode ? 'enabled' : 'disabled'}`,
    '',
    '## Collector Results',
    '',
    '| Operator | Status | Raw plans | Source URL |',
    '|---|---|---:|---|',
    collectorRows,
    '',
    '## Normalized Output',
    '',
    `- Normalized plans: ${normalizedData.plans.length}`,
    `- Operators: ${normalizedData.operators.map((operator) => operator.operatorId).join(', ')}`,
    '',
    '## Merge Summary',
    '',
    `- New plans: ${mergeReport.counts.newPlans}`,
    `- Changed plans: ${mergeReport.counts.changedPlans}`,
    `- Removed/missing plans: ${mergeReport.counts.removedOrMissingPlans}`,
    `- Blocked verified overwrites: ${mergeReport.counts.blockedVerifiedOverwrites}`,
    `- data/plans.json written: ${mergeReport.appliedChanges.wrotePlansJson ? 'yes' : 'no'}`,
    '',
    '## New Plans',
    '',
    '| Operator | Plan ID | Plan name |',
    '|---|---|---|',
    newRows,
    '',
    '## Changed Plans',
    '',
    '| Operator | Plan ID | Plan name | Changed fields |',
    '|---|---|---|---|',
    changedRows,
    '',
    '## Removed Or Missing Plans',
    '',
    '| Operator | Plan ID | Plan name | Current status |',
    '|---|---|---|---|',
    missingRows,
    '',
    '## Blocked Verified Overwrites',
    '',
    '| Operator | Plan ID | Plan name | Reason |',
    '|---|---|---|---|',
    blockedRows,
    '',
    '## Notes',
    '',
    '- Collectors are placeholders and do not scrape yet.',
    '- Normalized rows are never marked verified automatically.',
    '- `MARKET_APPLY=true` is required before the pipeline can write to `data/plans.json`.',
    '- Even in apply mode, verified rows are not overwritten automatically.',
    '',
  ].join('\n');
};

const main = async () => {
  ensureDirs();

  const runId = timestampForFile();
  const fetchedAt = new Date().toISOString();
  const applyMode = process.env.MARKET_APPLY === 'true';
  const rawSnapshots = [];

  for (const collect of collectors) {
    const snapshot = await collect({ fetchedAt });
    rawSnapshots.push(snapshot);
    writeJson(path.join(RAW_DIR, `${runId}-${snapshot.operatorId}.json`), snapshot);
    writeJson(path.join(RAW_DIR, `latest-${snapshot.operatorId}.json`), snapshot);
  }

  const normalizedData = normalizeSnapshots(rawSnapshots);
  const normalizedPath = path.join(NORMALIZED_DIR, `${runId}-normalized-plans.json`);
  const latestNormalizedPath = path.join(NORMALIZED_DIR, 'latest-normalized-plans.json');
  writeJson(normalizedPath, normalizedData);
  writeJson(latestNormalizedPath, normalizedData);

  const mergeReport = mergeMarketData({
    normalizedData,
    operatorIds: rawSnapshots.map((snapshot) => snapshot.operatorId),
    apply: applyMode,
  });

  const report = {
    runId,
    generatedAt: new Date().toISOString(),
    fetchedAt,
    applyMode,
    rawSnapshotPaths: rawSnapshots.map((snapshot) => path.join(RAW_DIR, `${runId}-${snapshot.operatorId}.json`)),
    normalizedPath,
    latestNormalizedPath,
    collectors: rawSnapshots.map((snapshot) => ({
      operatorId: snapshot.operatorId,
      sourceUrl: snapshot.sourceUrl,
      fetchedAt: snapshot.fetchedAt,
      status: snapshot.status,
      rawPlanCount: snapshot.rawPlans.length,
    })),
    mergeReport,
  };

  const reportPath = path.join(REPORT_DIR, `${runId}-market-update-report.json`);
  const latestReportPath = path.join(REPORT_DIR, 'latest-market-update-report.json');
  const reportMarkdownPath = path.join(REPORT_DIR, `${runId}-market-update-report.md`);
  const latestReportMarkdownPath = path.join(REPORT_DIR, 'latest-market-update-report.md');
  const markdown = renderReportMarkdown({
    runId,
    fetchedAt,
    rawSnapshots,
    normalizedData,
    mergeReport,
    applyMode,
  });

  writeJson(reportPath, report);
  writeJson(latestReportPath, report);
  fs.writeFileSync(reportMarkdownPath, markdown);
  fs.writeFileSync(latestReportMarkdownPath, markdown);

  console.log('Market update pipeline complete');
  console.log(`Apply mode: ${applyMode ? 'enabled' : 'disabled'}`);
  console.log(`Raw snapshots: ${RAW_DIR}`);
  console.log(`Normalized JSON: ${normalizedPath}`);
  console.log(`Report JSON: ${reportPath}`);
  console.log(`Report Markdown: ${reportMarkdownPath}`);
  console.log('');
  console.log(`Collectors run: ${rawSnapshots.length}`);
  console.log(`Normalized plans: ${normalizedData.plans.length}`);
  console.log(`New plans: ${mergeReport.counts.newPlans}`);
  console.log(`Changed plans: ${mergeReport.counts.changedPlans}`);
  console.log(`Removed/missing plans: ${mergeReport.counts.removedOrMissingPlans}`);
  console.log(`Blocked verified overwrites: ${mergeReport.counts.blockedVerifiedOverwrites}`);
  console.log(`data/plans.json written: ${mergeReport.appliedChanges.wrotePlansJson ? 'yes' : 'no'}`);
};

main().catch((error) => {
  console.error('Market update pipeline failed');
  console.error(error);
  process.exitCode = 1;
});
