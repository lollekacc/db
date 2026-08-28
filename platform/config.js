const path = require('node:path');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

const configurationError = (message) => Object.assign(new Error(message), {
  code: 'CONFIGURATION_ERROR',
  statusCode: 500,
});

const parseBoolean = (value, fallback, name) => {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw configurationError(`${name} must be true or false`);
};

const parsePositiveInteger = (value, fallback, name) => {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw configurationError(`${name} must be a positive integer`);
  }
  return number;
};

const parseOrigins = (value) => {
  const origins = String(value || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (!origins.length || origins.includes('*')) {
    throw configurationError('CORS_ORIGINS must be a non-empty allowlist without wildcards');
  }
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw configurationError(`Invalid CORS origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw configurationError(`CORS origin must contain only scheme and authority: ${origin}`);
    }
  }
  return origins;
};

const loadPlatformConfig = (environment = process.env) => {
  const demoMode = parseBoolean(environment.DEMO_MODE, false, 'DEMO_MODE');
  const repository = String(environment.DEALETT_REPOSITORY || (demoMode ? 'memory' : 'postgres')).trim();
  if (!['memory', 'postgres'].includes(repository)) {
    throw configurationError('DEALETT_REPOSITORY must be memory or postgres');
  }
  if (repository === 'memory' && !demoMode && environment.NODE_ENV !== 'test') {
    throw configurationError('The memory repository is allowed only when DEMO_MODE=true');
  }
  if (repository === 'postgres' && !environment.DATABASE_URL) {
    throw configurationError('DATABASE_URL is required for the PostgreSQL repository');
  }
  const encryptionKey = environment.DEALETT_DATA_ENCRYPTION_KEY || null;
  if (!demoMode && repository === 'postgres') {
    let decoded;
    try {
      decoded = Buffer.from(encryptionKey || '', 'base64');
    } catch {
      decoded = null;
    }
    if (!decoded || decoded.length !== 32) {
      throw configurationError('DEALETT_DATA_ENCRYPTION_KEY must contain exactly 32 base64-encoded bytes');
    }
  }

  return Object.freeze({
    nodeEnv: String(environment.NODE_ENV || 'development'),
    demoMode,
    repository,
    databaseUrl: environment.DATABASE_URL || null,
    databaseSsl: parseBoolean(environment.DATABASE_SSL, false, 'DATABASE_SSL'),
    encryptionKey,
    corsOrigins: parseOrigins(environment.CORS_ORIGINS),
    chatRateLimit: parsePositiveInteger(environment.PUBLIC_CHAT_RATE_LIMIT, 30, 'PUBLIC_CHAT_RATE_LIMIT'),
    orderRateLimit: parsePositiveInteger(environment.PUBLIC_ORDER_RATE_LIMIT, 10, 'PUBLIC_ORDER_RATE_LIMIT'),
    dataDirectory: path.resolve(environment.DEALETT_DATA_DIR || path.join(__dirname, '..', 'data')),
  });
};

module.exports = {
  loadPlatformConfig,
  parseBoolean,
  parseOrigins,
};
