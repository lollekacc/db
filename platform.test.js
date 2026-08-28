const assert = require('node:assert/strict');
const { test } = require('node:test');

const { loadPlatformConfig } = require('./platform/config');
const { createFieldCrypto } = require('./platform/field-crypto');
const { MemoryOperationsRepository } = require('./platform/memory-repository');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('./platform/permissions');
const { PostgresOperationsRepository } = require('./platform/postgres-repository');
const { assertDemoSeedEnvironment } = require('./platform/postgres-seed');
const { createPlatformRuntime } = require('./platform/runtime');
const { OperationsService } = require('./platform/service');
const { hashObject, toMinorUnits } = require('./platform/utils');
const { createServer } = require('./server');

const createClock = (start = '2026-08-29T08:00:00.000Z') => {
  let current = Date.parse(start);
  return () => new Date(current += 1_000);
};

const config = Object.freeze({
  nodeEnv: 'test',
  demoMode: true,
  repository: 'memory',
  databaseUrl: null,
  databaseSsl: false,
  encryptionKey: null,
  corsOrigins: ['http://localhost:3000'],
  chatRateLimit: 100,
  orderRateLimit: 100,
});

const makeRuntime = () => {
  const clock = createClock();
  const repository = new MemoryOperationsRepository({ clock });
  return createPlatformRuntime({ config, repository, clock });
};

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const requestJson = async (baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
};

const agreement = (acceptedAt = '2026-08-29T07:55:00.000Z') => ({
  operatorDocuments: { documentId: 'telia-mobile-terms', version: '2026-08' },
  dealettDocuments: { termsVersion: '2026-08', withdrawalVersion: '2026-08', privacyVersion: '2026-08' },
  confirmations: {
    operatorAgreement: { accepted: true, acceptedAt },
    dealettTerms: { accepted: true, acceptedAt },
    withdrawalInformation: { accepted: true, acceptedAt },
    privacyPolicy: { accepted: true, acceptedAt },
  },
});

const trustedConsentVerification = () => ({
  backendVerified: true,
  adapter: 'trusted-consent-registry',
  consents: [{
    type: 'dealett_terms',
    documentId: 'registered-dealett-terms',
    documentVersion: '2026-08',
    accepted: true,
    acceptedAt: '2026-08-29T07:55:00.000Z',
    textHash: 'a'.repeat(64),
    registeredDocument: true,
    evidence: { adapterResultId: 'trusted-result' },
  }],
});

const orderPayload = (overrides = {}) => ({
  customer: { email: 'checkout@example.invalid', phone: '+46701112233' },
  cartItems: [{
    id: 'cart-line-1', planId: 'telia-10gb', persons: 1,
    pricing: { monthly: 999, currency: 'SEK' },
    rewardTotal: 9999,
    features: ['submitted-feature'],
    addOn: { id: 'submitted-addon', monthlyPrice: 99 },
    streamingOffer: { service: 'Example Stream', monthlyPrice: 199 },
    internationalTravel: { region: 'outside_eu', dataGb: 5 },
    campaign: { id: 'client-campaign', version: 'client-v1' },
    campaignVersion: 'client-v1', ruleVersion: 'client-rule-v1',
    answers: { mobileUsage: 'medium', phone: 'must-not-survive' },
    offerCalculation: { version: 'client-calc', oldCosts: { monthly: 599 }, explanation: 'Submitted explanation' },
  }],
  participants: [{
    participantId: 'participant-1', subscriptionId: 'subscription-1', label: 'Huvudabonnemang',
    phoneNumber: '+46701112233', numberPorting: 'number_transfer', bindingEnd: '2026-09-30',
    requestedActivationDate: '2026-10-01',
  }],
  agreement: agreement(),
  attribution: {
    landingPage: '/mobilabonnemang.html?session=secret#checkout',
    referrer: 'https://example.invalid/ref?token=secret#fragment',
    utm: { source: 'newsletter', medium: 'email', campaign: 'augusti', term: 'mobil', content: 'hero' },
    clickIds: { gclid: 'must-not-be-stored' },
  },
  source: {
    channel: 'web',
    checkoutMode: 'full',
    checkoutPage: { path: '/checkout.html?secret=value', title: 'Checkout' },
    originatingPage: { path: '/mobilabonnemang.html?customer=secret', title: 'Mobile' },
    cartSources: ['calculator'],
  },
  status: 'completed',
  testMode: false,
  questionnaire: {
    mobileUsage: 'medium',
    answersBySubscription: { 'subscription-1': { mobileUsage: 'high', phone: 'must-not-survive' } },
  },
  recommendation: { selectedOfferId: 'telia-10gb', alternatives: ['tele2-15gb'], explanation: 'Submitted recommendation' },
  calculation: { version: 'client-v1', oldCosts: { monthly: 599 }, explanation: 'Submitted calculation' },
  consentEvidence: {
    capturedAt: '2026-08-29T07:55:00Z',
    confirmations: { terms: { accepted: true, acceptedAt: '2026-08-29T07:55:00Z', version: '2026-08' } },
    marketingConsent: { accepted: false, version: 'v1' },
  },
  ...overrides,
});

const rejectCode = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
};

test('configuration is explicit and fails closed', () => {
  const demo = loadPlatformConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    DEALETT_REPOSITORY: 'memory',
    CORS_ORIGINS: 'http://localhost:3000',
  });
  assert.equal(demo.demoMode, true);
  assert.equal(demo.repository, 'memory');
  assert.throws(() => loadPlatformConfig({ DEMO_MODE: 'false', DEALETT_REPOSITORY: 'memory' }), /memory repository/i);
  assert.throws(() => loadPlatformConfig({ DEMO_MODE: 'false', DEALETT_REPOSITORY: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => loadPlatformConfig({ DEMO_MODE: 'true', CORS_ORIGINS: '*' }), /without wildcards/);
});

test('canonical role model is complete and read-only analysis excludes sensitive data', () => {
  for (const role of [
    'owner', 'operations_manager', 'sales_manager', 'seller', 'customer_support', 'finance',
    'compliance_gdpr', 'offers_content_manager', 'analyst_read_only', 'operator_partner',
  ]) {
    assert.ok(Array.isArray(ROLE_PERMISSIONS[role]) && ROLE_PERMISSIONS[role].length > 0, `missing ${role}`);
  }
  assert.deepEqual(ROLE_PERMISSIONS.owner, PERMISSIONS);
  assert.equal(ROLE_PERMISSIONS.analyst_read_only.includes('sensitive_data.view'), false);
  assert.equal(ROLE_PERMISSIONS.operator_partner.includes('sensitive_data.view'), false);
  assert.equal(ROLE_PERMISSIONS.compliance_gdpr.includes('compliance.process'), true);
  assert.equal(ROLE_PERMISSIONS.offers_content_manager.includes('catalog.configure'), true);
});

test('minor-unit conversion uses exact decimal parsing', () => {
  assert.equal(toMinorUnits(0.1), 10);
  assert.equal(toMinorUnits('123.45'), 12_345);
  assert.equal(toMinorUnits('123,45'), 12_345);
  assert.equal(toMinorUnits('-1.25', 'adjustment', { allowNegative: true }), -125);
  assert.throws(() => toMinorUnits('-1.25'), (error) => error.code === 'INVALID_MONEY');
  assert.throws(() => toMinorUnits('1.234'), (error) => error.code === 'INVALID_MONEY');
  assert.throws(() => toMinorUnits('9007199254740991.00'), (error) => error.code === 'INVALID_MONEY');
  assert.equal(hashObject({ at: new Date('2026-08-29T00:00:00Z') }), hashObject({ at: '2026-08-29T00:00:00.000Z' }));
});

test('PostgreSQL demo seed is forbidden in production and destructive reset requires confirmation', () => {
  const names = ['NODE_ENV', 'DEMO_MODE', 'DEALETT_REPOSITORY', 'RESET_DEMO_CONFIRM'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.DEMO_MODE = 'true';
    process.env.DEALETT_REPOSITORY = 'postgres';
    assert.throws(() => assertDemoSeedEnvironment(), /forbidden/i);
    process.env.NODE_ENV = 'test';
    delete process.env.RESET_DEMO_CONFIRM;
    assert.throws(() => assertDemoSeedEnvironment({ reset: true, databaseName: 'dealett_demo' }), /RESET_DEMO_CONFIRM/);
    process.env.RESET_DEMO_CONFIRM = 'RESET_FICTIONAL_DEMO_DATA';
    assert.throws(() => assertDemoSeedEnvironment({ reset: true, databaseName: 'dealett_live' }), /without demo\/test/i);
    assert.doesNotThrow(() => assertDemoSeedEnvironment({ reset: true, databaseName: 'dealett_demo_test' }));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('legacy chat seeds local history, requires the opaque token, and exposes flat simulated metadata', async (t) => {
  const runtime = makeRuntime();
  const server = createServer({ platformRuntime: runtime });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const chatBody = {
    sessionId: 'df-browser-session-one',
    language: 'sv',
    message: 'Jag vill jämföra abonnemang.',
    messages: [{
      id: 'local-greeting',
      sequence: 1,
      role: 'assistant',
      content: 'Hej! Hur kan jag hjälpa dig?',
      createdAt: '2026-08-29T07:58:00.000Z',
    }],
    clientMessage: { id: 'local-user-1', sequence: 2, createdAt: '2026-08-29T07:59:00.000Z' },
  };
  const first = await requestJson(baseUrl, '/api/chat', { method: 'POST', body: chatBody });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.source, 'demo-simulated');
  assert.equal(first.body.simulated, true);
  assert.equal(first.body.model, 'demo-simulated');
  assert.equal(first.body.userMessageMetadata.sequence, 2);
  assert.equal(first.body.messageMetadata.sequence, 3);
  assert.equal(first.body.messageMetadata.model, 'demo-simulated');
  assert.equal(typeof first.body.messageMetadata.id, 'string');
  assert.equal(first.body.messageMetadata.assistant.sequence, 3);

  const stored = runtime.repository.getConversation(first.body.conversationId, {
    token: first.body.conversationToken,
    requireToken: true,
  });
  assert.deepEqual(stored.messages.map((message) => message.sequence), [1, 2, 3]);
  assert.deepEqual(stored.messages.map((message) => message.role), ['assistant', 'user', 'assistant']);
  assert.equal(stored.messages[0].clientCreatedAt, '2026-08-29T07:58:00.000Z');
  assert.equal(stored.messages[1].clientCreatedAt, '2026-08-29T07:59:00.000Z');

  const guessed = await requestJson(baseUrl, '/api/chat', { method: 'POST', body: { ...chatBody, messages: [], clientMessage: { id: 'intruder', sequence: 4 } } });
  assert.equal(guessed.response.status, 403);
  assert.equal(guessed.body.code, 'CONVERSATION_ACCESS_DENIED');
  const wrong = await requestJson(baseUrl, '/api/chat', {
    method: 'POST',
    body: { ...chatBody, conversationToken: 'wrong-token', messages: [], clientMessage: { id: 'intruder-2', sequence: 4 } },
  });
  assert.equal(wrong.response.status, 403);
  assert.equal(runtime.repository.getConversation(first.body.conversationId, { token: first.body.conversationToken, requireToken: true }).messages.length, 3);

  const cors = await fetch(`${baseUrl}/api/public/v1/environment`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(cors.status, 403);
  assert.equal(first.response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(first.response.headers.get('x-correlation-id'));
});

test('public order capture is idempotent, immutable, compatible, complete, and attribution-safe', async (t) => {
  const runtime = makeRuntime();
  const server = createServer({ platformRuntime: runtime });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const chat = await requestJson(baseUrl, '/api/chat', {
    method: 'POST',
    body: {
      conversationId: 'checkout-chat-one',
      message: 'Visa mig Telia.',
      messages: [{ id: 'greeting-1', sequence: 1, role: 'assistant', content: 'Välkommen!', createdAt: '2026-08-29T07:50:00Z' }],
      clientMessage: { id: 'question-1', sequence: 2, createdAt: '2026-08-29T07:51:00Z' },
    },
  });
  assert.equal(chat.response.status, 200);
  const conversation = runtime.repository.getConversation(chat.body.conversationId, { token: chat.body.conversationToken, requireToken: true });
  const payload = orderPayload({
    conversationId: chat.body.conversationId,
    conversationToken: chat.body.conversationToken,
    conversationSnapshot: {
      transcriptTruncated: false,
      messages: conversation.messages.map((message) => ({
        id: message.clientMessageId || message.id,
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        createdAt: message.clientCreatedAt || message.createdAt,
        model: message.model,
      })),
    },
    bankId: { user: {}, orderRef: 'demo-ref', signedAt: '2026-08-29T07:56:00Z' },
  });
  const beforeCount = runtime.repository.state.orders.length;
  const created = await requestJson(baseUrl, '/api/public/v1/orders', {
    method: 'POST', headers: { 'idempotency-key': 'checkout-idempotency-0001' }, body: payload,
  });
  assert.equal(created.response.status, 201);
  assert.equal(Object.hasOwn(created.body, 'order'), false);
  assert.equal(created.body.status, 'submitted');
  assert.equal(created.body.testMode, true);
  const storedOrder = runtime.repository.getOrder(created.body.orderId);
  assert.equal(storedOrder.customer.displayName, 'Ej angivet');
  assert.equal(storedOrder.safeTechnicalMetadata.bankId.simulated, true);
  assert.equal(storedOrder.safeTechnicalMetadata.bankId.verifiedByBackend, false);
  assert.equal(storedOrder.snapshot.selectedOffer.monthlyPriceMinor, 29_900);
  assert.equal(storedOrder.snapshot.selectedOffer.international.roaming.euEeaIncluded, true);
  assert.equal(storedOrder.snapshot.authoritativeLines.length, 1);
  assert.equal(storedOrder.conversationArchive.messageCount, 3);
  assert.deepEqual(storedOrder.conversationArchive.messages.map((message) => message.sequence), [1, 2, 3]);
  assert.equal(storedOrder.conversationArchive.messages[0].clientCreatedAt, '2026-08-29T07:50:00.000Z');
  assert.equal(storedOrder.attribution.source, 'newsletter');
  assert.equal(storedOrder.attribution.medium, 'email');
  assert.equal(storedOrder.attribution.channel, 'web');
  assert.equal(storedOrder.attribution.landingPage, '/mobilabonnemang.html');
  assert.equal(storedOrder.attribution.referrer, 'https://example.invalid/ref');
  assert.equal(storedOrder.attribution.checkoutPage, '/checkout.html');
  assert.equal(Object.hasOwn(storedOrder.attribution, 'clickIds'), false);
  const evidence = storedOrder.snapshot.submittedEvidence;
  assert.equal(evidence.classification, 'untrusted_submitted_evidence');
  assert.equal(evidence.cartItems[0].pricing.monthly, 999);
  assert.equal(evidence.cartItems[0].addOn.id, 'submitted-addon');
  assert.equal(evidence.cartItems[0].streamingOffer.service, 'Example Stream');
  assert.equal(evidence.cartItems[0].offerCalculation.explanation, 'Submitted explanation');
  assert.equal(Object.hasOwn(evidence.cartItems[0].answers, 'phone'), false);
  assert.equal(Object.hasOwn(evidence.questionnaire.answersBySubscription['subscription-1'], 'phone'), false);
  assert.equal(evidence.participants[0].numberPorting, 'number_transfer');
  assert.match(evidence.participants[0].phoneNumberMask, /2233$/);
  assert.equal(evidence.agreement.consentEvidence.confirmations.terms.accepted, true);

  const replay = await requestJson(baseUrl, '/api/orders', {
    method: 'POST', headers: { 'idempotency-key': 'checkout-idempotency-0001' }, body: payload,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.orderId, created.body.orderId);
  assert.equal(runtime.repository.state.orders.length, beforeCount + 1);
  const conflict = await requestJson(baseUrl, '/api/orders', {
    method: 'POST', headers: { 'idempotency-key': 'checkout-idempotency-0001' },
    body: { ...payload, customer: { email: 'different@example.invalid', phone: '+46701112233' } },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const sourceQuote = runtime.repository.state.quotes.find((quote) => quote.snapshotHash === storedOrder.snapshotHash);
  sourceQuote.snapshot.selectedOffer.title = 'MUTATED SOURCE';
  const immutableOrder = runtime.repository.getOrder(created.body.orderId);
  assert.notEqual(immutableOrder.snapshot.selectedOffer.title, 'MUTATED SOURCE');
  assert.equal(immutableOrder.snapshotHash, storedOrder.snapshotHash);
  const adminView = await requestJson(baseUrl, `/api/admin/v1/orders/${created.body.orderId}`);
  assert.equal(adminView.response.status, 200);
  assert.equal(adminView.body.customer.email, 'checkout@example.invalid');
  const report = await requestJson(baseUrl, `/api/admin/v1/orders/${created.body.orderId}/reports`, {
    method: 'POST', body: {},
  });
  assert.equal(report.response.status, 201);
  assert.equal(report.body.payload.archiveIntegrity.orderSnapshotHash, storedOrder.snapshotHash);
  const transition = await requestJson(baseUrl, `/api/admin/v1/orders/${created.body.orderId}/transitions`, {
    method: 'POST',
    body: { machine: 'order', to: 'ready_internal_review', reason: 'HTTP operations review', version: 1 },
  });
  assert.equal(transition.response.status, 200);
  assert.equal(transition.body.status, 'ready_internal_review');
  const teliaPartner = await requestJson(baseUrl, `/api/partner/v1/orders/${created.body.orderId}`, {
    headers: { 'x-demo-user': 'demo-partner-telia' },
  });
  assert.equal(teliaPartner.response.status, 200);
  assert.match(teliaPartner.body.customer.email, /\*\*\*/);
  const otherPartner = await requestJson(baseUrl, `/api/partner/v1/orders/${created.body.orderId}`, {
    headers: { 'x-demo-user': 'demo-partner-tele2' },
  });
  assert.equal(otherPartner.response.status, 404);
  const unrelatedCustomer = await requestJson(baseUrl, `/api/customer/v1/orders/${created.body.orderId}`, {
    headers: { 'x-demo-user': 'demo-customer' },
  });
  assert.equal(unrelatedCustomer.response.status, 404);
  await rejectCode(runtime.service.appendConversationMessage(chat.body.conversationId, {
    role: 'user', content: 'Late mutation', sequence: 4,
  }, { token: chat.body.conversationToken }), 'CONVERSATION_ARCHIVED');
});

test('conversation IDOR and truncated fallbacks are rejected before order/idempotency capture', async () => {
  const runtime = makeRuntime();
  const created = await runtime.service.createConversation({ conversationId: 'protected-conversation' });
  await runtime.service.appendConversationMessage(created.conversation.id, {
    role: 'assistant', content: 'Protected transcript', sequence: 1,
  }, { token: created.token });
  const guessedPayload = orderPayload({
    conversationId: created.conversation.id,
    conversationSnapshot: [{ sequence: 1, role: 'assistant', content: 'Protected transcript' }],
  });
  await rejectCode(runtime.service.createOrder(guessedPayload, 'security-order-key-0001'), 'CONVERSATION_ACCESS_DENIED');
  assert.equal(runtime.repository.state.idempotency.length, 0);

  const truncatedId = 'truncated-new-conversation';
  const conversationCount = runtime.repository.state.conversations.length;
  await rejectCode(runtime.service.createOrder(orderPayload({
    conversationId: truncatedId,
    conversationSnapshot: {
      transcriptTruncated: true,
      droppedMessageCount: 2,
      totalMessageCount: 3,
      messages: [{ sequence: 3, role: 'user', content: 'Only the last message' }],
    },
  }), 'recoverable-order-key-0001'), 'CONVERSATION_ARCHIVE_INCOMPLETE');
  assert.equal(runtime.repository.state.idempotency.length, 0);
  assert.equal(runtime.repository.state.conversations.length, conversationCount);

  const retry = await runtime.service.createOrder(orderPayload({
    conversationId: truncatedId,
    conversationSnapshot: [{ sequence: 1, role: 'assistant', content: 'Complete fallback' }],
  }), 'recoverable-order-key-0001');
  assert.equal(retry.replayed, false);
  assert.equal(retry.order.conversationArchive.messageCount, 1);
});

test('conversation collisions, empty chat associations, and unsupported multi-offer carts fail safely', async () => {
  const runtime = makeRuntime();
  const first = await runtime.service.createConversation({ conversationId: 'collision-test' });
  await rejectCode(runtime.service.createConversation({ conversationId: 'collision-test' }), 'CONVERSATION_ID_CONFLICT');
  const recovered = await runtime.service.createConversation({
    conversationId: 'collision-test', conversationToken: first.token,
  });
  assert.equal(recovered.existing, true);
  assert.equal(recovered.token, first.token);

  const noChat = await runtime.service.createOrder(orderPayload({
    conversationId: 'client-created-but-never-opened-chat',
    conversationToken: null,
    conversationSnapshot: { messages: [] },
  }), 'no-chat-checkout-key-0001');
  assert.equal(noChat.order.status, 'submitted');
  assert.equal(noChat.order.conversationArchive, null);

  const beforeKeys = runtime.repository.state.idempotency.length;
  await rejectCode(runtime.service.createOrder(orderPayload({
    cartItems: [
      { id: 'line-1', planId: 'telia-10gb', persons: 1 },
      { id: 'line-2', planId: 'tele2-15gb', persons: 1 },
    ],
  }), 'multi-offer-key-0001'), 'MULTI_OFFER_CONSENT_REQUIRED');
  assert.equal(runtime.repository.state.idempotency.length, beforeKeys);
});

test('state machines, ledgers, permissions, projection, tenant scoping, reports and mocks stay separate', async () => {
  const runtime = makeRuntime();
  const admin = runtime.repository.state.users['demo-admin'];
  const telia = runtime.repository.state.users['demo-partner-telia'];
  const tele2 = runtime.repository.state.users['demo-partner-tele2'];
  const customer = runtime.repository.state.users['demo-customer'];
  const analyst = {
    id: 'analyst-test', actorType: 'employee', permissions: [...ROLE_PERMISSIONS.analyst], roles: ['analyst'],
  };
  const teliaPage = await runtime.service.listOrders(telia, new URLSearchParams());
  assert.ok(teliaPage.items.length > 0);
  assert.ok(teliaPage.items.every((order) => order.partnerOrganizationId === telia.partnerOrganizationId));
  assert.ok(teliaPage.items.every((order) => order.customer.email.includes('***')));
  assert.ok(teliaPage.items.every((order) => !order.conversationArchive?.messages));
  const tele2Page = await runtime.service.listOrders(tele2, new URLSearchParams());
  assert.ok(tele2Page.items.every((order) => order.partnerOrganizationId === tele2.partnerOrganizationId));
  await rejectCode(runtime.service.getOrder(telia, tele2Page.items[0].id), 'ORDER_NOT_FOUND');

  const adminOrder = await runtime.service.getOrder(admin, teliaPage.items[0].id);
  assert.equal(adminOrder.customer.email, 'demo.kund@example.invalid');
  const analystOrder = await runtime.service.getOrder(analyst, teliaPage.items[0].id);
  assert.match(analystOrder.customer.email, /\*\*\*/);
  const customerOrder = await runtime.service.getOrder(customer, teliaPage.items[0].id);
  assert.equal(customerOrder.customer.email, 'demo.kund@example.invalid');
  const partnerCsv = await runtime.service.exportOrdersCsv(telia, new URLSearchParams());
  assert.match(partnerCsv, /d\*\*\*@example\.invalid/);
  assert.doesNotMatch(partnerCsv, /demo\.kund@example\.invalid/);
  const analystCsv = await runtime.service.exportOrdersCsv(analyst, new URLSearchParams());
  assert.doesNotMatch(analystCsv, /demo\.kund@example\.invalid/);
  const analystCustomers = await runtime.service.listResource(analyst, 'customers');
  assert.match(analystCustomers[0].email, /\*\*\*/);
  const adminCustomers = await runtime.service.listResource(admin, 'customers');
  assert.equal(adminCustomers[0].email, 'demo.kund@example.invalid');

  const transitioned = await runtime.service.transitionOrder(admin, adminOrder.id, {
    machine: 'commission', to: 'confirmed', reason: 'Demo reconciliation', version: adminOrder.version, amount: 123.45,
  });
  assert.equal(transitioned.commissionStatus, 'confirmed');
  assert.equal(transitioned.status, adminOrder.status);
  assert.equal(transitioned.operatorStatus, adminOrder.operatorStatus);
  assert.equal(transitioned.commissionLedger.at(-1).amountMinor, 12_345);
  const gift = await runtime.service.transitionOrder(admin, transitioned.id, {
    machine: 'gift_card', to: 'approval_pending', reason: 'Waiting period complete', version: transitioned.version, amount: 1000,
  });
  assert.equal(gift.giftCardStatus, 'approval_pending');
  assert.equal(gift.giftCardLedger.at(-1).amountMinor, 100_000);
  await rejectCode(runtime.service.transitionOrder(admin, gift.id, {
    machine: 'order', to: 'completed', reason: 'Missing explicit confirmation', version: gift.version,
  }), 'CONFIRMATION_REQUIRED');
  await rejectCode(runtime.service.transitionOrder(admin, gift.id, {
    machine: 'order', to: 'completed', reason: 'Invalid jump', version: gift.version, confirmed: true,
  }), 'INVALID_STATE_TRANSITION');
  await rejectCode(runtime.service.transitionOrder(admin, gift.id, {
    machine: 'operator', to: 'ready_for_submission', reason: 'Stale edit', version: 1,
  }), 'VERSION_CONFLICT');

  const report = await runtime.service.generateReport(admin, gift.id);
  assert.equal(report.simulated, true);
  assert.equal(report.payload.archiveIntegrity.orderSnapshotHash, gift.snapshotHash);
  const simulation = await runtime.service.simulateIntegration(admin, 'bankid', { action: 'simulate-success' });
  assert.equal(simulation.simulated, true);
  assert.equal(simulation.liveActionPerformed, false);
  assert.equal(simulation.state, 'mock');
});

test('live capture requires trusted backend identity and the service awaits an asynchronous repository contract', async () => {
  const clock = createClock();
  const memory = new MemoryOperationsRepository({ clock, seed: false });
  const asynchronousRepository = new Proxy(memory, {
    get(target, property) {
      const value = target[property];
      return typeof value === 'function' ? async (...args) => value.apply(target, args) : value;
    },
  });
  const liveConfig = { ...config, demoMode: false, repository: 'postgres' };
  const service = new OperationsService({ repository: asynchronousRepository, config: liveConfig, clock });
  await rejectCode(service.createOrder(orderPayload(), 'live-order-no-identity-0001'), 'IDENTITY_VERIFICATION_REQUIRED');
  await rejectCode(service.createOrder(orderPayload(), 'live-order-no-consent-0001', {
    identityVerification: { backendVerified: true, displayName: 'Trusted Identity' },
  }), 'CONSENT_VERIFICATION_REQUIRED');
  const accepted = await service.createOrder(orderPayload({
    bankId: { user: { name: 'Forged Browser Name' }, orderRef: 'forged-client-claim', signatureId: 'forged-signature' },
  }), 'live-order-verified-0001', {
    identityVerification: {
      backendVerified: true,
      adapter: 'test-trusted-backend',
      displayName: 'Backend Verified Customer',
      orderRef: 'trusted-order-ref',
      signatureId: 'trusted-signature',
      signedAt: '2026-08-29T07:54:00Z',
    },
    consentVerification: trustedConsentVerification(),
  });
  assert.equal(accepted.order.customer.displayName, 'Backend Verified Customer');
  assert.equal(accepted.order.safeTechnicalMetadata.bankId.simulated, false);
  assert.equal(accepted.order.safeTechnicalMetadata.bankId.verifiedByBackend, true);
  assert.equal(accepted.order.safeTechnicalMetadata.bankId.orderRef, 'trusted-order-ref');
  assert.equal(accepted.order.safeTechnicalMetadata.bankId.signatureId, 'trusted-signature');
  assert.equal(accepted.order.status, 'submitted');
});

test('PostgreSQL repository order contract works through async transactions with a mocked pool', async () => {
  const clock = createClock();
  let storedQuote;
  let persistedIdempotencyResponse;
  const fakeClient = {
    async query(sql, parameters = []) {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO quotes')) {
        storedQuote = {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          selected_offer_id: parameters[0], snapshot: parameters[1], snapshot_hash: parameters[2],
          mode: parameters[3], expires_at: parameters[4], created_at: '2026-08-29T08:00:00Z',
        };
        return { rows: [storedQuote], rowCount: 1 };
      }
      if (compact.startsWith('INSERT INTO audit_events')) return { rows: [{ id: 'audit' }], rowCount: 1 };
      if (compact.startsWith('INSERT INTO idempotency_keys')) return { rows: [{ key: parameters[0], request_hash: parameters[1] }], rowCount: 1 };
      if (compact.startsWith('SELECT * FROM quotes')) return { rows: [storedQuote], rowCount: 1 };
      if (compact.startsWith('INSERT INTO customers')) return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }], rowCount: 1 };
      if (compact.includes("nextval('order_number_sequence')")) return { rows: [{ value: 101 }], rowCount: 1 };
      if (compact.startsWith('SELECT id, partner_organization_id FROM operators')) return { rows: [], rowCount: 0 };
      if (compact.startsWith('INSERT INTO orders')) return { rows: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        created_at: '2026-08-29T08:00:10Z', submitted_at: '2026-08-29T08:00:10Z',
      }], rowCount: 1 };
      if (compact.startsWith('INSERT INTO order_participants')) return { rows: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }], rowCount: 1 };
      if (compact.startsWith('INSERT INTO consent_documents')) return { rows: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }], rowCount: 1 };
      if (compact.startsWith('UPDATE idempotency_keys SET')) persistedIdempotencyResponse = parameters[1];
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { async connect() { return fakeClient; }, async end() {} };
  const repository = new PostgresOperationsRepository({
    pool,
    demoMode: false,
    fieldCrypto: createFieldCrypto(Buffer.alloc(32, 9).toString('base64')),
  });
  const service = new OperationsService({ repository, config: { ...config, demoMode: false, repository: 'postgres' }, clock });
  const result = await service.createOrder(orderPayload(), 'postgres-contract-key-0001', {
    correlationId: 'postgres-contract-test',
    identityVerification: { backendVerified: true, adapter: 'mocked-trusted-adapter', displayName: 'Verified PG Customer' },
    consentVerification: trustedConsentVerification(),
  });
  assert.equal(result.order.id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(result.order.status, 'submitted');
  assert.equal(result.order.snapshot.selectedOffer.planId, 'telia-10gb');
  assert.equal(persistedIdempotencyResponse.orderId, result.order.id);
  assert.equal(JSON.stringify(persistedIdempotencyResponse).includes('checkout@example.invalid'), false);
  assert.equal(Object.hasOwn(persistedIdempotencyResponse, 'customer'), false);
});

test('explicit live mode cannot use legacy simulated BankID endpoints', async (t) => {
  const clock = createClock();
  const repository = new MemoryOperationsRepository({ clock, seed: false });
  const runtime = createPlatformRuntime({
    config: { ...config, demoMode: false, repository: 'postgres' },
    repository,
    clock,
  });
  const server = createServer({ platformRuntime: runtime });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await requestJson(baseUrl, '/api/bankid/start', { method: 'POST', body: {} });
  assert.equal(response.response.status, 503);
  assert.equal(response.body.code, 'INTEGRATION_NOT_CONFIGURED');
});

test('requested platform mode never falls back to the legacy JSON order store after configuration failure', async (t) => {
  const names = ['DEMO_MODE', 'DEALETT_REPOSITORY', 'DATABASE_URL', 'DEALETT_DATA_ENCRYPTION_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.DEMO_MODE = 'false';
  process.env.DEALETT_REPOSITORY = 'postgres';
  delete process.env.DATABASE_URL;
  delete process.env.DEALETT_DATA_ENCRYPTION_KEY;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  const server = createServer();
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await requestJson(baseUrl, '/api/orders', {
    method: 'POST', headers: { 'idempotency-key': 'fail-closed-key-0001' }, body: orderPayload(),
  });
  assert.equal(response.response.status, 500);
  assert.equal(response.body.code, 'CONFIGURATION_ERROR');
});
