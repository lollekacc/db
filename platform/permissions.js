const { PlatformError } = require('./errors');

const PERMISSIONS = Object.freeze([
  'overview.view',
  'orders.view', 'orders.create', 'orders.transition', 'orders.export', 'orders.report',
  'customers.view', 'customers.edit',
  'conversations.view', 'conversations.review',
  'catalog.view', 'catalog.configure',
  'rules.view', 'rules.configure', 'rules.approve',
  'gift_cards.view', 'gift_cards.transition', 'gift_cards.approve',
  'finance.view', 'finance.transition', 'finance.reconcile', 'finance.export',
  'support.view', 'support.edit',
  'communications.view', 'communications.send_mock',
  'analytics.view',
  'tasks.view', 'tasks.edit',
  'documents.view', 'documents.generate',
  'integrations.view', 'integrations.test_mock', 'integrations.configure',
  'employees.view', 'employees.configure',
  'compliance.view', 'compliance.process',
  'audit.view', 'audit.export',
  'settings.view', 'settings.configure',
  'sensitive_data.view', 'impersonation.use',
]);

const CANONICAL_ROLE_PERMISSIONS = {
  owner: PERMISSIONS,
  operations_manager: PERMISSIONS.filter((permission) => !permission.startsWith('employees.configure')),
  sales_manager: PERMISSIONS.filter((permission) => /^(overview|orders|customers|conversations|analytics|tasks|documents|sensitive_data\.view)/.test(permission)),
  seller: PERMISSIONS.filter((permission) => /^(overview\.view|orders\.(view|create|transition|report)|customers\.(view|edit)|conversations\.view|tasks|documents\.view|sensitive_data\.view)/.test(permission)),
  finance: PERMISSIONS.filter((permission) => /^(overview|orders\.view|customers\.view|finance|gift_cards|audit\.view)/.test(permission)),
  customer_support: PERMISSIONS.filter((permission) => /^(overview|orders\.view|customers|conversations\.view|support|tasks|documents\.view|sensitive_data\.view)/.test(permission)),
  compliance_gdpr: PERMISSIONS.filter((permission) => /^(overview|orders\.view|customers\.view|conversations\.view|compliance|audit\.view|documents\.view|sensitive_data\.view)/.test(permission)),
  offers_content_manager: PERMISSIONS.filter((permission) => /^(overview|catalog|rules|communications|analytics\.view|documents|settings\.view)/.test(permission)),
  analyst_read_only: PERMISSIONS.filter((permission) =>
    (permission.endsWith('.view') || permission === 'orders.export') && permission !== 'sensitive_data.view'
  ),
  operator_partner: ['orders.view', 'orders.transition', 'finance.view', 'finance.reconcile', 'finance.export', 'documents.view'],
  customer: ['orders.view', 'support.view', 'support.edit', 'documents.view', 'compliance.process'],
};

const ROLE_PERMISSIONS = Object.freeze({
  ...CANONICAL_ROLE_PERMISSIONS,
  // Backward-compatible aliases used by the existing demo fixtures.
  support: CANONICAL_ROLE_PERMISSIONS.customer_support,
  analyst: CANONICAL_ROLE_PERMISSIONS.analyst_read_only,
  partner_operator: CANONICAL_ROLE_PERMISSIONS.operator_partner,
});

const buildDemoUsers = () => ({
  'demo-admin': {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'demo-admin',
    name: 'Alva Admin',
    actorType: 'employee',
    roles: ['owner'],
    permissions: [...PERMISSIONS],
    mockAdmin: true,
  },
  'demo-operations': {
    id: '00000000-0000-4000-8000-000000000002',
    username: 'demo-operations',
    name: 'Oskar Operations',
    actorType: 'employee',
    roles: ['owner'],
    permissions: [...PERMISSIONS],
    mockAdmin: true,
  },
  'demo-customer': {
    id: '00000000-0000-4000-8000-000000000101',
    username: 'demo-customer',
    name: 'Demo Kund',
    actorType: 'customer',
    customerId: '10000000-0000-4000-8000-000000000001',
    roles: ['customer'],
    permissions: [...ROLE_PERMISSIONS.customer],
  },
  'demo-partner-telia': {
    id: '00000000-0000-4000-8000-000000000201',
    username: 'demo-partner-telia',
    name: 'Telia Demo Partner',
    actorType: 'partner',
    partnerOrganizationId: '20000000-0000-4000-8000-000000000001',
    roles: ['partner_operator'],
    permissions: [...ROLE_PERMISSIONS.partner_operator],
  },
  'demo-partner-tele2': {
    id: '00000000-0000-4000-8000-000000000202',
    username: 'demo-partner-tele2',
    name: 'Tele2 Demo Partner',
    actorType: 'partner',
    partnerOrganizationId: '20000000-0000-4000-8000-000000000002',
    roles: ['partner_operator'],
    permissions: [...ROLE_PERMISSIONS.partner_operator],
  },
});

const resolveAuthContext = (request, config, users, audience) => {
  if (!config.demoMode) {
    throw new PlatformError(
      'AUTH_NOT_CONFIGURED',
      'Live authentication is disabled until an OIDC provider is configured',
      503
    );
  }
  const address = request.socket?.remoteAddress;
  if (config.nodeEnv === 'production' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address) ||
      request.headers['x-forwarded-for'] || request.headers.forwarded) {
    throw new PlatformError('DEMO_ACCESS_DENIED', 'Demo identities are available only on this computer', 403);
  }
  const requestedUser = String(request.headers['x-demo-user'] || '').trim();
  const defaultUser = audience === 'admin' ? 'demo-admin' : '';
  const user = users[requestedUser || defaultUser];
  if (!user) throw new PlatformError('UNAUTHENTICATED', 'A valid demo identity is required', 401);
  if (audience === 'admin' && user.actorType !== 'employee') {
    throw new PlatformError('FORBIDDEN', 'This demo identity cannot access the Admin API', 403);
  }
  if (audience === 'customer' && user.actorType !== 'customer') {
    throw new PlatformError('FORBIDDEN', 'This demo identity cannot access the Customer API', 403);
  }
  if (audience === 'partner' && user.actorType !== 'partner') {
    throw new PlatformError('FORBIDDEN', 'This demo identity cannot access the Partner API', 403);
  }
  return Object.freeze({ ...user, demoMode: true });
};

const requirePermission = (actor, permission) => {
  if (!actor?.permissions?.includes(permission)) {
    throw new PlatformError('FORBIDDEN', `Permission required: ${permission}`, 403);
  }
};

module.exports = {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  buildDemoUsers,
  requirePermission,
  resolveAuthContext,
};
