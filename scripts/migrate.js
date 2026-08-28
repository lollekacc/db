const { Pool } = require('pg');

const { migrateDown, migrateUp } = require('../platform/migrations');

const main = async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
    application_name: 'dealett-migrations',
  });
  try {
    const direction = process.argv[2] || 'up';
    const changed = direction === 'down'
      ? await migrateDown(pool, { steps: Number(process.argv[3]) || 1 })
      : await migrateUp(pool);
    process.stdout.write(`${direction}: ${changed.length ? changed.join(', ') : 'no changes'}\n`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
