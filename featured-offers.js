const { randomUUID } = require('node:crypto');
const { buildMobileCartItem, getPlans } = require('./offer-service');
const definitions = require('./data/featured-offers.json');

const unavailable = () => Object.assign(new Error('Erbjudandet är inte tillgängligt just nu.'), { statusCode: 404 });

const buildFeaturedCartItem = ({ offerId } = {}) => {
  const offer = definitions.find((entry) => entry.id === offerId);
  if (!offer) throw unavailable();
  const plan = getPlans().find((entry) => entry.id === offer.planId && entry.runtimeSellable && !entry.isFamilyPlan);
  if (!plan || plan.operator !== offer.operator || !Number.isInteger(offer.persons) || offer.persons < 1
    || offer.persons > plan.maxUsers || (offer.persons > 1 && !plan.familyEligible)) throw unavailable();
  const extraCount = offer.persons - 1;
  const addon = extraCount ? getPlans().find((entry) => entry.id === offer.addonPlanId
    && entry.operator === plan.operator && entry.isFamilyPlan && entry.runtimeSellable) : null;
  if (extraCount && !addon) throw unavailable();
  const result = buildMobileCartItem({ planId: plan.id });
  const addonPrice = extraCount ? Number(plan.extraUserPrice?.monthly ?? addon.addonPrice ?? addon.price) : 0;
  const price = Number(plan.price) + extraCount * addonPrice;
  const rewardTotal = Number(offer.rewardTotal);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(rewardTotal) || rewardTotal < 0) throw unavailable();
  const rewardMixLabel = `Presentkort: ${rewardTotal.toLocaleString('sv-SE')} kr`;
  Object.assign(result.cartItem, {
    cartItemId: randomUUID(),
    offerId: offer.id,
    sourcePlanId: plan.id,
    featuredOfferId: offer.id,
    price,
    monthlyPrice: price,
    regularMonthlyPrice: price,
    minimumTotalCost: price * plan.bindingMonths,
    persons: offer.persons,
    phoneLines: offer.persons,
    productType: extraCount ? 'family' : 'mobile',
    pricePerPerson: extraCount ? Math.round(price / offer.persons) : 0,
    rewardTotal,
    rewardMixLabel,
    rewards: rewardTotal ? { Presentkort: rewardTotal } : {},
    addon: addon ? { id: addon.id, title: addon.title, quantity: extraCount, price: addonPrice, addonPrice } : null,
    features: [...result.cartItem.features, ...(extraCount ? [`${extraCount} extra användare à ${addonPrice.toLocaleString('sv-SE')} kr/mån`] : [])],
  });
  result.state.persons = offer.persons;
  result.state.wishes = [extraCount ? 'Familjabonnemang' : 'Mobilabonnemang'];
  return result;
};

const getFeaturedOffers = () => definitions.map(({ id }) => {
  try {
    const { cartItem } = buildFeaturedCartItem({ offerId: id });
    return { id, available: true, operator: cartItem.operator, title: cartItem.title, persons: cartItem.persons,
      logo: cartItem.logo, features: cartItem.features.filter(feature => !feature.includes("extra användare")),
      monthlyPrice: cartItem.monthlyPrice, bindingMonths: cartItem.bindingMonths, rewardTotal: cartItem.rewardTotal };
  } catch (error) {
    if (error.statusCode !== 404) throw error;
    return { id, available: false };
  }
});

const isFeaturedOffer = (id) => definitions.some((offer) => offer.id === id);

module.exports = { buildFeaturedCartItem, getFeaturedOffers, isFeaturedOffer };
