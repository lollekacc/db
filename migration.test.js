const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const { Pool } = require('pg');
const { PGlite } = require('@electric-sql/pglite');
const { createFieldCrypto } = require('./platform/field-crypto');
const { listMigrations, migrateDown, migrateUp } = require('./platform/migrations');
const { PostgresOperationsRepository } = require('./platform/postgres-repository');
const { seedPostgresDemo } = require('./platform/postgres-seed');
const { OperationsService } = require('./platform/service');

const migrations = listMigrations();
const readAll = (direction) => migrations.map((migration) => fs.readFileSync(migration[direction], 'utf8')).join('\n');

test('ordered migrations have reversible up/down pairs', () => {
  assert.deepEqual(migrations.map((migration) => migration.id), [
    '001_core_identity_catalog',
    '002_conversations_orders_finance',
    '003_operations_compliance_integrations',
    '004_integrity_security',
  ]);
  for (const migration of migrations) {
    assert.ok(fs.statSync(migration.up).size > 0, `${migration.id} up SQL is empty`);
    assert.ok(fs.statSync(migration.down).size > 0, `${migration.id} down SQL is empty`);
  }
});

test('schema covers normalized operations domains and immutable evidence', () => {
  const sql = readAll('up');
  const requiredTables = [
    'partner_organizations', 'app_users', 'roles', 'permissions', 'customers', 'customer_contact_methods',
    'operators', 'catalog_versions', 'plan_versions', 'benefit_versions', 'campaign_versions', 'rule_versions',
    'conversations', 'conversation_messages', 'quotes', 'idempotency_keys', 'orders', 'order_participants',
    'order_subscriptions', 'order_snapshots', 'consent_records', 'order_conversation_archives',
    'order_status_history', 'operator_status_history', 'commission_status_history', 'gift_card_status_history',
    'commission_entries', 'gift_card_entries', 'support_cases', 'generated_reports', 'customer_communications',
    'integrations', 'integration_sync_jobs', 'outbox_events', 'analytics_events', 'gdpr_requests',
    'retention_policies', 'legal_holds', 'audit_events',
  ];
  for (const table of requiredTables) assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`), `missing ${table}`);
  assert.match(sql, /external_participant_id text/);
  assert.match(sql, /external_subscription_id text/);
  assert.match(sql, /gift_card_entries[\s\S]*currency char\(3\) NOT NULL DEFAULT 'SEK'/);
  for (const table of [
    'conversation_messages', 'order_snapshots', 'order_conversation_archives',
    'order_conversation_archive_messages', 'order_status_history', 'operator_status_history',
    'commission_status_history', 'gift_card_status_history', 'commission_entries', 'gift_card_entries', 'audit_events',
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER [^;]+(?:ON|on) ${table}|CREATE TRIGGER ${table}[^;]+ ON ${table}`, 'i'), `missing immutable trigger for ${table}`);
  }
});

test('RLS is fail-closed and public capture is restricted to its transaction order ID', () => {
  const sql = fs.readFileSync(migrations.find((migration) => migration.id.startsWith('004_')).up, 'utf8');
  assert.doesNotMatch(sql, /COALESCE\([^\n]+employee/i);
  assert.match(sql, /ALTER TABLE orders FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /orders_public_capture_insert/);
  assert.match(sql, /app\.capture_order_id/);
  assert.match(sql, /current_setting\('app\.actor_type', true\) = 'public_capture'/);
  assert.match(sql, /security_invoker = true/);
  assert.match(sql, /ALTER TABLE commission_entries FORCE ROW LEVEL SECURITY/);
});

test('up migrations avoid destructive data operations and PostgreSQL 15 syntax is explicit', () => {
  const sql = readAll('up');
  assert.doesNotMatch(sql, /\b(?:TRUNCATE|DROP\s+(?:TABLE|SCHEMA|DATABASE)|DELETE\s+FROM)\b/i);
  assert.match(sql, /UNIQUE NULLS NOT DISTINCT/);
  assert.match(sql, /CREATE UNIQUE INDEX conversation_messages_client_id_idx[\s\S]*WHERE client_message_id IS NOT NULL/);
});

test('migration runner wraps every direction in a transaction', async () => {
  const upQueries = [];
  const upClient = {
    async query(sql, parameters) {
      const text = String(sql);
      upQueries.push([text, parameters]);
      if (/SELECT id FROM app_schema_migrations/.test(text)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const applied = await migrateUp({ async connect() { return upClient; } });
  assert.deepEqual(applied, migrations.map((migration) => migration.id));
  assert.equal(upQueries.filter(([sql]) => sql === 'BEGIN').length, migrations.length);
  assert.equal(upQueries.filter(([sql]) => sql === 'COMMIT').length, migrations.length);
  assert.equal(upQueries.filter(([sql]) => sql === 'ROLLBACK').length, 0);

  const downQueries = [];
  const downClient = {
    async query(sql) {
      const text = String(sql);
      downQueries.push(text);
      if (/SELECT id FROM app_schema_migrations ORDER BY/.test(text)) {
        return { rows: migrations.slice(-2).reverse().map((migration) => ({ id: migration.id })) };
      }
      return { rows: [] };
    },
    release() {},
  };
  const reverted = await migrateDown({ async connect() { return downClient; } }, { steps: 2 });
  assert.deepEqual(reverted, migrations.slice(-2).reverse().map((migration) => migration.id));
  assert.equal(downQueries.filter((sql) => sql === 'BEGIN').length, 2);
  assert.equal(downQueries.filter((sql) => sql === 'COMMIT').length, 2);
});

test('all up and down SQL executes in PostgreSQL-compatible PGlite', { timeout: 30_000 }, async () => {
  const database = new PGlite();
  const environmentNames = ['NODE_ENV', 'DEMO_MODE', 'DEALETT_REPOSITORY'];
  const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
  try {
    for (const migration of migrations) await database.exec(fs.readFileSync(migration.up, 'utf8'));
    const invariants = await database.query(`SELECT
      to_regclass('orders') AS orders,
      to_regclass('order_snapshots') AS snapshots,
      to_regclass('order_conversation_archive_messages') AS archive_messages,
      to_regclass('commission_entries') AS commissions,
      to_regclass('gdpr_requests') AS gdpr_requests`);
    assert.equal(invariants.rows[0].orders, 'orders');
    assert.equal(invariants.rows[0].snapshots, 'order_snapshots');
    assert.equal(invariants.rows[0].archive_messages, 'order_conversation_archive_messages');
    assert.equal(invariants.rows[0].commissions, 'commission_entries');
    assert.equal(invariants.rows[0].gdpr_requests, 'gdpr_requests');
    const policies = await database.query("SELECT policyname FROM pg_policies WHERE tablename='orders' ORDER BY policyname");
    assert.deepEqual(policies.rows.map((row) => row.policyname), ['orders_actor_scope', 'orders_public_capture_insert']);
    const triggers = await database.query("SELECT count(*)::integer AS count FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%immutable%'");
    assert.ok(triggers.rows[0].count >= 8);
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = 'true';
    process.env.DEALETT_REPOSITORY = 'postgres';
    const seedClient = { query: (sql, parameters) => database.query(sql, parameters), release() {} };
    const seedPool = { async connect() { return seedClient; } };
    await seedPostgresDemo(seedPool);
    await seedPostgresDemo(seedPool);
    const seedCounts = await database.query(`SELECT
      (SELECT count(*)::integer FROM orders) AS orders,
      (SELECT count(*)::integer FROM conversations) AS conversations,
      (SELECT count(*)::integer FROM commission_entries) AS commissions,
      (SELECT count(*)::integer FROM gift_card_entitlements) AS gift_cards,
      (SELECT count(*)::integer FROM support_cases) AS support_cases,
      (SELECT count(*)::integer FROM gdpr_requests) AS gdpr_requests,
      (SELECT count(*)::integer FROM roles WHERE key IN (
        'owner','operations_manager','sales_manager','seller','customer_support','finance',
        'compliance_gdpr','offers_content_manager','analyst_read_only','operator_partner'
      )) AS canonical_roles`);
    assert.deepEqual(seedCounts.rows[0], {
      orders: 4,
      conversations: 1,
      commissions: 4,
      gift_cards: 3,
      support_cases: 1,
      gdpr_requests: 1,
      canonical_roles: 10,
    });
    const repository = new PostgresOperationsRepository({
      pool: seedPool,
      demoMode: true,
      fieldCrypto: createFieldCrypto(Buffer.alloc(32, 4).toString('base64')),
    });
    const service = new OperationsService({
      repository,
      config: { demoMode: true, repository: 'postgres' },
      clock: () => new Date(Date.now()),
    });
    const transcriptSecret = 'Mitt privata kundmeddelande';
    const createdConversation = await service.createConversation({
      conversationId: 'pglite-public-conversation-contract',
      language: 'sv',
    }, { correlationId: 'pglite-conversation-create' });
    await service.appendConversationMessage(createdConversation.conversation.id, {
      role: 'user',
      content: transcriptSecret,
      id: 'pglite-client-message-1',
      sequence: 1,
      createdAt: new Date().toISOString(),
    }, {
      correlationId: 'pglite-conversation-message',
      token: createdConversation.token,
    });
    const capturePayload = {
      customer: { email: 'pglite.capture@example.invalid', phone: '+46709998877' },
      cartItems: [{ planId: 'telia-10gb', persons: 1 }],
      participants: [{ label: 'Person 1', phoneNumber: '+46709998877' }],
      conversationId: createdConversation.conversation.id,
      conversationToken: createdConversation.token,
      consents: [{
        type: 'dealett_terms', documentId: 'pglite-demo-terms', documentVersion: 'v1',
        accepted: true, acceptedAt: new Date().toISOString(), textHash: 'b'.repeat(64),
      }],
    };
    const captured = await service.createOrder(capturePayload, 'pglite-order-contract-0001', { correlationId: 'pglite-contract' });
    assert.equal(captured.order.status, 'submitted');
    assert.equal(captured.order.monthlyValueMinor, 29_900);
    assert.equal(captured.order.conversationArchive.messages[0].content, transcriptSecret);
    const liveMessageStorage = await database.query(
      'SELECT content_text,content_encrypted FROM conversation_messages WHERE conversation_id=$1',
      [createdConversation.conversation.id]
    );
    assert.equal(liveMessageStorage.rows[0].content_text, null);
    assert.match(liveMessageStorage.rows[0].content_encrypted, /^v1\./);
    assert.doesNotMatch(liveMessageStorage.rows[0].content_encrypted, new RegExp(transcriptSecret));
    const archiveMessageStorage = await database.query(`SELECT m.content_text,m.content_encrypted
      FROM order_conversation_archive_messages m
      JOIN order_conversation_archives a ON a.id=m.archive_id
      WHERE a.order_id=$1`, [captured.order.id]);
    assert.equal(archiveMessageStorage.rows[0].content_text, null);
    assert.match(archiveMessageStorage.rows[0].content_encrypted, /^v1\./);
    assert.doesNotMatch(archiveMessageStorage.rows[0].content_encrypted, new RegExp(transcriptSecret));
    const replayed = await service.createOrder(capturePayload, 'pglite-order-contract-0001', { correlationId: 'pglite-contract-replay' });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.order, null);
    assert.equal(replayed.receipt.orderId, captured.order.id);
    const idempotency = await database.query("SELECT response_body FROM idempotency_keys WHERE scope='public_order' AND key='pglite-order-contract-0001'");
    assert.equal(Object.hasOwn(idempotency.rows[0].response_body, 'customer'), false);
    const demoAdmin = (await repository.getUsers())['demo-admin'];
    const report = await repository.createReport(captured.order.id, { actor: demoAdmin, correlationId: 'pglite-report-create' });
    assert.equal(report.payload.order.customer.email, 'pglite.capture@example.invalid');
    const storedReport = await database.query('SELECT payload,payload_encrypted FROM generated_reports WHERE id=$1', [report.id]);
    assert.equal(JSON.stringify(storedReport.rows[0].payload).includes('pglite.capture@example.invalid'), false);
    assert.match(storedReport.rows[0].payload_encrypted, /^v1\./);
    const loadedReport = await repository.getReport(report.id, demoAdmin);
    assert.equal(loadedReport.payload.order.customer.email, 'pglite.capture@example.invalid');
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM orders')).rows[0].count, 5);
    for (const migration of [...migrations].reverse()) await database.exec(fs.readFileSync(migration.down, 'utf8'));
    assert.equal((await database.query("SELECT to_regclass('orders') AS value")).rows[0].value, null);
  } finally {
    for (const name of environmentNames) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
    await database.close();
  }
});

test('all migrations execute on an isolated real PostgreSQL 15+ schema when configured', {
  skip: process.env.DEALETT_TEST_DATABASE_URL
    ? false
    : 'No local PostgreSQL/psql/docker is available; set DEALETT_TEST_DATABASE_URL to run executable migration verification.',
}, async () => {
  const admin = new Pool({ connectionString: process.env.DEALETT_TEST_DATABASE_URL, max: 1 });
  const schema = `dealett_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const isolated = new Pool({
    connectionString: process.env.DEALETT_TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
    max: 1,
  });
  try {
    const version = Number((await isolated.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 150000, 'PostgreSQL 15+ is required for UNIQUE NULLS NOT DISTINCT and security_invoker views');
    assert.equal((await migrateUp(isolated)).length, migrations.length);
    const tables = await isolated.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema()");
    assert.ok(tables.rows.some((row) => row.tablename === 'orders'));
    assert.equal((await migrateDown(isolated, { steps: migrations.length })).length, migrations.length);
  } finally {
    await isolated.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
