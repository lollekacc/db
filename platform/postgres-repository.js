const crypto = require('node:crypto');
const { Pool } = require('pg');

const { PlatformError } = require('./errors');
const { buildDemoUsers } = require('./permissions');
const { assertTransition } = require('./state-machines');
const { clone, hashObject, sha256 } = require('./utils');

const STATUS_TABLES = Object.freeze({
  order: ['overall_status', 'order_status_history'],
  operator: ['operator_status', 'operator_status_history'],
  commission: ['commission_status', 'commission_status_history'],
  gift_card: ['gift_card_status', 'gift_card_status_history'],
});

const toActorSetting = (actor) => {
  if (['employee', 'partner', 'customer', 'system'].includes(actor?.actorType)) return actor.actorType;
  return 'public_capture';
};

class PostgresOperationsRepository {
  constructor({ connectionString, ssl = false, pool = null, fieldCrypto, demoMode = false }) {
    this.pool = pool || new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: true } : false,
      max: 10,
      application_name: 'dealett-backend',
    });
    this.fieldCrypto = fieldCrypto;
    this.demoMode = demoMode;
  }

  async close() {
    await this.pool.end();
  }

  async withTransaction(actor, callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.actor_type', $1, true)", [toActorSetting(actor)]);
      await client.query("SELECT set_config('app.partner_organization_id', $1, true)", [actor?.partnerOrganizationId || '']);
      await client.query("SELECT set_config('app.customer_id', $1, true)", [actor?.customerId || '']);
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendAudit(client, { action, objectType, objectId, actor, correlationId, summary = null, before = null, after = null }) {
    const result = await client.query(`
      INSERT INTO audit_events (actor_user_id, actor_type, action, object_type, object_id, correlation_id, summary, before_summary, after_summary)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      actor?.id && /^[0-9a-f-]{36}$/i.test(actor.id) ? actor.id : null,
      actor?.actorType || 'public',
      action,
      objectType,
      String(objectId),
      correlationId || crypto.randomUUID(),
      summary,
      before,
      after,
    ]);
    return result.rows[0];
  }

  async getEnvironmentSummary() {
    const result = await this.pool.query('SELECT current_database() AS database, now() AS checked_at');
    return {
      mode: this.demoMode ? 'DEMO' : 'LIVE',
      demoMode: this.demoMode,
      repository: 'postgres',
      database: result.rows[0].database,
      checkedAt: result.rows[0].checked_at,
      liveAuthentication: false,
    };
  }

  async getUsers() {
    return this.demoMode ? buildDemoUsers() : {};
  }

  async createConversation({ id = null, token: suppliedToken = null, customerId = null, language = 'sv', sourcePage = null, attribution = null }, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      if (id) {
        const existing = await client.query('SELECT * FROM conversations WHERE id = $1', [id]);
        if (existing.rows[0]) {
          if (!suppliedToken || sha256(suppliedToken) !== existing.rows[0].public_token_hash) {
            throw new PlatformError('CONVERSATION_ID_CONFLICT', 'Conversation identifier is unavailable; create a new conversation identifier', 409);
          }
          return { conversation: await this.getConversation(id, { token: suppliedToken, requireToken: true }, client), token: suppliedToken, existing: true };
        }
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const result = await client.query(`
        INSERT INTO conversations (id, public_token_hash, customer_id, language, source_page, attribution)
        VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6)
        RETURNING *
      `, [id, sha256(token), customerId, language, sourcePage, attribution || {}]);
      const row = result.rows[0];
      await this.appendAudit(client, {
        action: 'conversation.created', objectType: 'conversation', objectId: row.id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { language, sourcePage },
      });
      return { conversation: this.mapConversation(row, []), token, existing: false };
    });
  }

  mapConversation(row, messages) {
    return {
      id: row.id,
      customerId: row.customer_id,
      status: row.status,
      language: row.language,
      sourcePage: row.source_page,
      attribution: row.attribution,
      qualification: row.qualification,
      flowState: row.flow_state,
      archivedAt: row.archived_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: messages.map((message) => ({
        id: message.id,
        clientMessageId: message.client_message_id,
        sequence: message.sequence,
        role: message.role,
        content: this.decryptMessageContent(message),
        structuredContent: message.structured_content,
        language: message.language,
        model: message.model_name,
        relatedMessageId: message.related_message_id,
        clientCreatedAt: message.client_created_at,
        createdAt: message.created_at,
      })),
    };
  }

  decryptMessageContent(message) {
    return message.content_encrypted
      ? this.fieldCrypto.decrypt(message.content_encrypted)
      : message.content_text;
  }

  async getConversation(id, { token = null, requireToken = false } = {}, existingClient = null) {
    const run = async (client) => {
      const conversationResult = await client.query('SELECT * FROM conversations WHERE id = $1', [id]);
      const row = conversationResult.rows[0];
      if (!row) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
      if (requireToken && (!token || sha256(token) !== row.public_token_hash)) {
        throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
      }
      const messages = await client.query('SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence', [id]);
      return this.mapConversation(row, messages.rows);
    };
    if (existingClient) return run(existingClient);
    const client = await this.pool.connect();
    try { return await run(client); } finally { client.release(); }
  }

  async appendConversationMessage(id, message, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      const conversationResult = await client.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [id]);
      const conversation = conversationResult.rows[0];
      if (!conversation) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
      if (conversation.status === 'archived' || conversation.archived_at) throw new PlatformError('CONVERSATION_ARCHIVED', 'Archived conversations are immutable', 409);
      if (!context.token || sha256(context.token) !== conversation.public_token_hash) {
        throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
      }
      if (message.clientMessageId) {
        const existing = await client.query(
          'SELECT * FROM conversation_messages WHERE conversation_id = $1 AND client_message_id = $2',
          [id, message.clientMessageId]
        );
        if (existing.rows[0]) return { message: this.mapConversation(conversation, existing.rows).messages[0], replayed: true };
      }
      const sequenceResult = await client.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM conversation_messages WHERE conversation_id = $1',
        [id]
      );
      const sequence = Number(sequenceResult.rows[0].next_sequence);
      if (message.requestedSequence !== null && message.requestedSequence !== undefined && Number(message.requestedSequence) !== sequence) {
        throw new PlatformError('CONVERSATION_SEQUENCE_CONFLICT', 'Conversation message sequence is not the next expected value', 409, {
          expected: sequence,
          received: Number(message.requestedSequence),
        });
      }
      const result = await client.query(`
        INSERT INTO conversation_messages (
          conversation_id, client_message_id, sequence, role, content_encrypted, structured_content,
          language, model_name, related_message_id, client_created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
      `, [
        id, message.clientMessageId, sequence, message.role, this.fieldCrypto.encrypt(message.content),
        message.structuredContent, message.language, message.model,
        message.relatedMessageId, message.clientCreatedAt,
      ]);
      await client.query('UPDATE conversations SET updated_at = now(), version = version + 1 WHERE id = $1', [id]);
      await this.appendAudit(client, {
        action: 'conversation.message_appended', objectType: 'conversation', objectId: id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { messageId: result.rows[0].id, sequence, role: message.role },
      });
      return { message: this.mapConversation(conversation, result.rows).messages[0], replayed: false };
    });
  }

  async createQuote(quote, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      const result = await client.query(`
        INSERT INTO quotes (selected_offer_id, snapshot, snapshot_hash, mode, expires_at)
        VALUES ($1,$2,$3,$4,$5) RETURNING *
      `, [quote.selectedOfferId, quote.snapshot, quote.snapshotHash, quote.mode, quote.expiresAt]);
      const row = result.rows[0];
      await this.appendAudit(client, {
        action: 'quote.created', objectType: 'quote', objectId: row.id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { selectedOfferId: quote.selectedOfferId, expiresAt: quote.expiresAt },
      });
      return this.mapQuote(row);
    });
  }

  mapQuote(row) {
    return {
      id: row.id,
      selectedOfferId: row.selected_offer_id,
      snapshot: row.snapshot,
      snapshotHash: row.snapshot_hash,
      mode: row.mode,
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      createdAt: row.created_at,
    };
  }

  async getQuote(id) {
    const result = await this.pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
    if (!result.rows[0]) throw new PlatformError('QUOTE_NOT_FOUND', 'Quote not found', 404);
    return this.mapQuote(result.rows[0]);
  }

  async createOrderAtomic(command, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      const claimed = await client.query(`
        INSERT INTO idempotency_keys (scope, key, request_hash)
        VALUES ('public_order', $1, $2)
        ON CONFLICT DO NOTHING RETURNING *
      `, [command.idempotencyKey, command.requestHash]);
      if (!claimed.rows[0]) {
        const existing = await client.query(
          "SELECT * FROM idempotency_keys WHERE scope = 'public_order' AND key = $1 FOR UPDATE",
          [command.idempotencyKey]
        );
        const record = existing.rows[0];
        if (record.request_hash !== command.requestHash) {
          throw new PlatformError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different request', 409);
        }
        if (!record.resource_id || !record.response_body) throw new PlatformError('IDEMPOTENCY_IN_PROGRESS', 'The original request is still processing', 409);
        return { order: null, receipt: record.response_body, replayed: true };
      }

      const quoteResult = await client.query('SELECT * FROM quotes WHERE id = $1 FOR UPDATE', [command.quoteId]);
      const quote = quoteResult.rows[0];
      if (!quote) throw new PlatformError('QUOTE_NOT_FOUND', 'Quote not found', 404);
      if (new Date(quote.expires_at).getTime() <= Date.now()) throw new PlatformError('QUOTE_EXPIRED', 'Quote has expired and must be recalculated', 409);
      const snapshot = quote.snapshot;
      const selected = snapshot.selectedOffer;
      const monthlyValueMinor = Number(snapshot.aggregateMonthlyValueMinor ?? selected.monthlyPriceMinor) || 0;
      const giftCardValueMinor = Number(snapshot.aggregateGiftCardValueMinor ?? selected.giftCardValueMinor) || 0;

      const customerResult = await client.query(`
        INSERT INTO customers (display_name, preferred_language, classification)
        VALUES ($1,$2,'submitted_customer_data') RETURNING *
      `, [command.customer.displayName, command.customer.language]);
      const customer = customerResult.rows[0];
      const emailHash = sha256(command.customer.email.toLowerCase());
      const phoneHash = sha256(command.customer.phone.replace(/\s+/g, ''));
      await client.query(`
        INSERT INTO customer_contact_methods (customer_id, contact_type, value_encrypted, normalized_hash, display_mask, is_primary)
        VALUES ($1,'email',$2,$3,$4,true), ($1,'phone',$5,$6,$7,true)
      `, [
        customer.id, this.fieldCrypto.encrypt(command.customer.email), emailHash, command.customer.email.replace(/^(.).+(@.+)$/, '$1***$2'),
        this.fieldCrypto.encrypt(command.customer.phone), phoneHash, command.customer.phone.replace(/.(?=.{4})/g, '*'),
      ]);
      if (command.customer.address?.line1) {
        await client.query(`
          INSERT INTO customer_addresses (customer_id, line1_encrypted, postal_code, city, country_code)
          VALUES ($1,$2,$3,$4,$5)
        `, [customer.id, this.fieldCrypto.encrypt(command.customer.address.line1), command.customer.address.postalCode, command.customer.address.city, command.customer.address.countryCode]);
      }

      const sequenceResult = await client.query("SELECT nextval('order_number_sequence') AS value");
      const orderNumber = `DLT-${new Date().getUTCFullYear()}-${String(sequenceResult.rows[0].value).padStart(6, '0')}`;
      const publicReference = crypto.randomBytes(9).toString('base64url').toUpperCase();
      const orderId = crypto.randomUUID();
      await client.query("SELECT set_config('app.capture_order_id', $1, true)", [orderId]);
      const operatorResult = await client.query('SELECT id, partner_organization_id FROM operators WHERE lower(name) = lower($1)', [selected.operator]);
      const operator = operatorResult.rows[0] || {};
      const orderResult = await client.query(`
        INSERT INTO orders (
          id, order_number, public_reference, customer_id, partner_organization_id, quote_id, source,
          overall_status, operator_status, commission_status, gift_card_status, submitted_at,
          attribution, safe_technical_metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,'public_v1','submitted','not_ready','expected',$7,now(),$8,$9)
        RETURNING *
      `, [
        orderId, orderNumber, publicReference, customer.id, operator.partner_organization_id || null, quote.id,
        giftCardValueMinor > 0 ? 'eligible' : 'not_eligible',
        command.attribution, command.safeTechnicalMetadata,
      ]);
      const orderRow = orderResult.rows[0];

      for (let index = 0; index < command.participants.length; index += 1) {
        const participant = command.participants[index];
        const participantResult = await client.query(`
          INSERT INTO order_participants (
            order_id, sequence, external_participant_id, display_label, given_name_encrypted, family_name_encrypted,
            current_operator, binding_end, requested_activation_date
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
        `, [
          orderRow.id, index + 1, participant.participantId, participant.label,
          this.fieldCrypto.encrypt(participant.givenName), this.fieldCrypto.encrypt(participant.familyName),
          participant.currentOperator, participant.bindingEnd || null, participant.requestedActivationDate || null,
        ]);
        await client.query(`
          INSERT INTO order_subscriptions (
            order_id, participant_id, sequence, external_subscription_id, product_type, selected_operator_id, selected_plan_key,
            current_operator, phone_number_encrypted, phone_number_mask, number_handling, requested_activation_date
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
          orderRow.id, participantResult.rows[0].id, index + 1, participant.subscriptionId, selected.productType,
          operator.id || null, selected.planId, participant.currentOperator,
          this.fieldCrypto.encrypt(participant.phoneNumber), participant.phoneNumber?.replace(/.(?=.{4})/g, '*') || null,
          participant.numberHandling, participant.requestedActivationDate || null,
        ]);
      }

      await client.query(`
        INSERT INTO order_snapshots (
          order_id, catalog_version_key, rule_version_key, campaign_version_key,
          offer_snapshot, price_snapshot, benefit_snapshot, calculation_inputs, calculation_outputs,
          calculation_explanation, alternatives_snapshot, full_snapshot, snapshot_hash,
          monthly_value_minor, gift_card_value_minor, commission_expected_minor
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        orderRow.id, snapshot.catalogVersion, snapshot.ruleVersion, snapshot.campaignVersion,
        selected,
        { monthlyPriceMinor: selected.monthlyPriceMinor, aggregateMonthlyValueMinor: monthlyValueMinor, pricePerPersonMinor: selected.pricePerPersonMinor, currency: selected.currency },
        { benefits: selected.benefits, streaming: selected.includedStreamingServices, international: selected.international },
        snapshot.qualification, snapshot.calculation,
        { calculationVersion: snapshot.calculationVersion, sourceEvidence: snapshot.sourceEvidence },
        snapshot.alternatives, snapshot, quote.snapshot_hash,
        monthlyValueMinor, giftCardValueMinor, snapshot.commissionExpectedMinor || 0,
      ]);

      for (const consent of command.consents) {
        const documentResult = await client.query(`
          INSERT INTO consent_documents (stable_key, version, document_type, content_hash)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT (stable_key, version) DO UPDATE SET content_hash = COALESCE(consent_documents.content_hash, EXCLUDED.content_hash)
          RETURNING id
        `, [consent.documentId, consent.documentVersion, consent.type, consent.textHash]);
        await client.query(`
          INSERT INTO consent_records (
            customer_id, order_id, consent_document_id, consent_type, document_key, document_version,
            accepted, accepted_at, text_hash, evidence
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [customer.id, orderRow.id, documentResult.rows[0].id, consent.type, consent.documentId, consent.documentVersion, consent.accepted, consent.acceptedAt, consent.textHash, consent.evidence]);
      }

      let conversationArchive = null;
      if (command.conversationId) {
        const conversationResult = await client.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [command.conversationId]);
        const conversation = conversationResult.rows[0];
        if (!conversation) throw new PlatformError('CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
        if (!command.conversationToken || sha256(command.conversationToken) !== conversation.public_token_hash) {
          throw new PlatformError('CONVERSATION_ACCESS_DENIED', 'Conversation token is invalid', 403);
        }
        const messagesResult = await client.query('SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence', [conversation.id]);
        messagesResult.rows.forEach((message, index) => {
          if (message.sequence !== index + 1 || !message.created_at) {
            throw new PlatformError('CONVERSATION_SEQUENCE_INVALID', 'Conversation sequence is incomplete', 409);
          }
        });
        const archiveHash = hashObject(messagesResult.rows.map((message) => ({
          id: message.id, sequence: message.sequence, role: message.role, content: this.decryptMessageContent(message),
          structuredContent: message.structured_content, language: message.language, model: message.model_name,
          clientCreatedAt: message.client_created_at, createdAt: message.created_at,
        })));
        const archiveResult = await client.query(`
          INSERT INTO order_conversation_archives (
            order_id, conversation_id, archived_at, message_count, first_sequence, last_sequence, archive_hash
          ) VALUES ($1,$2,now(),$3,$4,$5,$6) RETURNING *
        `, [orderRow.id, conversation.id, messagesResult.rows.length, messagesResult.rows[0]?.sequence || null, messagesResult.rows.at(-1)?.sequence || null, archiveHash]);
        for (const message of messagesResult.rows) {
          await client.query(`
            INSERT INTO order_conversation_archive_messages (
              archive_id, source_message_id, sequence, role, content_encrypted, structured_content,
              language, model_name, client_created_at, original_created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          `, [archiveResult.rows[0].id, message.id, message.sequence, message.role, this.fieldCrypto.encrypt(this.decryptMessageContent(message)), message.structured_content, message.language, message.model_name, message.client_created_at, message.created_at]);
        }
        await client.query("UPDATE conversations SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1", [conversation.id]);
        conversationArchive = {
          conversationId: conversation.id,
          archivedAt: archiveResult.rows[0].archived_at,
          messageCount: messagesResult.rows.length,
          firstSequence: messagesResult.rows[0]?.sequence || null,
          lastSequence: messagesResult.rows.at(-1)?.sequence || null,
          hash: archiveHash,
          messages: messagesResult.rows.map((message) => ({
            id: message.id, sequence: message.sequence, role: message.role, content: this.decryptMessageContent(message),
            structuredContent: message.structured_content, language: message.language,
            model: message.model_name, clientCreatedAt: message.client_created_at, createdAt: message.created_at,
          })),
        };
      }

      const historyValues = [orderRow.id, context.actor?.id && /^[0-9a-f-]{36}$/i.test(context.actor.id) ? context.actor.id : null, context.correlationId];
      await client.query("INSERT INTO order_status_history (order_id,to_status,actor_user_id,reason,correlation_id) VALUES ($1,'submitted',$2,'Public checkout accepted',$3)", historyValues);
      await client.query("INSERT INTO operator_status_history (order_id,to_status,actor_user_id,reason,correlation_id) VALUES ($1,'not_ready',$2,'Awaiting internal review',$3)", historyValues);
      await client.query("INSERT INTO commission_status_history (order_id,to_status,actor_user_id,reason,correlation_id) VALUES ($1,'expected',$2,'Created from order snapshot',$3)", historyValues);
      await client.query(`INSERT INTO gift_card_status_history (order_id,to_status,actor_user_id,reason,correlation_id)
        VALUES ($1,$4,$2,'Created from rule snapshot',$3)`, [...historyValues, giftCardValueMinor > 0 ? 'eligible' : 'not_eligible']);
      await client.query(`INSERT INTO commission_entries (order_id,operator_id,entry_type,amount_minor,simulated)
        VALUES ($1,$2,'expectation',$3,$4)`, [orderRow.id, operator.id || null, snapshot.commissionExpectedMinor || 0, this.demoMode]);
      if (giftCardValueMinor > 0) {
        const entitlement = await client.query(`INSERT INTO gift_card_entitlements
          (order_id,customer_id,amount_minor,status,eligible_at) VALUES ($1,$2,$3,'eligible',now()) RETURNING id`,
        [orderRow.id, customer.id, giftCardValueMinor]);
        await client.query(`INSERT INTO gift_card_entries (entitlement_id,entry_type,amount_minor,simulated)
          VALUES ($1,'entitlement',$2,$3)`, [entitlement.rows[0].id, giftCardValueMinor, this.demoMode]);
      }
      await this.appendAudit(client, {
        action: 'order.created', objectType: 'order', objectId: orderRow.id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { orderNumber, snapshotHash: quote.snapshot_hash, conversationMessageCount: conversationArchive?.messageCount || 0 },
      });
      await client.query(`INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
        VALUES ('order',$1,'order.created',$2)`, [orderRow.id, { orderNumber }]);

      const order = {
        id: orderRow.id,
        orderNumber,
        publicReference,
        customerId: customer.id,
        customer: clone(command.customer),
        partnerOrganizationId: operator.partner_organization_id || null,
        operator: selected.operator,
        planName: selected.title,
        status: 'submitted',
        operatorStatus: 'not_ready',
        commissionStatus: 'expected',
        giftCardStatus: giftCardValueMinor > 0 ? 'eligible' : 'not_eligible',
        version: 1,
        createdAt: orderRow.created_at,
        submittedAt: orderRow.submitted_at,
        monthlyValueMinor,
        giftCardValueMinor,
        subscriptionCount: command.participants.length,
        participants: clone(command.participants),
        consents: clone(command.consents),
        attribution: clone(command.attribution),
        snapshot: clone(snapshot),
        snapshotHash: quote.snapshot_hash,
        conversationArchive,
      };
      const receipt = {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderReference: order.orderNumber,
        publicReference: order.publicReference,
        status: order.status,
        acceptedAt: order.createdAt,
        testMode: this.demoMode,
        simulated: this.demoMode,
      };
      await client.query(`UPDATE idempotency_keys SET resource_id=$1,response_status=201,response_body=$2
        WHERE scope='public_order' AND key=$3`, [order.id, receipt, command.idempotencyKey]);
      return { order, receipt, replayed: false };
    });
  }

  async getOrderWithClient(client, id, actor = null) {
    const result = await client.query(`
      SELECT o.*, c.display_name, c.preferred_language, s.full_snapshot, s.snapshot_hash,
             s.monthly_value_minor, s.gift_card_value_minor
      FROM orders o JOIN customers c ON c.id=o.customer_id JOIN order_snapshots s ON s.order_id=o.id
      WHERE o.id=$1 OR o.order_number=$2 OR o.public_reference=$2
    `, [UUID_PATTERN.test(String(id)) ? id : null, String(id)]);
    const row = result.rows[0];
    if (!row) throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
    const contacts = await client.query('SELECT * FROM customer_contact_methods WHERE customer_id=$1', [row.customer_id]);
    const participants = await client.query(`SELECT p.*, s.external_subscription_id,s.phone_number_encrypted,s.phone_number_mask,s.number_handling
      FROM order_participants p LEFT JOIN order_subscriptions s ON s.participant_id=p.id WHERE p.order_id=$1 ORDER BY p.sequence`, [row.id]);
    const consents = await client.query('SELECT * FROM consent_records WHERE order_id=$1 ORDER BY accepted_at', [row.id]);
    const archive = await client.query('SELECT * FROM order_conversation_archives WHERE order_id=$1', [row.id]);
    let conversationArchive = null;
    if (archive.rows[0]) {
      const messages = await client.query('SELECT * FROM order_conversation_archive_messages WHERE archive_id=$1 ORDER BY sequence', [archive.rows[0].id]);
      conversationArchive = {
        conversationId: archive.rows[0].conversation_id, archivedAt: archive.rows[0].archived_at,
        messageCount: archive.rows[0].message_count, firstSequence: archive.rows[0].first_sequence,
        lastSequence: archive.rows[0].last_sequence, hash: archive.rows[0].archive_hash,
        messages: messages.rows.map((message) => ({
          id: message.source_message_id, sequence: message.sequence, role: message.role,
          content: this.decryptMessageContent(message), structuredContent: message.structured_content,
          language: message.language, model: message.model_name,
          clientCreatedAt: message.client_created_at, createdAt: message.original_created_at,
        })),
      };
    }
    const email = contacts.rows.find((contact) => contact.contact_type === 'email');
    const phone = contacts.rows.find((contact) => contact.contact_type === 'phone');
    return {
      id: row.id,
      orderNumber: row.order_number,
      publicReference: row.public_reference,
      customerId: row.customer_id,
      customer: {
        displayName: row.display_name,
        email: email ? this.fieldCrypto.decrypt(email.value_encrypted) : null,
        phone: phone ? this.fieldCrypto.decrypt(phone.value_encrypted) : null,
        language: row.preferred_language,
      },
      partnerOrganizationId: row.partner_organization_id,
      operator: row.full_snapshot.selectedOffer.operator,
      planName: row.full_snapshot.selectedOffer.title,
      status: row.overall_status,
      operatorStatus: row.operator_status,
      commissionStatus: row.commission_status,
      giftCardStatus: row.gift_card_status,
      supportStatus: row.support_status,
      version: row.version,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      monthlyValueMinor: Number(row.monthly_value_minor),
      giftCardValueMinor: Number(row.gift_card_value_minor),
      subscriptionCount: participants.rows.length,
      participants: participants.rows.map((participant) => ({
        id: participant.id, participantId: participant.external_participant_id,
        subscriptionId: participant.external_subscription_id, label: participant.display_label, currentOperator: participant.current_operator,
        bindingEnd: participant.binding_end, requestedActivationDate: participant.requested_activation_date,
        phoneNumber: participant.phone_number_encrypted ? this.fieldCrypto.decrypt(participant.phone_number_encrypted) : null,
        phoneNumberMasked: participant.phone_number_mask, numberHandling: participant.number_handling,
      })),
      consents: consents.rows.map((consent) => ({
        type: consent.consent_type, documentId: consent.document_key, documentVersion: consent.document_version,
        accepted: consent.accepted, acceptedAt: consent.accepted_at, textHash: consent.text_hash, evidence: consent.evidence,
      })),
      attribution: row.attribution,
      snapshot: row.full_snapshot,
      snapshotHash: row.snapshot_hash,
      conversationArchive,
    };
  }

  async getOrder(id, actor = null) {
    return this.withTransaction(actor, (client) => this.getOrderWithClient(client, id, actor));
  }

  async listOrders({ actor = null, filters = {}, page = 1, pageSize = 25 } = {}) {
    return this.withTransaction(actor, async (client) => {
      const safePage = Math.max(Number(page) || 1, 1);
      const safePageSize = Math.max(1, Math.min(Number(pageSize) || 25, 100));
      const values = [];
      const conditions = [];
      const add = (sql, value) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
      if (filters.status) add('o.overall_status = ?', filters.status);
      if (filters.operator) add("lower(s.offer_snapshot->>'operator') = lower(?)", filters.operator);
      if (filters.commissionStatus) add('o.commission_status = ?', filters.commissionStatus);
      if (filters.giftCardStatus) add('o.gift_card_status = ?', filters.giftCardStatus);
      if (filters.search) {
        values.push(`%${String(filters.search).replace(/[%_]/g, '\\$&')}%`);
        conditions.push(`(o.order_number ILIKE $${values.length} OR o.public_reference ILIKE $${values.length} OR c.display_name ILIKE $${values.length})`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const count = await client.query(`SELECT count(*) FROM orders o JOIN customers c ON c.id=o.customer_id JOIN order_snapshots s ON s.order_id=o.id ${where}`, values);
      values.push(safePageSize, (safePage - 1) * safePageSize);
      const rows = await client.query(`
        SELECT o.id FROM orders o JOIN customers c ON c.id=o.customer_id JOIN order_snapshots s ON s.order_id=o.id
        ${where} ORDER BY o.submitted_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}
      `, values);
      const items = [];
      for (const row of rows.rows) items.push(await this.getOrderWithClient(client, row.id, actor));
      const total = Number(count.rows[0].count);
      return { items, page: safePage, pageSize: safePageSize, total, totalPages: Math.max(Math.ceil(total / safePageSize), 1) };
    });
  }

  async transitionOrder(id, { machine, to, reason, note = null, expectedVersion, amountMinor = null }, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      const [column, historyTable] = STATUS_TABLES[machine] || [];
      if (!column) throw new PlatformError('INVALID_STATE_MACHINE', 'Invalid state machine', 400);
      const rowResult = await client.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [id]);
      const row = rowResult.rows[0];
      if (!row) throw new PlatformError('ORDER_NOT_FOUND', 'Order not found', 404);
      if (Number(expectedVersion) !== row.version) throw new PlatformError('VERSION_CONFLICT', 'Order was changed by another user', 409, { currentVersion: row.version });
      const from = row[column];
      assertTransition(machine, from, to);
      await client.query(`UPDATE orders SET ${column}=$1,version=version+1 WHERE id=$2`, [to, id]);
      await client.query(`INSERT INTO ${historyTable} (order_id,from_status,to_status,actor_user_id,reason,note,correlation_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, from, to, context.actor?.id || null, reason, note, context.correlationId]);
      if (machine === 'commission' && amountMinor !== null) {
        await client.query(`INSERT INTO commission_entries (order_id,entry_type,amount_minor,simulated)
          VALUES ($1,'adjustment',$2,$3)`, [id, amountMinor, this.demoMode]);
      }
      if (machine === 'gift_card' && amountMinor !== null) {
        const entitlement = await client.query('SELECT id FROM gift_card_entitlements WHERE order_id=$1', [id]);
        if (entitlement.rows[0]) await client.query(`INSERT INTO gift_card_entries (entitlement_id,entry_type,amount_minor,simulated)
          VALUES ($1,'approval',$2,$3)`, [entitlement.rows[0].id, amountMinor, this.demoMode]);
      }
      await this.appendAudit(client, {
        action: `order.${machine}_status_changed`, objectType: 'order', objectId: id,
        actor: context.actor, correlationId: context.correlationId, summary: { reason, note },
        before: { [column]: from, version: row.version }, after: { [column]: to, version: row.version + 1 },
      });
      return this.getOrderWithClient(client, id, context.actor);
    });
  }

  async createReport(id, context = {}) {
    return this.withTransaction(context.actor, async (client) => {
      const order = await this.getOrderWithClient(client, id, context.actor);
      const versionResult = await client.query("SELECT COALESCE(MAX(version),0)+1 AS version FROM generated_reports WHERE order_id=$1 AND report_type='manual_operator_order'", [id]);
      const version = Number(versionResult.rows[0].version);
      const payload = {
        reportType: 'manual_operator_order', version, generatedAt: new Date().toISOString(), order,
        archiveIntegrity: { orderSnapshotHash: order.snapshotHash, conversationArchiveHash: order.conversationArchive?.hash || null },
      };
      const storedPayload = {
        reportType: payload.reportType,
        version,
        generatedAt: payload.generatedAt,
        orderId: order.id,
        orderNumber: order.orderNumber,
        operator: order.operator,
        planName: order.planName,
        status: order.status,
        snapshotHash: order.snapshotHash,
        archiveHash: order.conversationArchive?.hash || null,
      };
      const result = await client.query(`INSERT INTO generated_reports
        (order_id,report_type,version,source_snapshot_hash,archive_hash,payload,payload_encrypted,status,generated_by,generated_at)
        VALUES ($1,'manual_operator_order',$2,$3,$4,$5,$6,'generated',$7,now()) RETURNING *`,
      [id, version, order.snapshotHash, order.conversationArchive?.hash || null, storedPayload, this.fieldCrypto.encrypt(JSON.stringify(payload)), context.actor?.id || null]);
      await this.appendAudit(client, {
        action: 'order.report_generated', objectType: 'order', objectId: id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { reportId: result.rows[0].id, version },
      });
      return { id: result.rows[0].id, orderId: id, version, generatedAt: result.rows[0].generated_at, format: 'json', simulated: this.demoMode, payload, hash: hashObject(payload) };
    });
  }

  async getReport(id, actor = null) {
    return this.withTransaction(actor, async (client) => {
      const result = await client.query('SELECT * FROM generated_reports WHERE id=$1', [id]);
      if (!result.rows[0]) throw new PlatformError('REPORT_NOT_FOUND', 'Report not found', 404);
      await this.getOrderWithClient(client, result.rows[0].order_id, actor);
      const payload = result.rows[0].payload_encrypted
        ? JSON.parse(this.fieldCrypto.decrypt(result.rows[0].payload_encrypted))
        : result.rows[0].payload;
      return { id: result.rows[0].id, orderId: result.rows[0].order_id, version: result.rows[0].version, generatedAt: result.rows[0].generated_at, format: 'json', simulated: this.demoMode, payload };
    });
  }

  async getDashboard(actor) {
    return this.withTransaction(actor, async (client) => {
      const result = await client.query(`SELECT
      count(*) AS purchases,
      count(*) FILTER (WHERE overall_status IN ('submitted','ready_internal_review','fraud_review')) AS requiring_attention,
      count(*) FILTER (WHERE overall_status IN ('activated','completed')) AS activated,
      count(*) FILTER (WHERE overall_status='rejected') AS rejected
      FROM orders`);
      const row = result.rows[0];
      return { mode: this.demoMode ? 'DEMO' : 'LIVE', simulated: this.demoMode, purchases: Number(row.purchases), requiringAttention: Number(row.requiring_attention), activated: Number(row.activated), rejected: Number(row.rejected) };
    });
  }

  async listAudit({ objectType = null, actorId = null, limit = 100, actor = null } = {}) {
    const values = [];
    const conditions = [];
    if (objectType) { values.push(objectType); conditions.push(`object_type=$${values.length}`); }
    if (actorId) { values.push(actorId); conditions.push(`actor_user_id=$${values.length}`); }
    values.push(Math.min(Number(limit) || 100, 500));
    return this.withTransaction(actor, async (client) => {
      const result = await client.query(`SELECT * FROM audit_events ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT $${values.length}`, values);
      return result.rows;
    });
  }

  async listIntegrations() {
    const result = await this.pool.query('SELECT id,stable_key AS slug,name,mode,state,capabilities,last_sync_at AS "lastSyncAt" FROM integrations ORDER BY name');
    return result.rows.map((row) => ({ ...row, simulated: row.mode === 'mock' }));
  }

  async simulateIntegration(slug, action, context = {}) {
    if (!this.demoMode) throw new PlatformError('MOCK_ONLY', 'Mock integration actions are disabled in live PostgreSQL mode', 409);
    return this.withTransaction(context.actor, async (client) => {
      const integration = await client.query('SELECT * FROM integrations WHERE stable_key=$1 FOR UPDATE', [slug]);
      const row = integration.rows[0];
      if (!row) throw new PlatformError('INTEGRATION_NOT_FOUND', 'Integration not found', 404);
      if (row.mode !== 'mock') throw new PlatformError('MOCK_ONLY', 'Only mock integrations can be simulated', 409);
      const run = await client.query(`INSERT INTO integration_sync_jobs
        (integration_id,job_type,status,started_at,completed_at,summary,simulated)
        VALUES ($1,$2,'succeeded',now(),now(),$3,true) RETURNING *`, [
        row.id,
        action,
        { simulated: true, liveActionPerformed: false, correlationId: context.correlationId },
      ]);
      await client.query('UPDATE integrations SET last_sync_at=now(),updated_at=now() WHERE id=$1', [row.id]);
      await this.appendAudit(client, {
        action: 'integration.mock_simulated', objectType: 'integration', objectId: row.id,
        actor: context.actor, correlationId: context.correlationId,
        summary: { requestedAction: action, simulated: true, liveActionPerformed: false },
      });
      return {
        integration: row.stable_key,
        requestedAction: action,
        runId: run.rows[0].id,
        state: 'mock',
        simulated: true,
        liveActionPerformed: false,
      };
    });
  }

  async listResource(name, actor = null) {
    const queries = {
      customers: `SELECT c.id,c.display_name AS "displayName",c.preferred_language AS language,c.classification,c.created_at AS "createdAt",
        (SELECT value_encrypted FROM customer_contact_methods WHERE customer_id=c.id AND contact_type='email' ORDER BY is_primary DESC,created_at LIMIT 1) AS "emailEncrypted",
        (SELECT display_mask FROM customer_contact_methods WHERE customer_id=c.id AND contact_type='email' ORDER BY is_primary DESC,created_at LIMIT 1) AS "emailMask",
        (SELECT value_encrypted FROM customer_contact_methods WHERE customer_id=c.id AND contact_type='phone' ORDER BY is_primary DESC,created_at LIMIT 1) AS "phoneEncrypted",
        (SELECT display_mask FROM customer_contact_methods WHERE customer_id=c.id AND contact_type='phone' ORDER BY is_primary DESC,created_at LIMIT 1) AS "phoneMask"
        FROM customers c ORDER BY c.created_at DESC LIMIT 200`,
      conversations: 'SELECT id,status,language,source_page AS "sourcePage",created_at AS "createdAt",archived_at AS "archivedAt" FROM conversations ORDER BY created_at DESC LIMIT 200',
      operators: 'SELECT id,slug,name,status FROM operators ORDER BY name',
      rules: 'SELECT rv.id,rs.name,rs.rule_type AS type,rv.version,rv.state,rv.effective_from AS "effectiveFrom" FROM rule_versions rv JOIN rule_sets rs ON rs.id=rv.rule_set_id ORDER BY rv.created_at DESC LIMIT 200',
      campaigns: 'SELECT cv.id,c.name,cv.version,cv.state,cv.effective_from AS "effectiveFrom",cv.effective_to AS "effectiveTo" FROM campaign_versions cv JOIN campaigns c ON c.id=cv.campaign_id ORDER BY cv.created_at DESC LIMIT 200',
      'gift-cards': 'SELECT ge.id,o.order_number AS "orderNumber",ge.amount_minor AS "amountMinor",ge.currency,ge.status,ge.waiting_until AS "waitingUntil" FROM gift_card_entitlements ge JOIN orders o ON o.id=ge.order_id ORDER BY ge.created_at DESC LIMIT 200',
      commissions: 'SELECT ce.id,o.order_number AS "orderNumber",ce.entry_type AS type,ce.amount_minor AS "amountMinor",ce.currency,ce.effective_at AS "effectiveAt" FROM commission_entries ce JOIN orders o ON o.id=ce.order_id ORDER BY ce.created_at DESC LIMIT 200',
      'support-cases': 'SELECT id,case_number AS "caseNumber",subject,category,priority,status,service_target_at AS "serviceTargetAt" FROM support_cases ORDER BY created_at DESC LIMIT 200',
      communications: 'SELECT id,channel,recipient_mask AS recipient,status,simulated,created_at AS "createdAt" FROM customer_communications ORDER BY created_at DESC LIMIT 200',
      analytics: 'SELECT event_type AS event,count(*)::integer AS count FROM analytics_events GROUP BY event_type ORDER BY event_type',
      tasks: 'SELECT id,title,status,priority,due_at AS "dueAt" FROM tasks ORDER BY created_at DESC LIMIT 200',
      documents: 'SELECT id,name,document_type AS type,classification,status,created_at AS "createdAt" FROM documents ORDER BY created_at DESC LIMIT 200',
      integrations: 'SELECT id,stable_key AS slug,name,mode,state,last_sync_at AS "lastSyncAt" FROM integrations ORDER BY name',
      employees: 'SELECT e.id,u.display_name AS name,u.status,e.title FROM employees e JOIN app_users u ON u.id=e.user_id ORDER BY u.display_name',
      compliance: 'SELECT id,request_number AS "requestNumber",request_type AS type,status,due_at AS "dueAt" FROM gdpr_requests ORDER BY received_at DESC LIMIT 200',
      settings: 'SELECT key,value,classification,version,updated_at AS "updatedAt" FROM application_settings ORDER BY key',
    };
    if (!queries[name]) throw new PlatformError('RESOURCE_NOT_FOUND', 'Admin resource not found', 404);
    return this.withTransaction(actor, async (client) => {
      const result = await client.query(queries[name]);
      if (name === 'customers') {
        const mayViewSensitive = actor?.permissions?.includes('sensitive_data.view');
        return result.rows.map(({ emailEncrypted, phoneEncrypted, ...row }) => ({
          ...row,
          email: mayViewSensitive && emailEncrypted ? this.fieldCrypto.decrypt(emailEncrypted) : (row.emailMask || null),
          phone: mayViewSensitive && phoneEncrypted ? this.fieldCrypto.decrypt(phoneEncrypted) : (row.phoneMask || null),
        }));
      }
      return result.rows;
    });
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

module.exports = {
  PostgresOperationsRepository,
};
