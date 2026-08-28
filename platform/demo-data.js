const { buildDemoUsers } = require('./permissions');
const { hashObject, sha256 } = require('./utils');

const DEMO_CLOCK = '2026-08-28T10:00:00.000Z';

const partnerOrganizations = [
  { id: '20000000-0000-4000-8000-000000000001', slug: 'telia', name: 'Telia', demo: true },
  { id: '20000000-0000-4000-8000-000000000002', slug: 'tele2', name: 'Tele2', demo: true },
  { id: '20000000-0000-4000-8000-000000000003', slug: 'telenor', name: 'Telenor', demo: true },
  { id: '20000000-0000-4000-8000-000000000004', slug: 'tre', name: 'Tre', demo: true },
];

const customers = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    displayName: 'Demo Kund',
    email: 'demo.kund@example.invalid',
    phone: '+46700000001',
    language: 'sv',
    classification: 'fictional_demo',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    displayName: 'Mira Exempel',
    email: 'mira.exempel@example.invalid',
    phone: '+46700000002',
    language: 'sv',
    classification: 'fictional_demo',
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    displayName: 'Alex Sample',
    email: 'alex.sample@example.invalid',
    phone: '+46700000003',
    language: 'en',
    classification: 'fictional_demo',
  },
];

const seedConversations = () => {
  const messages = [
    {
      id: '31000000-0000-4000-8000-000000000001',
      sequence: 1,
      role: 'user',
      content: 'Vi är två personer och vill jämföra familjeabonnemang.',
      structuredContent: null,
      language: 'sv',
      createdAt: '2026-08-26T08:14:10.000Z',
    },
    {
      id: '31000000-0000-4000-8000-000000000002',
      sequence: 2,
      role: 'assistant',
      content: 'Vilka operatörer har ni i dag och när slutar bindningstiderna?',
      structuredContent: { simulated: true, source: 'demo_seed' },
      language: 'sv',
      createdAt: '2026-08-26T08:14:13.000Z',
      model: 'demo-simulated',
    },
    {
      id: '31000000-0000-4000-8000-000000000003',
      sequence: 3,
      role: 'user',
      content: 'Tele2 och Telia, båda utan bindningstid.',
      structuredContent: null,
      language: 'sv',
      createdAt: '2026-08-26T08:15:02.000Z',
    },
  ];
  return [{
    id: '30000000-0000-4000-8000-000000000001',
    publicTokenHash: sha256('demo-conversation-token'),
    customerId: customers[0].id,
    language: 'sv',
    status: 'completed',
    sourcePage: '/mobilabonnemang.html',
    createdAt: '2026-08-26T08:14:00.000Z',
    updatedAt: '2026-08-26T08:15:02.000Z',
    archivedAt: null,
    messages,
  }];
};

const makeOrder = ({ index, operator, customer, status, operatorStatus, commissionStatus, giftCardStatus, amountMinor, giftMinor }) => {
  const operatorEntry = partnerOrganizations.find((entry) => entry.name === operator);
  const id = `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const createdAt = `2026-08-${String(20 + index).padStart(2, '0')}T09:0${index}:00.000Z`;
  const snapshot = {
    catalogVersion: 'legacy-schema-v1',
    ruleVersion: 'demo-rules-v1',
    campaignVersion: 'demo-campaign-v1',
    selectedOffer: {
      planId: `${operator.toLowerCase()}-demo-plan`,
      operator,
      title: index % 2 ? 'Obegränsad' : '25 GB',
      monthlyPriceMinor: amountMinor,
      currency: 'SEK',
      bindingMonths: 24,
      benefits: ['Fria samtal och sms', '5G'],
      giftCardValueMinor: giftMinor,
    },
    calculation: {
      calculationId: 'effective_monthly_cost_24_months',
      termMonths: 24,
      monthlyPriceMinor: amountMinor,
      giftCardValueMinor: giftMinor,
    },
    qualification: { peopleCount: index === 2 ? 2 : 1, demo: true },
  };
  return {
    id,
    orderNumber: `DLT-2026-${String(index).padStart(6, '0')}`,
    publicReference: `DEMO-${String(index).padStart(6, '0')}`,
    source: 'demo_seed',
    customerId: customer.id,
    customer: { ...customer },
    partnerOrganizationId: operatorEntry.id,
    operator,
    planName: snapshot.selectedOffer.title,
    status,
    operatorStatus,
    commissionStatus,
    giftCardStatus,
    supportStatus: 'none',
    version: 1,
    createdAt,
    submittedAt: createdAt,
    updatedAt: createdAt,
    monthlyValueMinor: amountMinor,
    giftCardValueMinor: giftMinor,
    subscriptionCount: index === 2 ? 2 : 1,
    participants: [{
      id: `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      label: 'Huvudabonnemang',
      phoneNumberMasked: '07*-*** **01',
      numberHandling: 'port_number',
    }],
    consents: [{
      type: 'dealett_terms',
      documentVersion: 'demo-terms-v1',
      accepted: true,
      acceptedAt: createdAt,
      evidence: { mode: 'demo', simulated: true },
    }],
    attribution: { source: 'demo', medium: 'seed', campaign: 'operations-platform' },
    snapshot,
    snapshotHash: hashObject(snapshot),
    conversationArchive: null,
    statusHistories: {
      order: [{ from: null, to: status, reason: 'Demo seed', at: createdAt, actorId: 'system' }],
      operator: [{ from: null, to: operatorStatus, reason: 'Demo seed', at: createdAt, actorId: 'system' }],
      commission: [{ from: null, to: commissionStatus, reason: 'Demo seed', at: createdAt, actorId: 'system' }],
      giftCard: [{ from: null, to: giftCardStatus, reason: 'Demo seed', at: createdAt, actorId: 'system' }],
    },
    commissionLedger: [{
      id: `42000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: commissionStatus === 'paid' ? 'payment' : 'expectation',
      amountMinor: Math.round(amountMinor * 1.5),
      currency: 'SEK',
      simulated: true,
      createdAt,
    }],
    giftCardLedger: giftMinor ? [{
      id: `43000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      type: 'entitlement',
      amountMinor: giftMinor,
      currency: 'SEK',
      simulated: true,
      createdAt,
    }] : [],
    reports: [],
    notes: [],
    tasks: [],
  };
};

const buildDemoState = () => {
  const orders = [
    makeOrder({ index: 1, operator: 'Telia', customer: customers[0], status: 'ready_internal_review', operatorStatus: 'not_ready', commissionStatus: 'expected', giftCardStatus: 'waiting_period', amountMinor: 49900, giftMinor: 100000 }),
    makeOrder({ index: 2, operator: 'Tele2', customer: customers[1], status: 'operator_processing', operatorStatus: 'processing', commissionStatus: 'confirmed', giftCardStatus: 'approved', amountMinor: 56800, giftMinor: 150000 }),
    makeOrder({ index: 3, operator: 'Telenor', customer: customers[2], status: 'rejected', operatorStatus: 'rejected', commissionStatus: 'cancelled', giftCardStatus: 'cancelled', amountMinor: 52900, giftMinor: 0 }),
    makeOrder({ index: 4, operator: 'Tre', customer: customers[1], status: 'completed', operatorStatus: 'activated', commissionStatus: 'paid', giftCardStatus: 'delivered_mock', amountMinor: 42900, giftMinor: 200000 }),
  ];
  const conversations = seedConversations();
  orders[0].conversationArchive = {
    conversationId: conversations[0].id,
    archivedAt: '2026-08-26T09:00:00.000Z',
    messageCount: conversations[0].messages.length,
    firstSequence: 1,
    lastSequence: 3,
    messages: conversations[0].messages.map((message) => ({ ...message })),
    hash: hashObject(conversations[0].messages),
  };
  conversations[0].archivedAt = orders[0].conversationArchive.archivedAt;

  const integrations = [
    ['entra', 'Microsoft Entra ID', 'disconnected'],
    ['graph', 'Microsoft Graph / Outlook', 'mock'],
    ['teams', 'Teams alerts', 'mock'],
    ['bankid', 'BankID', 'mock'],
    ['telia', 'Telia operator API', 'manual_only'],
    ['tele2', 'Tele2 operator API', 'manual_only'],
    ['telenor', 'Telenor operator API', 'manual_only'],
    ['tre', 'Tre operator API', 'manual_only'],
    ['gift-card-provider', 'Presentkort provider', 'mock'],
    ['sms', 'SMS provider', 'mock'],
    ['fortnox', 'Fortnox', 'disconnected'],
    ['analytics', 'Privacy analytics', 'mock'],
    ['monitoring', 'Monitoring', 'mock'],
    ['file-storage', 'Secure file storage', 'mock'],
  ].map(([slug, name, state], index) => ({
    id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    slug,
    name,
    state,
    mode: 'mock',
    simulated: true,
    lastSyncAt: null,
    capabilities: [],
  }));

  return {
    demoMode: true,
    seededAt: DEMO_CLOCK,
    counters: { order: 100, report: 0 },
    users: buildDemoUsers(),
    partnerOrganizations,
    customers,
    conversations,
    quotes: [],
    orders,
    idempotency: [],
    reports: [],
    auditEvents: [{
      id: '60000000-0000-4000-8000-000000000001',
      action: 'demo.seeded',
      objectType: 'system',
      objectId: 'demo',
      actorId: 'system',
      actorType: 'system',
      at: DEMO_CLOCK,
      correlationId: 'demo-seed',
      summary: { simulated: true },
    }],
    integrations,
    resources: {
      operators: partnerOrganizations.map((partner) => ({ ...partner, status: 'active_demo', catalogVersion: 'legacy-schema-v1' })),
      rules: [{ id: 'demo-rules-v1', name: 'Demo commission and gift-card rules', version: 1, state: 'active', simulated: true }],
      campaigns: [{ id: 'demo-campaign-v1', name: 'Demo höstkampanj', state: 'active', simulated: true }],
      support: [{ id: 'demo-case-1', subject: 'Aktiveringsdatum', status: 'open', priority: 'normal', customerId: customers[0].id, simulated: true }],
      communications: [{ id: 'demo-template-1', name: 'Order mottagen', channel: 'email', version: 1, state: 'active_demo' }],
      analytics: [{ id: 'demo-metric-1', metric: 'checkout_conversion', value: 0.38, period: 'last_30_days', simulated: true }],
      tasks: [{ id: 'demo-task-1', title: 'Kontrollera order DLT-2026-000001', status: 'open', dueAt: '2026-08-30T12:00:00.000Z' }],
      documents: [{ id: 'demo-document-1', name: 'Dealett villkor', version: 'demo-terms-v1', classification: 'demo' }],
      employees: Object.values(buildDemoUsers()).filter((user) => user.actorType === 'employee'),
      compliance: [{ id: 'demo-gdpr-1', type: 'data_export', status: 'approval_pending', customerId: customers[2].id, simulated: true }],
      settings: [{ key: 'environment', value: 'DEMO', public: true }, { key: 'liveAuthentication', value: false, public: true }],
    },
  };
};

module.exports = {
  DEMO_CLOCK,
  buildDemoState,
};
