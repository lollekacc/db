const fs = require('node:fs');
const path = require('node:path');
const { getPlans, getMobileOperatorOffers, getBroadbandOffers, buildMobileCartItem, buildBroadbandCartItem } = require('../offer-service');
const { getFeaturedOffers, buildFeaturedCartItem } = require('../featured-offers');

const frontend = path.resolve(__dirname, '../../df');
const output = path.join(frontend, 'dist', 'public-preview');
const plans = getPlans();
const broadband = getBroadbandOffers();
const featured = getFeaturedOffers();
const operators = Object.fromEntries(['Telia', 'Telenor', 'Tre', 'Tele2'].map(operator => [operator, getMobileOperatorOffers(operator)]));
const carts = {};
for (const plan of plans.filter(plan => !plan.isFamilyPlan && plan.runtimeSellable !== false)) {
  carts[`mobile:${plan.id}:`] = buildMobileCartItem({ planId: plan.id });
  for (const addon of plans.filter(addon => addon.isFamilyPlan && addon.operator === plan.operator && addon.runtimeSellable !== false)) {
    carts[`mobile:${plan.id}:${addon.id}`] = buildMobileCartItem({ planId: plan.id, addonPlanId: addon.id });
  }
}
for (const plan of broadband) carts[`broadband:${plan.id}`] = buildBroadbandCartItem({ planId: plan.id });
for (const offer of featured.filter(offer => offer.available)) carts[`featured:${offer.id}`] = buildFeaturedCartItem({ offerId: offer.id });
const snapshot = { schemaVersion: 1, exampleData: true, generatedAt: new Date().toISOString(), plans, operators, broadband, featured, carts };
fs.writeFileSync(path.join(frontend, 'assets/preview-catalog.json'), `${JSON.stringify(snapshot)}\n`);

fs.mkdirSync(path.dirname(output), { recursive: true });
if (fs.realpathSync(path.dirname(output)) !== path.join(fs.realpathSync(frontend), 'dist') || (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink())) throw new Error('Unsafe preview output directory');
console.log(`Building only the generated preview directory: ${output}`);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output);
const allowedDirectories = ['assets', 'images', 'partials', 'fonts'];
const allowedExtensions = new Set(['.html', '.css', '.js', '.json', '.geojson', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.mp4', '.webm']);
const copyPublic = (source, destination) => {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyPublic(from, to);
    } else if (allowedExtensions.has(path.extname(entry.name))) fs.copyFileSync(from, to);
  }
};
for (const name of allowedDirectories) {
  const source = path.join(frontend, name);
  if (fs.existsSync(source)) { fs.mkdirSync(path.join(output, name)); copyPublic(source, path.join(output, name)); }
}
for (const name of fs.readdirSync(frontend)) {
  if (!fs.statSync(path.join(frontend, name)).isFile() || !['.html', '.css', '.js'].includes(path.extname(name))) continue;
  fs.copyFileSync(path.join(frontend, name), path.join(output, name));
}
const closed = fs.readFileSync(path.join(output, 'forhandsvisning.html'), 'utf8');
for (const name of ['bestallning.html', 'login.html', 'account.html', 'demo-avtalssammanfattning.html']) fs.writeFileSync(path.join(output, name), closed);
fs.writeFileSync(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
fs.writeFileSync(path.join(output, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n  Content-Security-Policy: frame-ancestors \'self\'; base-uri \'self\'; object-src \'none\'\n  X-Robots-Tag: noindex, nofollow\n');
console.log(`Preview built with ${plans.length} mobile catalogue entries, ${broadband.length} broadband examples and ${featured.length} featured examples. No backend, secrets or operator agreement PDFs are included.`);
