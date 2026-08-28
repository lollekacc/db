const crypto = require('node:crypto');

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const canonicalize = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const hashObject = (value) => sha256(canonicalJson(value));

const stableUuid = (value) => {
  const hex = sha256(value).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
};

const nowIso = (clock = () => new Date()) => clock().toISOString();

const toMinorUnits = (value, label = 'amount', { allowNegative = false } = {}) => {
  const fail = (message) => {
    const error = new Error(`${label} ${message}`);
    error.code = 'INVALID_MONEY';
    error.statusCode = 400;
    throw error;
  };
  if (typeof value === 'number' && !Number.isFinite(value)) fail('must be a finite monetary amount');
  if (!['string', 'number', 'bigint'].includes(typeof value)) fail('must be a decimal monetary amount');
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) fail('must use a decimal with at most two fractional digits');
  const negative = match[1] === '-';
  if (negative && !allowNegative) fail('must not be negative');
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || '').padEnd(2, '0') || '0');
  const minor = (whole * 100n + fraction) * (negative ? -1n : 1n);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    fail('is outside the supported safe integer range');
  }
  return Number(minor);
};

const fromMinorUnits = (value) => Number(value || 0) / 100;

const escapeCsv = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

module.exports = {
  canonicalJson,
  clone,
  escapeCsv,
  fromMinorUnits,
  hashObject,
  nowIso,
  sha256,
  stableUuid,
  toMinorUnits,
};
