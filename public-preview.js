const previewRoutes = new Map([
  ['/api/health', 'GET'], ['/api/featured-offers', 'GET'],
  ['/api/mobile/plans', 'GET'], ['/api/mobile/operator-offers', 'GET'],
  ['/api/broadband/offers', 'GET'], ['/api/featured-offers/cart-item', 'POST'],
  ['/api/mobile/cart-item', 'POST'], ['/api/broadband/cart-item', 'POST'],
  ['/api/offers/calculate', 'POST'], ['/api/offers/cart-item', 'POST'],
]);

const isPublicPreview = (environment = process.env) => environment.PUBLIC_PREVIEW !== 'false';
const previewAllows = (pathname, method) => previewRoutes.get(pathname) === method;

module.exports = { isPublicPreview, previewAllows };
