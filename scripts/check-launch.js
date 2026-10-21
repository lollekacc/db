const fs = require('node:fs');
const path = require('node:path');
const { getPlans, getBroadbandPlans } = require('../offer-service');
const { getFeaturedOffers, buildFeaturedCartItem } = require('../featured-offers');

const companyPath = path.resolve(__dirname, '../../df/assets/company.json');
let company = {};
try { company = JSON.parse(fs.readFileSync(companyPath, 'utf8')); } catch {}
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const companyConfigured = ['legalName', 'organisationNumber', 'supportEmail', 'postalAddress'].every((key) => text(company[key]));
const featured = getFeaturedOffers().filter((offer) => offer.available).map((offer) => buildFeaturedCartItem({ offerId: offer.id }).cartItem);
const offers = [...getPlans().filter((plan) => !plan.isFamilyPlan), ...getBroadbandPlans(), ...featured];
const documentFields = ['agreementSummaryUrl', 'generalTermsUrl', 'specialTermsUrl', 'priceListUrl', 'withdrawalInformationUrl', 'documentId', 'version'];
const documentsConfigured = offers.filter((offer) => documentFields.every((key) => text(offer.operatorDocuments?.[key]))).length;
const checks = [
  { ready: companyConfigured, label: 'Company identity and support configuration', detail: 'Configuration only; registration and inbox delivery still require verification.' },
  { ready: documentsConfigured === offers.length, label: 'Operator document snapshots', detail: `${documentsConfigured}/${offers.length} offers contain all required fields. Approval and backend registry verification are separate requirements.` },
  { ready: process.env.DEMO_MODE === 'false' && process.env.DEALETT_REPOSITORY === 'postgres' && text(process.env.DATABASE_URL) && text(process.env.DEALETT_DATA_ENCRYPTION_KEY), label: 'Live runtime prerequisites', detail: 'Checks presence only. Does not connect to a database or print secrets.' },
  { ready: false, label: 'Live identity, consent and operator acceptance', detail: 'External adapter verification is still required; the current public router has no trusted live identity/consent adapters.' },
  { ready: false, label: 'Partner and reward fulfilment approval', detail: 'Verify commercial agreements, current prices, reward funding and delivery outside this static check.' },
];
console.log('Dealett launch readiness — local configuration audit');
for (const check of checks) console.log(`${check.ready ? 'CONFIGURED' : 'PENDING'}: ${check.label}\n  ${check.detail}`);
console.log(`Newsletter signup: ${process.env.NEWSLETTER_SIGNUP_ENABLED === 'true' ? 'enabled — verify mailing and unsubscribe handling before release' : 'closed until mailing and unsubscribe handling are ready'}`);
console.log('No deployment, external request, order or account change was performed.');
process.exitCode = checks.every((check) => check.ready) ? 0 : 1;
