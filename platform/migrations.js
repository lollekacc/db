const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_PATTERN = /^(\d{3}_[a-z0-9_]+)\.(up|down)\.sql$/;

const listMigrations = (directory = MIGRATIONS_DIR) => {
  const entries = new Map();
  for (const fileName of fs.readdirSync(directory).sort()) {
    const match = FILE_PATTERN.exec(fileName);
    if (!match) continue;
    const [, id, direction] = match;
    const entry = entries.get(id) || { id };
    entry[direction] = path.join(directory, fileName);
    entries.set(id, entry);
  }
  const migrations = [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  for (const migration of migrations) {
    if (!migration.up || !migration.down) throw new Error(`Migration ${migration.id} must have up and down SQL files`);
  }
  return migrations;
};

const ensureMigrationTable = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
};

const migrateUp = async (pool, { directory = MIGRATIONS_DIR } = {}) => {
  const migrations = listMigrations(directory);
  const client = await pool.connect();
  const applied = [];
  try {
    await ensureMigrationTable(client);
    const current = await client.query('SELECT id FROM app_schema_migrations');
    const existing = new Set(current.rows.map((row) => row.id));
    for (const migration of migrations) {
      if (existing.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(migration.up, 'utf8'));
        await client.query('INSERT INTO app_schema_migrations (id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
        applied.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `Migration ${migration.id} failed: ${error.message}`;
        throw error;
      }
    }
    return applied;
  } finally {
    client.release();
  }
};

const migrateDown = async (pool, { directory = MIGRATIONS_DIR, steps = 1 } = {}) => {
  const migrations = listMigrations(directory);
  const byId = new Map(migrations.map((migration) => [migration.id, migration]));
  const client = await pool.connect();
  const reverted = [];
  try {
    await ensureMigrationTable(client);
    const current = await client.query('SELECT id FROM app_schema_migrations ORDER BY id DESC LIMIT $1', [Math.max(Number(steps) || 1, 1)]);
    for (const row of current.rows) {
      const migration = byId.get(row.id);
      if (!migration) throw new Error(`Applied migration ${row.id} has no local down file`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(migration.down, 'utf8'));
        await client.query('DELETE FROM app_schema_migrations WHERE id = $1', [migration.id]);
        await client.query('COMMIT');
        reverted.push(migration.id);
      } catch (error) {
        await client.query('ROLLBACK');
        error.message = `Rollback ${migration.id} failed: ${error.message}`;
        throw error;
      }
    }
    return reverted;
  } finally {
    client.release();
  }
};

module.exports = {
  MIGRATIONS_DIR,
  listMigrations,
  migrateDown,
  migrateUp,
};
