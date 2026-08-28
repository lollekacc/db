const { Pool } = require('pg');

const { buildDemoState } = require('../platform/demo-data');
const { assertDemoSeedEnvironment, seedPostgresDemo } = require('../platform/postgres-seed');

const main = async () => {
  if (String(process.env.DEMO_MODE).toLowerCase() !== 'true') {
    throw new Error('Set DEMO_MODE=true to seed or reset fictional demo data');
  }
  const reset = process.argv.includes('--reset');
  if ((process.env.DEALETT_REPOSITORY || 'memory') === 'memory') {
    const state = buildDemoState();
    process.stdout.write(`memory demo seed is deterministic and loaded at startup (${state.orders.length} orders, ${state.customers.length} customers)\n`);
    return;
  }
  assertDemoSeedEnvironment({ reset });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL demo seed');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
    application_name: 'dealett-demo-seed',
  });
  try {
    const result = await seedPostgresDemo(pool, { reset });
    process.stdout.write(`${reset ? 'reset and seeded' : 'seeded'} fictional demo data at ${result.seededAt}\n`);
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
