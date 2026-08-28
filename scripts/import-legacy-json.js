const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { getDataFilePath } = require('../data-storage');
const { hashObject } = require('../platform/utils');

const SOURCES = [
  ['checkout_order', getDataFilePath('checkout-orders.json'), 'array'],
  ['newsletter_subscription', getDataFilePath('newsletter-subscribers.json'), 'array'],
  ['chat_feedback', process.env.CHAT_FEEDBACK_FILE || getDataFilePath('chat-feedback', 'chat-feedback.jsonl'), 'jsonl'],
];

const readSource = (filePath, format) => {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  if (format === 'jsonl') return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error(`${filePath} must contain an array`);
  return parsed;
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  const results = SOURCES.map(([type, filePath, format]) => {
    const records = readSource(filePath, format);
    return { type, filePath: path.resolve(filePath), records, hash: hashObject(records) };
  });
  if (!apply) {
    for (const result of results) process.stdout.write(`${result.type}: ${result.records.length} records (${result.hash})\n`);
    process.stdout.write('dry-run only; pass --apply with DATABASE_URL to preserve records in the legacy import tables\n');
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required with --apply');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const result of results) {
      const run = await client.query(`INSERT INTO data_import_runs
        (source_type,source_path,source_hash,status,records_seen)
        VALUES ($1,$2,$3,'started',$4)
        ON CONFLICT (source_type,source_hash) DO UPDATE SET source_path=EXCLUDED.source_path
        RETURNING id,status`, [result.type, result.filePath, result.hash, result.records.length]);
      let imported = 0;
      for (let index = 0; index < result.records.length; index += 1) {
        const record = result.records[index];
        const sourceId = String(record.orderId || record.id || record.email || `${result.hash}:${index}`);
        const flags = result.type === 'checkout_order'
          ? ['legacy_record', 'customer_or_conversation_may_be_unavailable']
          : ['legacy_record'];
        const inserted = await client.query(`INSERT INTO legacy_records
          (import_run_id,source_type,source_id,payload,data_quality_flags)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_type,source_id) DO NOTHING RETURNING id`,
        [run.rows[0].id, result.type, sourceId, record, flags]);
        imported += inserted.rowCount;
      }
      await client.query(`UPDATE data_import_runs SET status='completed',records_imported=$1,completed_at=now() WHERE id=$2`, [imported, run.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
