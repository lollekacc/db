const crypto = require('node:crypto');

const { buildDemoState } = require('./demo-data');
const { PlatformError, assertPlatform } = require('./errors');
const { assertTransition } = require('./state-machines');
const { clone, hashObject, nowIso, sha256 } = require('./utils');

const STATE_FIELDS = Object.freeze({
  order: ['status', 'order'],
  operator: ['operatorStatus', 'operator'],
  commission: ['commissionStatus', 'commission'],
  gift_card: ['giftCardStatus', 'giftCard'],
});

class MemoryOperationsRepository {
  constructor({ clock = () => new Date(), seed = true } = {}) {
    this.clock = clock;
    this.state = seed ? buildDemoState() : {
      demoMode: true,
      seededAt: nowIso(clock),
      counters: { order: 0, report: 0 },
      users: {},
      partnerOrganizations: [],
      customers: [],
      conversations: [],
      quotes: [],
      orders: [],
      idempotency: [],
      reports: [],
      auditEvents: [],
      integrations: [],
      resources: {},
    };
  }

  resetDemo() {
    this.state = buildDemoState();
    return this.getEnvironmentSummary();
  }

  getEnvironmentSummary() {
    return {
      mode: 'DEMO',
      demoMode: true,
      repository: 'memory',
      seededAt: this.state.seededAt,
      dataClassification: 'fictional_demo_only',
      liveAuthentication: false,
    };
  }

  getUsers() {
    return clone(this.state.users);
  }

  appendAudit({ action, objectType, objectId, actor, correlationId, summary = null, before = null, after = null }) {
    const event = {
      id: crypto.randomUUID(),
      action,
      objectType,
      objectId: String(objectId),
      actorId: actor?.id || 'anonymous',
      actorType: actor?.actorType || 'public',
      at: nowIso(this.clock),
      correlationId,
      summary: clone(summary),
      before: clone(before),
      after: clone(after),
    };
    this.state.auditEvents.push(event);
    return clone(event);
  }

  createConversation({ id = null, token: suppliedToken = null, customerId = null, language = 'sv', sourcePage = null, attribution = null }, context = {}) {
    if (id) {
      const existing = this.state.conversations.find((entry) => entry.id === id);
      if (existing) {
        if (!suppliedToken || sha256(suppliedToken) !== existing.publicTokenHash) {
          throw new PlatformError('CONVERSATION_ID_CONFLICT', 'Conversation identifier is unavailable; create a new conversation identifier', 409);
        }
        return { conversation: clone(existing), token: suppliedToken, existing: true };
      }
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = nowIso(this.clock);
    const conversation = {
      id: id || crypto.randomUUID(),
      publicTokenHash: sha256(token),
      customerId,
      language,
      status: 'active',
      sourcePage,
      attribution: clone(attribution),
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      messages: [],
    };
    this.state.conversations.push(conversation);
    this.appendAudit({
      action: 'conversation.created',
      objectType: 'conversation',
      objectId: conversation.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { language, sourcePage, demo: true },
    });
    return { conversation: clone(conversation), token, existing: false };
  }

  getConversation(id, { token = null, requireToken = false } = {}) {
    const conversation = this.state.conversations.find((entry) => entry.id === id);
    if (!conversation) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
    if (requireToken && (!token || sha256(token) !== conversation.publicTokenHash)) {
      throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
    }
    return clone(conversation);
  }

  appendConversationMessage(id, {
    role,
    content,
    structuredContent = null,
    language = null,
    model = null,
    clientMessageId = null,
    clientCreatedAt = null,
    requestedSequence = null,
    relatedMessageId = null,
  }, context = {}) {
    const conversation = this.state.conversations.find((entry) => entry.id === id);
    if (!conversation) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
    if (conversation.status === 'archived' || conversation.archivedAt) throw new PlatformError('CONVERSATION_ARCHIVED', 'Archived conversations are immutable', 409);
    if (!context.token || sha256(context.token) !== conversation.publicTokenHash) {
      throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
    }
    if (clientMessageId) {
      const existing = conversation.messages.find((message) => message.clientMessageId === clientMessageId);
      if (existing) return { message: clone(existing), replayed: true };
    }
    assertPlatform(['user', 'assistant', 'system', 'tool'].includes(role), 'INVALID_MESSAGE_ROLE', 'Invalid conversation message role');
    assertPlatform(typeof content === 'string' && content.trim(), 'INVALID_MESSAGE', 'Message content is required');
    const nextSequence = conversation.messages.length + 1;
    if (requestedSequence !== null && Number(requestedSequence) !== nextSequence) {
      throw new PlatformError('CONVERSATION_SEQUENCE_CONFLICT', 'Conversation message sequence is not the next expected value', 409, {
        expected: nextSequence,
        received: Number(requestedSequence),
      });
    }
    const message = {
      id: crypto.randomUUID(),
      clientMessageId,
      sequence: nextSequence,
      role,
      content: content.trim(),
      structuredContent: clone(structuredContent),
      language: language || conversation.language,
      model,
      relatedMessageId,
      createdAt: nowIso(this.clock),
      clientCreatedAt,
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    this.appendAudit({
      action: 'conversation.message_appended',
      objectType: 'conversation',
      objectId: conversation.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { messageId: message.id, sequence: message.sequence, role },
    });
    return { message: clone(message), replayed: false };
  }

  createQuote(quote, context = {}) {
    const record = {
      id: crypto.randomUUID(),
      ...clone(quote),
      createdAt: nowIso(this.clock),
    };
    this.state.quotes.push(record);
    this.appendAudit({
      action: 'quote.created',
      objectType: 'quote',
      objectId: record.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { selectedOfferId: record.selectedOfferId, expiresAt: record.expiresAt },
    });
    return clone(record);
  }

  getQuote(id) {
    const quote = this.state.quotes.find((entry) => entry.id === id);
    if (!quote) throw new PlatformError('QUOTE_NOT_FOUND', 'Quote not found', 404);
    return clone(quote);
  }

  createOrderAtomic(command, context = {}) {
    const existingKey = this.state.idempotency.find((entry) => entry.key === command.idempotencyKey);
    if (existingKey) {
      if (existingKey.requestHash !== command.requestHash) {
        throw new PlatformError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request', 409);
      }
      const order = clone(this.state.orders.find((entry) => entry.id === existingKey.orderId));
      return { order, receipt: clone(existingKey.receipt), replayed: true };
    }

    const quote = this.state.quotes.find((entry) => entry.id === command.quoteId);
    if (!quote) throw new PlatformError('QUOTE_NOT_FOUND', 'Quote not found', 404);
    if (Date.parse(quote.expiresAt) <= this.clock().getTime()) {
      throw new PlatformError('QUOTE_EXPIRED', 'Quote has expired and must be recalculated', 409);
    }

    let archive = null;
    if (command.conversationId) {
      const conversation = this.state.conversations.find((entry) => entry.id === command.conversationId);
      if (!conversation) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
      if (!command.conversationToken || sha256(command.conversationToken) !== conversation.publicTokenHash) {
        throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
      }
      const messages = [...conversation.messages].sort((left, right) => left.sequence - right.sequence);
      messages.forEach((message, index) => {
        if (message.sequence !== index + 1 || !message.createdAt) {
          throw new PlatformError('CONVERSATION_SEQUENCE_INVALID', 'Conversation sequence is incomplete', 409);
        }
      });
      const archivedAt = nowIso(this.clock);
      archive = {
        conversationId: conversation.id,
        archivedAt,
        messageCount: messages.length,
        firstSequence: messages[0]?.sequence || null,
        lastSequence: messages.at(-1)?.sequence || null,
        messages: clone(messages),
        hash: hashObject(messages),
      };
    }

    const createdAt = nowIso(this.clock);
    const customer = {
      id: crypto.randomUUID(),
      displayName: command.customer.displayName,
      email: command.customer.email,
      phone: command.customer.phone,
      language: command.customer.language || 'sv',
      classification: 'submitted_customer_data',
    };
    this.state.customers.push(customer);
    this.state.counters.order += 1;
    const operator = quote.snapshot.selectedOffer.operator;
    const partner = this.state.partnerOrganizations.find((entry) => entry.name === operator);
    const selected = quote.snapshot.selectedOffer;
    const giftCardValueMinor = Number(quote.snapshot.aggregateGiftCardValueMinor ?? selected.giftCardValueMinor) || 0;
    const order = {
      id: crypto.randomUUID(),
      orderNumber: `DLT-${this.clock().getUTCFullYear()}-${String(this.state.counters.order).padStart(6, '0')}`,
      publicReference: crypto.randomBytes(9).toString('base64url').toUpperCase(),
      source: 'public_v1',
      customerId: customer.id,
      customer,
      partnerOrganizationId: partner?.id || null,
      operator,
      planName: selected.title,
      status: 'submitted',
      operatorStatus: 'not_ready',
      commissionStatus: 'expected',
      giftCardStatus: giftCardValueMinor > 0 ? 'eligible' : 'not_eligible',
      supportStatus: 'none',
      version: 1,
      createdAt,
      submittedAt: createdAt,
      updatedAt: createdAt,
      monthlyValueMinor: Number(quote.snapshot.aggregateMonthlyValueMinor ?? selected.monthlyPriceMinor) || 0,
      giftCardValueMinor,
      subscriptionCount: command.participants.length,
      participants: clone(command.participants).map((participant) => ({ id: crypto.randomUUID(), ...participant })),
      consents: clone(command.consents),
      attribution: clone(command.attribution),
      safeTechnicalMetadata: clone(command.safeTechnicalMetadata),
      snapshot: clone(quote.snapshot),
      snapshotHash: hashObject(quote.snapshot),
      conversationArchive: archive,
      statusHistories: {
        order: [{ from: null, to: 'submitted', reason: 'Public checkout accepted', at: createdAt, actorId: context.actor?.id || 'public' }],
        operator: [{ from: null, to: 'not_ready', reason: 'Awaiting internal review', at: createdAt, actorId: 'system' }],
        commission: [{ from: null, to: 'expected', reason: 'Created from order snapshot', at: createdAt, actorId: 'system' }],
        giftCard: [{ from: null, to: giftCardValueMinor > 0 ? 'eligible' : 'not_eligible', reason: 'Created from rule snapshot', at: createdAt, actorId: 'system' }],
      },
      commissionLedger: [{
        id: crypto.randomUUID(),
        type: 'expectation',
        amountMinor: Number(quote.snapshot.commissionExpectedMinor) || 0,
        currency: 'SEK',
        simulated: true,
        createdAt,
      }],
      giftCardLedger: giftCardValueMinor > 0 ? [{
        id: crypto.randomUUID(),
        type: 'entitlement',
        amountMinor: giftCardValueMinor,
        currency: 'SEK',
        simulated: true,
        createdAt,
      }] : [],
      reports: [],
      notes: [],
      tasks: [],
    };
    this.state.orders.push(order);
    const receipt = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderReference: order.orderNumber,
      publicReference: order.publicReference,
      status: order.status,
      acceptedAt: order.createdAt,
      testMode: true,
      simulated: true,
    };
    this.state.idempotency.push({
      key: command.idempotencyKey,
      requestHash: command.requestHash,
      orderId: order.id,
      receipt,
      createdAt,
    });
    if (archive) {
      const conversation = this.state.conversations.find((entry) => entry.id === archive.conversationId);
      conversation.archivedAt = archive.archivedAt;
      conversation.status = 'archived';
    }
    this.appendAudit({
      action: 'order.created',
      objectType: 'order',
      objectId: order.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { orderNumber: order.orderNumber, snapshotHash: order.snapshotHash, conversationMessageCount: archive?.messageCount || 0 },
    });
    return { order: clone(order), receipt: clone(receipt), replayed: false };
  }

  listOrders({ actor = null, filters = {}, page = 1, pageSize = 25 } = {}) {
    let rows = [...this.state.orders];
    if (actor?.actorType === 'partner') {
      rows = rows.filter((order) => order.partnerOrganizationId === actor.partnerOrganizationId);
    }
    if (actor?.actorType === 'customer') {
      rows = rows.filter((order) => order.customerId === actor.customerId);
    }
    if (filters.status) rows = rows.filter((order) => order.status === filters.status);
    if (filters.operator) rows = rows.filter((order) => order.operator.toLowerCase() === String(filters.operator).toLowerCase());
    if (filters.commissionStatus) rows = rows.filter((order) => order.commissionStatus === filters.commissionStatus);
    if (filters.giftCardStatus) rows = rows.filter((order) => order.giftCardStatus === filters.giftCardStatus);
    if (filters.search) {
      const query = String(filters.search).toLocaleLowerCase('sv');
      rows = rows.filter((order) => [order.orderNumber, order.publicReference, order.customer.displayName, order.customer.email, order.operator, order.planName]
        .some((value) => String(value || '').toLocaleLowerCase('sv').includes(query)));
    }
    rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const safePage = Math.max(Number(page) || 1, 1);
    const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
    const offset = (safePage - 1) * safePageSize;
    return {
      items: clone(rows.slice(offset, offset + safePageSize)),
      page: safePage,
      pageSize: safePageSize,
      total: rows.length,
      totalPages: Math.max(Math.ceil(rows.length / safePageSize), 1),
    };
  }

  getOrder(id, actor = null) {
    const order = this.state.orders.find((entry) => entry.id === id || entry.orderNumber === id || entry.publicReference === id);
    if (!order) throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (actor?.actorType === 'partner' && order.partnerOrganizationId !== actor.partnerOrganizationId) {
      throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (actor?.actorType === 'customer' && order.customerId !== actor.customerId) {
      throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    return clone(order);
  }

  transitionOrder(id, { machine, to, reason, note = null, expectedVersion, amountMinor = null }, context = {}) {
    const order = this.state.orders.find((entry) => entry.id === id);
    if (!order) throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    if (context.actor?.actorType === 'partner' && order.partnerOrganizationId !== context.actor.partnerOrganizationId) {
      throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    }
    if (Number(expectedVersion) !== order.version) {
      throw new PlatformError('VERSION_CONFLICT', 'Order was changed by another user', 409, { currentVersion: order.version });
    }
    const [field, historyKey] = STATE_FIELDS[machine] || [];
    if (!field) throw new PlatformError('INVALID_STATE_MACHINE', 'Invalid state machine', 400);
    const from = order[field];
    assertTransition(machine, from, to);
    const before = { [field]: from, version: order.version };
    const at = nowIso(this.clock);
    order[field] = to;
    order.version += 1;
    order.updatedAt = at;
    order.statusHistories[historyKey].push({
      from,
      to,
      reason,
      note,
      at,
      actorId: context.actor?.id || 'system',
      simulated: context.actor?.demoMode === true,
    });
    if (machine === 'commission' && amountMinor !== null) {
      order.commissionLedger.push({ id: crypto.randomUUID(), type: `status_${to}`, amountMinor, currency: 'SEK', simulated: true, createdAt: at });
    }
    if (machine === 'gift_card' && amountMinor !== null) {
      order.giftCardLedger.push({ id: crypto.randomUUID(), type: `status_${to}`, amountMinor, currency: 'SEK', simulated: true, createdAt: at });
    }
    this.appendAudit({
      action: `order.${machine}_status_changed`,
      objectType: 'order',
      objectId: order.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { reason, note },
      before,
      after: { [field]: to, version: order.version },
    });
    return clone(order);
  }

  createReport(id, context = {}) {
    const order = this.state.orders.find((entry) => entry.id === id);
    if (!order) throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    this.state.counters.report += 1;
    const generatedAt = nowIso(this.clock);
    const payload = {
      reportType: 'manual_operator_order',
      reportVersion: order.reports.length + 1,
      generatedAt,
      order: clone(order),
      archiveIntegrity: {
        orderSnapshotHash: order.snapshotHash,
        conversationArchiveHash: order.conversationArchive?.hash || null,
      },
    };
    const report = {
      id: crypto.randomUUID(),
      orderId: order.id,
      version: payload.reportVersion,
      generatedAt,
      generatedBy: context.actor?.id || 'system',
      format: 'json',
      simulated: true,
      payload,
      hash: hashObject(payload),
    };
    this.state.reports.push(report);
    order.reports.push({ id: report.id, version: report.version, generatedAt, hash: report.hash, simulated: true });
    this.appendAudit({
      action: 'order.report_generated',
      objectType: 'order',
      objectId: order.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: { reportId: report.id, version: report.version, simulated: true },
    });
    return clone(report);
  }

  getReport(id, actor = null) {
    const report = this.state.reports.find((entry) => entry.id === id);
    if (!report) throw new PlatformError('REPORT_NOT_FOUND', 'Report not found', 404);
    this.getOrder(report.orderId, actor);
    return clone(report);
  }

  getDashboard() {
    const orders = this.state.orders;
    const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
    return {
      mode: 'DEMO',
      simulated: true,
      purchases: orders.length,
      requiringAttention: orders.filter((order) => ['submitted', 'ready_internal_review', 'fraud_review'].includes(order.status)).length,
      activated: orders.filter((order) => ['activated', 'completed'].includes(order.status)).length,
      rejected: orders.filter((order) => order.status === 'rejected').length,
      expectedCommissionMinor: sum(orders.flatMap((order) => order.commissionLedger.filter((entry) => entry.type === 'expectation').map((entry) => entry.amountMinor))),
      presentkortLiabilityMinor: sum(orders.filter((order) => !['delivered_mock', 'cancelled', 'reversed'].includes(order.giftCardStatus)).map((order) => order.giftCardValueMinor)),
      operatorDistribution: Object.fromEntries(this.state.partnerOrganizations.map((partner) => [partner.name, orders.filter((order) => order.operator === partner.name).length])),
      unresolvedSupport: this.state.resources.support.filter((item) => item.status !== 'closed').length,
      integrationFailures: this.state.integrations.filter((integration) => integration.state === 'failed_mock').length,
    };
  }

  listAudit({ objectType = null, actorId = null, limit = 100 } = {}) {
    let events = [...this.state.auditEvents];
    if (objectType) events = events.filter((event) => event.objectType === objectType);
    if (actorId) events = events.filter((event) => event.actorId === actorId);
    return clone(events.sort((left, right) => right.at.localeCompare(left.at)).slice(0, Math.min(Number(limit) || 100, 500)));
  }

  listIntegrations() {
    return clone(this.state.integrations);
  }

  simulateIntegration(slug, action, context = {}) {
    const integration = this.state.integrations.find((entry) => entry.slug === slug);
    if (!integration) throw new PlatformError('INTEGRATION_NOT_FOUND', 'Integration not found', 404);
    const event = {
      id: crypto.randomUUID(),
      integrationId: integration.id,
      action,
      outcome: action === 'simulate-failure' ? 'simulated_failure' : 'simulated_success',
      simulated: true,
      liveActionPerformed: false,
      at: nowIso(this.clock),
    };
    integration.lastTest = event;
    if (event.outcome === 'simulated_failure') integration.state = 'failed_mock';
    this.appendAudit({
      action: 'integration.simulated',
      objectType: 'integration',
      objectId: integration.id,
      actor: context.actor,
      correlationId: context.correlationId,
      summary: event,
    });
    return clone({
      integration,
      event,
      state: 'mock',
      simulated: true,
      liveActionPerformed: false,
    });
  }

  listResource(name) {
    if (name === 'customers') return clone(this.state.customers);
    if (name === 'conversations') return clone(this.state.conversations.map(({ publicTokenHash, ...conversation }) => ({ ...conversation, messages: undefined })));
    if (name === 'commissions') return clone(this.state.orders.map((order) => ({ orderId: order.id, orderNumber: order.orderNumber, status: order.commissionStatus, ledger: order.commissionLedger })));
    if (name === 'gift-cards') return clone(this.state.orders.map((order) => ({ orderId: order.id, orderNumber: order.orderNumber, status: order.giftCardStatus, valueMinor: order.giftCardValueMinor, ledger: order.giftCardLedger })));
    if (name === 'integrations') return this.listIntegrations();
    const aliases = { 'support-cases': 'support' };
    const resource = this.state.resources[aliases[name] || name];
    if (!resource) throw new PlatformError('RESOURCE_NOT_FOUND', 'Admin resource not found', 404);
    return clone(resource);
  }
}

module.exports = {
  MemoryOperationsRepository,
};
