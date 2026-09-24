const crypto = require('node:crypto');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

const getCorrelationId = (request) => {
  const supplied = String(request.headers['x-correlation-id'] || '').trim();
  return /^[a-zA-Z0-9._:-]{8,100}$/.test(supplied) ? supplied : crypto.randomUUID();
};

const getCorsHeaders = (request, config) => {
  const origin = String(request.headers.origin || '').replace(/\/$/, '');
  if (!origin || !config.corsOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
};

const buildHeaders = (request, config, correlationId, extra = {}) => ({
  ...SECURITY_HEADERS,
  ...getCorsHeaders(request, config),
  'X-Correlation-ID': correlationId,
  ...extra,
});

const sendJson = (request, response, config, correlationId, statusCode, payload, extraHeaders = {}) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, buildHeaders(request, config, correlationId, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  }));
  response.end(body);
};

const sendPlatformError = (request, response, config, correlationId, error) => {
  const statusCode = Number(error.statusCode) || 500;
  const safeMessage = statusCode >= 500
    ? 'An unexpected server error occurred'
    : String(error.message || 'Request failed');
  sendJson(request, response, config, correlationId, statusCode, {
    error: {
      code: error.code || (statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: safeMessage,
      details: statusCode < 500 ? (error.details || null) : null,
      correlationId,
    },
  });
};

const readJsonBody = (request, maxBytes = 1_000_000) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Request body too large');
      error.code = 'BODY_TOO_LARGE';
      error.statusCode = 413;
      reject(error);
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (!chunks.length) return resolve({});
    try {
      return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      const error = new Error('Invalid JSON body');
      error.code = 'INVALID_JSON';
      error.statusCode = 400;
      return reject(error);
    }
  });
  request.on('error', reject);
});

const sendCsv = (request, response, config, correlationId, fileName, csv) => {
  const body = String(csv);
  response.writeHead(200, buildHeaders(request, config, correlationId, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    'Content-Length': Buffer.byteLength(body),
  }));
  response.end(body);
};

module.exports = {
  SECURITY_HEADERS,
  buildHeaders,
  getCorrelationId,
  readJsonBody,
  sendCsv,
  sendJson,
  sendPlatformError,
};
