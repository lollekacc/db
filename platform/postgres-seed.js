const { buildDemoState } = require('./demo-data');
const { PERMISSIONS, ROLE_PERMISSIONS } = require('./permissions');
const { hashObject, stableUuid } = require('./utils');

const DEMO_ROLE_ID = '70000000-0000-4000-8000-000000000001';
const DEMO_CATALOG_ID = '70000000-0000-4000-8000-000000000002';
const DEMO_RULE_SET_ID = '70000000-0000-4000-8000-000000000003';
const DEMO_RULE_VERSION_ID = '70000000-0000-4000-8000-000000000004';
const DEMO_CAMPAIGN_ID = '70000000-0000-4000-8000-000000000005';
const DEMO_CAMPAIGN_VERSION_ID = '70000000-0000-4000-8000-000000000006';
const SEEDED_ROLES = Object.freeze({
  owner: 'Owner',
  operations_manager: 'Operations Manager',
  sales_manager: 'Sales Manager',
  seller: 'Seller',
  customer_support: 'Customer Support',
  finance: 'Finance',
  compliance_gdpr: 'Compliance / GDPR',
  offers_content_manager: 'Offers & Content Manager',
  analyst_read_only: 'Analyst / Read-only',
  operator_partner: 'Operator / Partner',
});

const assertDemoSeedEnvironment = ({ reset = false, databaseName = null } = {}) => {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Demo seed/reset is forbidden when NODE_ENV=production');
  }
  if (String(process.env.DEMO_MODE).toLowerCase() !== 'true') {
    throw new Error('Demo seed/reset is allowed only when DEMO_MODE=true');
  }
  if (String(process.env.DEALETT_REPOSITORY || '').toLowerCase() !== 'postgres') {
    throw new Error('PostgreSQL demo seed/reset requires DEALETT_REPOSITORY=postgres');
  }
  if (reset) {
    if (process.env.RESET_DEMO_CONFIRM !== 'RESET_FICTIONAL_DEMO_DATA') {
      throw new Error('Reset requires RESET_DEMO_CONFIRM=RESET_FICTIONAL_DEMO_DATA');
    }
    if (databaseName && !/(demo|test)/i.test(databaseName)) {
      throw new Error(`Refusing demo reset for database without demo/test in its name: ${databaseName}`);
    }
  }
};

const resetPostgresDemo = async (client) => {
  await client.query(`TRUNCATE TABLE
    partner_organizations, app_users, roles, permissions, customers, operators, catalog_versions,
    campaigns, rule_sets, integrations, application_settings, metric_definitions, retention_policies
    RESTART IDENTITY CASCADE`);
};

const seedPostgresDemo = async (pool, { reset = false } = {}) => {
  assertDemoSeedEnvironment({ reset });
  const state = buildDemoState();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_type','system',true)");
    const database = await client.query('SELECT current_database() AS name');
    assertDemoSeedEnvironment({ reset, databaseName: database.rows[0].name });
    if (reset) await resetPostgresDemo(client);

    for (const partner of state.partnerOrganizations) {
      await client.query(`INSERT INTO partner_organizations (id,slug,name,status)
        VALUES ($1,$2,$3,'demo') ON CONFLICT (id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,status='demo'`,
      [partner.id, partner.slug, partner.name]);
      await client.query(`INSERT INTO operators (id,slug,name,partner_organization_id,status)
        VALUES ($1,$2,$3,$4,'active') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name,partner_organization_id=EXCLUDED.partner_organization_id`,
      [`8${partner.id.slice(1)}`, partner.slug, partner.name, partner.id]);
    }

    await client.query(`INSERT INTO catalog_versions
      (id,version_key,schema_version,state,source,source_hash,effective_from)
      VALUES ($1,'legacy-schema-v1',1,'active','data/plans.json',$2,'2026-01-01T00:00:00Z')
      ON CONFLICT (version_key) DO UPDATE SET source_hash=EXCLUDED.source_hash`,
    [DEMO_CATALOG_ID, hashObject({ version: 1, source: 'data/plans.json' })]);

    await client.query(`INSERT INTO rule_sets (id,stable_key,name,rule_type)
      VALUES ($1,'demo-rules','Demo commission and presentkort rules','combined')
      ON CONFLICT (stable_key) DO NOTHING`, [DEMO_RULE_SET_ID]);
    await client.query(`INSERT INTO rule_versions (id,rule_set_id,version,state,definition,effective_from)
      VALUES ($1,$2,1,'active',$3,'2026-01-01T00:00:00Z') ON CONFLICT (rule_set_id,version) DO NOTHING`,
    [DEMO_RULE_VERSION_ID, DEMO_RULE_SET_ID, { simulated: true, commission: 'not_configured', giftCards: 'demo_only' }]);
    await client.query(`INSERT INTO campaigns (id,stable_key,name)
      VALUES ($1,'demo-campaign','Demo höstkampanj') ON CONFLICT (stable_key) DO NOTHING`, [DEMO_CAMPAIGN_ID]);
    await client.query(`INSERT INTO campaign_versions (id,campaign_id,version,state,eligibility,configuration,effective_from,effective_to)
      VALUES ($1,$2,1,'active',$3,$4,'2026-08-01T00:00:00Z','2026-09-30T23:59:59Z')
      ON CONFLICT (campaign_id,version) DO NOTHING`,
    [DEMO_CAMPAIGN_VERSION_ID, DEMO_CAMPAIGN_ID, { demo: true }, { simulated: true }]);

    const permissionIds = new Map();
    for (const permission of PERMISSIONS) {
      const permissionResult = await client.query(`INSERT INTO permissions (key,description,sensitive)
        VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description RETURNING id`,
      [permission, `Permission ${permission}`, /sensitive|impersonation|audit\.export/.test(permission)]);
      permissionIds.set(permission, permissionResult.rows[0].id);
    }
    for (const [roleKey, roleName] of Object.entries(SEEDED_ROLES)) {
      const roleId = roleKey === 'owner' ? DEMO_ROLE_ID : stableUuid(`dealett-role:${roleKey}`);
      await client.query(`INSERT INTO roles (id,key,name,description,system_role)
        VALUES ($1,$2,$3,$4,true)
        ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description`, [
        roleId, roleKey, roleName, `${roleName} permission boundary`,
      ]);
      for (const permission of ROLE_PERMISSIONS[roleKey]) {
        await client.query('INSERT INTO role_permissions (role_id,permission_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId, permissionIds.get(permission)]);
      }
    }
    for (const user of Object.values(state.users).filter((entry) => entry.actorType === 'employee')) {
      await client.query(`INSERT INTO app_users (id,email,display_name,actor_type,status,demo_identity)
        VALUES ($1,$2,$3,'employee','active',true) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
      [user.id, `${user.username}@example.invalid`, user.name]);
      await client.query(`INSERT INTO employees (user_id,title,security_settings)
        VALUES ($1,'Demo Admin',$2) ON CONFLICT (user_id) DO NOTHING`, [user.id, { mockAdmin: true, mfa: 'not_active_demo' }]);
      await client.query(`INSERT INTO user_role_assignments (user_id,role_id,scope_type)
        VALUES ($1,$2,'global') ON CONFLICT DO NOTHING`, [user.id, DEMO_ROLE_ID]);
    }
    for (const user of Object.values(state.users).filter((entry) => entry.actorType !== 'employee')) {
      await client.query(`INSERT INTO app_users
        (id,email,display_name,actor_type,partner_organization_id,status,demo_identity)
        VALUES ($1,$2,$3,$4,$5,'active',true)
        ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [
        user.id,
        `${user.username}@example.invalid`,
        user.name,
        user.actorType,
        user.partnerOrganizationId || null,
      ]);
    }

    for (const integration of state.integrations) {
      await client.query(`INSERT INTO integrations
        (id,stable_key,name,adapter_type,mode,state,configuration_schema,capabilities)
        VALUES ($1,$2,$3,$2,'mock',$4,'{}','[]')
        ON CONFLICT (stable_key) DO UPDATE SET name=EXCLUDED.name,mode='mock',state=EXCLUDED.state`,
      [integration.id, integration.slug, integration.name, integration.state]);
    }
    await client.query(`INSERT INTO application_settings (key,value,classification)
      VALUES ('environment',$1,'public'),('liveAuthentication',$2,'public')
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{ mode: 'DEMO', simulated: true }, false]);
    await client.query(`INSERT INTO metric_definitions (key,name,description,formula,dimensions)
      VALUES ('checkout_conversion','Checkout conversion','Completed orders divided by checkout starts','orders / checkout_starts',$1)
      ON CONFLICT (key) DO NOTHING`, [JSON.stringify(['operator', 'campaign'])]);
    await client.query(`INSERT INTO retention_policies (data_category,retention_days,action,enabled,legal_review_required)
      VALUES ('demo_customer_data',30,'delete',false,true) ON CONFLICT (data_category) DO NOTHING`);

    for (const customer of state.customers) {
      await client.query(`INSERT INTO customers (id,display_name,preferred_language,classification)
        VALUES ($1,$2,$3,'fictional_demo') ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`,
      [customer.id, customer.displayName, customer.language]);
    }

    for (const conversation of state.conversations) {
      await client.query(`INSERT INTO conversations
        (id,public_token_hash,customer_id,status,language,source_page,archived_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`, [
        conversation.id, conversation.publicTokenHash, conversation.customerId, conversation.status,
        conversation.language, conversation.sourcePage, conversation.archivedAt,
        conversation.createdAt, conversation.updatedAt,
      ]);
      for (const message of conversation.messages) {
        await client.query(`INSERT INTO conversation_messages
          (id,conversation_id,sequence,role,content_text,structured_content,language,model_name,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (conversation_id,sequence) DO NOTHING`, [
          message.id, conversation.id, message.sequence, message.role, message.content,
          message.structuredContent, message.language, message.model || null, message.createdAt,
        ]);
      }
    }

    for (const order of state.orders) {
      const quoteId = `90000000-0000-4000-8000-${order.id.slice(-12)}`;
      await client.query(`INSERT INTO quotes
        (id,selected_offer_id,snapshot,snapshot_hash,mode,expires_at,created_at)
        VALUES ($1,$2,$3,$4,'demo','2099-12-31T23:59:59Z',$5) ON CONFLICT (id) DO NOTHING`,
      [quoteId, order.snapshot.selectedOffer.planId, order.snapshot, order.snapshotHash, order.createdAt]);
      const seededOrder = await client.query(`INSERT INTO orders
        (id,order_number,public_reference,customer_id,partner_organization_id,quote_id,source,
         overall_status,operator_status,commission_status,gift_card_status,support_status,
         submitted_at,created_at,updated_at,version,attribution,safe_technical_metadata)
        VALUES ($1,$2,$3,$4,$5,$6,'demo_seed',$7,$8,$9,$10,$11,$12,$12,$12,$13,$14,$15)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [
        order.id, order.orderNumber, order.publicReference, order.customerId, order.partnerOrganizationId,
        quoteId, order.status, order.operatorStatus, order.commissionStatus, order.giftCardStatus,
        order.supportStatus, order.createdAt, order.version, order.attribution, { simulated: true, classification: 'fictional_demo' },
      ]);
      if (!seededOrder.rowCount) continue;
      await client.query(`INSERT INTO order_snapshots
        (order_id,catalog_version_key,rule_version_key,campaign_version_key,offer_snapshot,price_snapshot,
         benefit_snapshot,calculation_inputs,calculation_outputs,calculation_explanation,alternatives_snapshot,
         full_snapshot,snapshot_hash,monthly_value_minor,gift_card_value_minor,commission_expected_minor)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'[]',$11,$12,$13,$14,$15)
        ON CONFLICT (order_id) DO NOTHING`, [
        order.id, order.snapshot.catalogVersion, order.snapshot.ruleVersion, order.snapshot.campaignVersion,
        order.snapshot.selectedOffer,
        { monthlyPriceMinor: order.monthlyValueMinor, currency: 'SEK' },
        { benefits: order.snapshot.selectedOffer.benefits },
        order.snapshot.qualification,
        order.snapshot.calculation,
        { simulated: true },
        order.snapshot,
        order.snapshotHash,
        order.monthlyValueMinor,
        order.giftCardValueMinor,
        order.commissionLedger[0]?.amountMinor || 0,
      ]);
      for (let index = 0; index < order.participants.length; index += 1) {
        const participant = order.participants[index];
        const participantId = participant.id;
        await client.query(`INSERT INTO order_participants (id,order_id,sequence,display_label)
          VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [participantId, order.id, index + 1, participant.label]);
        await client.query(`INSERT INTO order_subscriptions
          (order_id,participant_id,sequence,product_type,selected_plan_key,phone_number_mask,number_handling)
          VALUES ($1,$2,$3,'mobile',$4,$5,$6) ON CONFLICT (order_id,sequence) DO NOTHING`,
        [order.id, participantId, index + 1, order.snapshot.selectedOffer.planId, participant.phoneNumberMasked, participant.numberHandling]);
      }
      for (const consent of order.consents) {
        const document = await client.query(`INSERT INTO consent_documents
          (stable_key,version,document_type,content_hash) VALUES ($1,$2,$3,$4)
          ON CONFLICT (stable_key,version) DO UPDATE SET content_hash=EXCLUDED.content_hash RETURNING id`,
        [`demo-${consent.type}`, consent.documentVersion, consent.type, hashObject(consent)]);
        await client.query(`INSERT INTO consent_records
          (customer_id,order_id,consent_document_id,consent_type,document_key,document_version,accepted,accepted_at,evidence)
          VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
        [order.customerId, order.id, document.rows[0].id, consent.type, `demo-${consent.type}`, consent.documentVersion, consent.acceptedAt, consent.evidence]);
      }
      for (const [table, dimension, values] of [
        ['order_status_history', 'order', order.statusHistories.order],
        ['operator_status_history', 'operator', order.statusHistories.operator],
        ['commission_status_history', 'commission', order.statusHistories.commission],
        ['gift_card_status_history', 'giftCard', order.statusHistories.giftCard],
      ]) {
        for (const history of values) {
          await client.query(`INSERT INTO ${table} (order_id,from_status,to_status,reason,correlation_id,created_at)
            VALUES ($1,$2,$3,$4,'demo-seed',$5)`, [order.id, history.from, history.to, history.reason || `Demo ${dimension} seed`, history.at]);
        }
      }
      for (const entry of order.commissionLedger) {
        await client.query(`INSERT INTO commission_entries
          (id,order_id,entry_type,amount_minor,currency,simulated,created_at)
          VALUES ($1,$2,$3,$4,$5,true,$6) ON CONFLICT (id) DO NOTHING`,
        [entry.id, order.id, entry.type, entry.amountMinor, entry.currency, entry.createdAt]);
      }
      if (order.giftCardValueMinor > 0) {
        const entitlementId = `94000000-0000-4000-8000-${order.id.slice(-12)}`;
        await client.query(`INSERT INTO gift_card_entitlements
          (id,order_id,customer_id,amount_minor,currency,status,eligible_at,created_at,updated_at)
          VALUES ($1,$2,$3,$4,'SEK',$5,$6,$6,$6) ON CONFLICT (order_id) DO NOTHING`,
        [entitlementId, order.id, order.customerId, order.giftCardValueMinor, order.giftCardStatus, order.createdAt]);
        for (const entry of order.giftCardLedger) {
          await client.query(`INSERT INTO gift_card_entries
            (id,entitlement_id,entry_type,amount_minor,currency,simulated,created_at)
            VALUES ($1,$2,$3,$4,$5,true,$6) ON CONFLICT (id) DO NOTHING`,
          [entry.id, entitlementId, entry.type, entry.amountMinor, entry.currency, entry.createdAt]);
        }
      }
      if (order.conversationArchive) {
        const archiveId = `95000000-0000-4000-8000-${order.id.slice(-12)}`;
        await client.query(`INSERT INTO order_conversation_archives
          (id,order_id,conversation_id,archived_at,message_count,first_sequence,last_sequence,archive_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (order_id,conversation_id) DO NOTHING`, [
          archiveId, order.id, order.conversationArchive.conversationId, order.conversationArchive.archivedAt,
          order.conversationArchive.messageCount, order.conversationArchive.firstSequence,
          order.conversationArchive.lastSequence, order.conversationArchive.hash,
        ]);
        for (const message of order.conversationArchive.messages) {
          await client.query(`INSERT INTO order_conversation_archive_messages
            (archive_id,source_message_id,sequence,role,content_text,structured_content,language,model_name,original_created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (archive_id,sequence) DO NOTHING`, [
            archiveId, message.id, message.sequence, message.role, message.content,
            message.structuredContent, message.language, message.model || null, message.createdAt,
          ]);
        }
      }
    }

    await client.query("SELECT setval('order_number_sequence', 100, true)");

    const support = state.resources.support[0];
    await client.query(`INSERT INTO support_cases
      (id,case_number,customer_id,order_id,category,priority,status,subject,service_target_at)
      VALUES ($1,'DEMO-CASE-0001',$2,$3,'activation','normal','open',$4,'2026-08-30T12:00:00Z')
      ON CONFLICT (id) DO NOTHING`, [
      '96000000-0000-4000-8000-000000000001', support.customerId, state.orders[0].id, support.subject,
    ]);
    await client.query(`INSERT INTO tasks
      (id,title,status,priority,object_type,object_id,due_at)
      VALUES ('97000000-0000-4000-8000-000000000001',$1,'open','normal','order',$2,'2026-08-30T12:00:00Z')
      ON CONFLICT (id) DO NOTHING`, [state.resources.tasks[0].title, state.orders[0].id]);
    await client.query(`INSERT INTO gdpr_requests
      (id,request_number,customer_id,request_type,status,received_at,due_at,legal_review_required)
      VALUES ('98000000-0000-4000-8000-000000000001','DEMO-GDPR-0001',$1,'access','approval_pending',
              '2026-08-28T10:00:00Z','2026-09-27T10:00:00Z',true)
      ON CONFLICT (id) DO NOTHING`, [state.customers[2].id]);
    await client.query(`INSERT INTO audit_events
      (id,actor_type,action,object_type,object_id,correlation_id,summary,created_at)
      VALUES ('99000000-0000-4000-8000-000000000001','system','demo.seeded','system','demo','demo-seed',$1,$2)
      ON CONFLICT (id) DO NOTHING`, [{ simulated: true }, state.seededAt]);

    await client.query('COMMIT');
    return { ok: true, reset, seededAt: state.seededAt, simulated: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  assertDemoSeedEnvironment,
  resetPostgresDemo,
  seedPostgresDemo,
};
