const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const loadEnvFile = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
};

loadEnvFile();

const { buildCartItemFromCalculatedOffer, calculateOfferOptions } = require('./offer-calculator');
const {
  buildBroadbandCartItem,
  buildMobileCartItem,
  getBroadbandOffers,
  getMobileOperatorOffers,
  getPlans,
} = require('./offer-service');
const { createChatCompletion } = require('./chat-service');
const { normalizeQualification } = require('./qualification-service');
const { buildFeaturedCartItem, getFeaturedOffers } = require('./featured-offers');
const { appendChatFeedback } = require('./chat-feedback-service');
const { cancelBankIdSession, collectBankIdSession, startBankIdSession } = require('./bankid-service');
const { subscribeToNewsletter } = require('./newsletter-service');
const { storeCheckoutOrder } = require('./order-service');
const { translateTexts } = require('./translation-service');
const { parseOrigins } = require('./platform/config');
const { SECURITY_HEADERS, getCorrelationId } = require('./platform/http');
const { RollingWindowRateLimiter } = require('./platform/rate-limiter');
const { handlePlatformRequest, makeDemoChatResult } = require('./platform/router');
const { createPlatformRuntime } = require('./platform/runtime');

const ROOT = path.resolve(__dirname, '..', 'df');
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

const isInsideRoot = (filePath) => filePath === ROOT || filePath.startsWith(`${ROOT}${path.sep}`);

const sendJson = (response, statusCode, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
};

const sendError = (response, error, correlationId) => {
  sendJson(response, error.statusCode || 500, {
    error: (error.statusCode || 500) >= 500 ? 'Service temporarily unavailable' : (error.message || 'Request failed'),
    code: error.code || 'REQUEST_ERROR',
    correlationId,
  });
};

const readJsonBody = (request) => new Promise((resolve, reject) => {
  let body = '';

  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) {
      reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      request.destroy();
    }
  });

  request.on('end', () => {
    if (!body) {
      resolve({});
      return;
    }

    try {
      resolve(JSON.parse(body));
    } catch {
      reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
    }
  });

  request.on('error', reject);
});

const requireMethod = (request, response, method) => {
  if (request.method === method) return true;
  response.writeHead(405, { Allow: method });
  response.end('Method not allowed');
  return false;
};

const handleApi = async (request, response, requestUrl, context = {}) => {
  try {
    const { pathname, searchParams } = requestUrl;

    if (pathname === '/api/health') {
      if (!requireMethod(request, response, 'GET')) return true;
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/featured-offers') {
      if (!requireMethod(request, response, 'GET')) return true;
      sendJson(response, 200, getFeaturedOffers());
      return true;
    }

    if (pathname === '/api/featured-offers/cart-item') {
      if (!requireMethod(request, response, 'POST')) return true;
      sendJson(response, 200, buildFeaturedCartItem(await readJsonBody(request)));
      return true;
    }

    if (pathname === '/api/mobile/plans') {
      if (!requireMethod(request, response, 'GET')) return true;
      sendJson(response, 200, getPlans());
      return true;
    }

    if (pathname === '/api/mobile/operator-offers') {
      if (!requireMethod(request, response, 'GET')) return true;
      sendJson(response, 200, getMobileOperatorOffers(searchParams.get('operator')));
      return true;
    }

    if (pathname === '/api/mobile/cart-item') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      sendJson(response, 200, buildMobileCartItem(body));
      return true;
    }

    if (pathname === '/api/broadband/offers') {
      if (!requireMethod(request, response, 'GET')) return true;
      sendJson(response, 200, getBroadbandOffers({
        tech: searchParams.get('tech') || 'all',
        minSpeed: searchParams.get('minSpeed') || 0,
        sort: searchParams.get('sort') || 'price',
      }));
      return true;
    }

    if (pathname === '/api/broadband/cart-item') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      sendJson(response, 200, buildBroadbandCartItem(body));
      return true;
    }

    if (pathname === '/api/chat') {
      if (!requireMethod(request, response, 'POST')) return true;
      if (context.platformError) throw context.platformError;
      const rate = context.legacyLimiter.consume(`chat:${request.socket?.remoteAddress || 'unknown'}`, context.chatRuntime?.config.chatRateLimit || 30);
      if (!rate.allowed) {
        const error = new Error('Too many chat requests; try again later');
        error.statusCode = 429;
        error.code = 'RATE_LIMITED';
        throw error;
      }
      const body = await readJsonBody(request);
      const streaming = String(request.headers.accept || '').includes('text/event-stream');
      const started = performance.now();
      const metrics = [];
      let firstTextMs = null;
      let succeeded = false;
      const chatController = new AbortController();
      const disconnect = () => { if (!response.writableEnded) chatController.abort(); };
      response.on('close', disconnect);
      const emit = (event, data) => {
        if (!response.destroyed && !response.writableEnded) {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      };
      let heartbeat;
      if (streaming) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        response.flushHeaders();
        heartbeat = setInterval(() => {
          if (!response.destroyed) response.write(': keepalive\n\n');
        }, 15000);
      }
      try {
        let turn = null;
        const persistenceStarted = performance.now();
        if (context.chatRuntime) {
          turn = await context.chatRuntime.service.beginChatTurn({
            ...body,
            conversationToken: body.conversationToken || request.headers['x-conversation-token'],
          }, { correlationId: context.correlationId });
        }
        metrics.push({ stage: 'loadConversation', durationMs: Math.round(performance.now() - persistenceStarted) });
        let result;
        try {
          result = await createChatCompletion(body, {
            signal: chatController.signal,
            onMetric: metric => metrics.push(metric),
            onReplyDelta: streaming ? delta => {
              if (firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
              emit('delta', { text: delta });
            } : undefined,
          });
        } catch (error) {
          if (!context.chatRuntime?.config.demoMode || error.statusCode !== 503) throw error;
          result = makeDemoChatResult(body);
        }
        const saveStarted = performance.now();
        if (turn) {
          const assistant = await context.chatRuntime.service.completeChatTurn(turn, result, {
            correlationId: context.correlationId,
          });
          result.conversationId = turn.conversationId;
          result.conversationToken = turn.conversationToken;
          result.messageMetadata = {
            id: assistant.message.id,
            sequence: assistant.message.sequence,
            createdAt: assistant.message.createdAt,
            model: assistant.message.model || result.model || null,
            assistant: { id: assistant.message.id, sequence: assistant.message.sequence, createdAt: assistant.message.createdAt },
          };
          result.userMessageMetadata = { id: turn.user.id, sequence: turn.user.sequence, createdAt: turn.user.createdAt };
        }
        metrics.push({ stage: 'saveConversation', durationMs: Math.round(performance.now() - saveStarted) });
        const totalMs = Math.round(performance.now() - started);
        result.performance = { totalMs, firstTextMs, stages: metrics };
        if (streaming) {
          emit('done', result);
          response.end();
        } else {
          response.setHeader('Server-Timing', `chat;dur=${totalMs}`);
          sendJson(response, 200, result);
        }
        succeeded = true;
      } catch (error) {
        if (!streaming) throw error;
        emit('error', { error: 'Chat response failed. Please try again.', status: error.statusCode || 500 });
        response.end();
      } finally {
        clearInterval(heartbeat);
        response.removeListener('close', disconnect);
        console.log(JSON.stringify({
          event: 'chat_performance', correlationId: context.correlationId,
          totalMs: Math.round(performance.now() - started), firstTextMs, succeeded, stages: metrics,
        }));
      }
      return true;
    }

    if (pathname === '/api/chat-feedback') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      sendJson(response, 200, appendChatFeedback(body));
      return true;
    }

    if (pathname === '/api/translate') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      sendJson(response, 200, await translateTexts(body));
      return true;
    }

    if (pathname === '/api/newsletter') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      sendJson(response, 200, subscribeToNewsletter(body));
      return true;
    }

    if (pathname === '/api/bankid/start') {
      if (!requireMethod(request, response, 'POST')) return true;
      if (context.platformRuntime && !context.platformRuntime.config.demoMode) {
        const error = new Error('BankID integration is not configured for live mode');
        error.statusCode = 503;
        error.code = 'INTEGRATION_NOT_CONFIGURED';
        throw error;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, startBankIdSession(body));
      return true;
    }

    if (pathname === '/api/bankid/collect') {
      if (!requireMethod(request, response, 'POST')) return true;
      if (context.platformRuntime && !context.platformRuntime.config.demoMode) {
        const error = new Error('BankID integration is not configured for live mode');
        error.statusCode = 503;
        error.code = 'INTEGRATION_NOT_CONFIGURED';
        throw error;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, collectBankIdSession(body));
      return true;
    }

    if (pathname === '/api/bankid/cancel') {
      if (!requireMethod(request, response, 'POST')) return true;
      if (context.platformRuntime && !context.platformRuntime.config.demoMode) {
        const error = new Error('BankID integration is not configured for live mode');
        error.statusCode = 503;
        error.code = 'INTEGRATION_NOT_CONFIGURED';
        throw error;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, cancelBankIdSession(body));
      return true;
    }

    if (pathname === '/api/orders') {
      if (!requireMethod(request, response, 'POST')) return true;
      const rate = context.legacyLimiter.consume(`order:${request.socket?.remoteAddress || 'unknown'}`, context.platformRuntime?.config.orderRateLimit || 10);
      if (!rate.allowed) {
        const error = new Error('Too many order requests; try again later');
        error.statusCode = 429;
        error.code = 'RATE_LIMITED';
        throw error;
      }
      const body = await readJsonBody(request);
      sendJson(response, 201, storeCheckoutOrder(body));
      return true;
    }

    if (pathname === '/api/offers/calculate') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      const qualification = normalizeQualification(body.qualification || body);
      sendJson(response, 200, calculateOfferOptions(qualification));
      return true;
    }

    if (pathname === '/api/offers/cart-item') {
      if (!requireMethod(request, response, 'POST')) return true;
      const body = await readJsonBody(request);
      const qualification = normalizeQualification(body.qualification || {});
      sendJson(response, 200, buildCartItemFromCalculatedOffer({
        qualification,
        planId: body.planId,
      }));
      return true;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(response, 404, { error: 'API route not found' });
      return true;
    }

    return false;
  } catch (error) {
    sendError(response, error, context.correlationId);
    return true;
  }
};

const sendStaticFile = (request, response, requestUrl) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method not allowed');
    return;
  }

  if (requestUrl.pathname.startsWith('/backend/')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400);
    response.end('Invalid path');
    return;
  }
  const segments = decodedPath.split(/[\\/]/);
  const publicExtensions = new Set(['.html', '.css', '.js', '.json', '.geojson', '.jpg', '.jpeg', '.png', '.svg', '.webp', '.gif', '.ico', '.mp4', '.webm', '.woff', '.woff2', '.ttf', '.pdf']);
  if (decodedPath.includes('\0') || segments.some((segment) => segment.startsWith('.') || ['scripts', 'node_modules', 'backend'].includes(segment)) ||
      (decodedPath !== '/' && (!publicExtensions.has(path.extname(decodedPath)) || /^package(?:-lock)?\.json$/.test(path.basename(decodedPath))))) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  const relativePath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.resolve(ROOT, `.${relativePath}`);

  if (!isInsideRoot(filePath)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.stat(filePath, (error, stat) => {
    let realPath;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      realPath = null;
    }
    if (error || !stat.isFile() || !realPath || !isInsideRoot(realPath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const headers = {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
    };

    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    fs.createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  });
};

const createServer = (options = {}) => {
  let platformRuntime = options.platformRuntime || null;
  let platformError = null;
  const platformRequested = Boolean(platformRuntime || process.env.DEMO_MODE !== undefined || process.env.DATABASE_URL);
  if (!platformRuntime && platformRequested) {
    try {
      platformRuntime = createPlatformRuntime(options.platformOptions);
    } catch (error) {
      platformError = error;
    }
  }
  const conversationStorageOnly = options.conversationStorageOnly ?? process.env.DEALETT_CONVERSATION_STORAGE_ONLY === 'true';
  const legacyLimiter = options.legacyLimiter || new RollingWindowRateLimiter();
  const corsOrigins = platformRuntime?.config.corsOrigins || parseOrigins(process.env.CORS_ORIGINS);

  return http.createServer(async (request, response) => {
    const correlationId = getCorrelationId(request);
    response.setHeader('X-Correlation-ID', correlationId);
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
    } catch {
      sendJson(response, 400, { error: 'Invalid request URL' });
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      Object.entries(SECURITY_HEADERS).forEach(([name, value]) => response.setHeader(name, value));
    } else {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
    }
    const origin = String(request.headers.origin || '').replace(/\/$/, '');
    if (origin && corsOrigins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      response.setHeader('Vary', 'Origin');
      if (origin && !corsOrigins.includes(origin)) {
        sendJson(response, 403, { error: 'Origin is not allowed', code: 'CORS_ORIGIN_DENIED', correlationId });
        return;
      }
      if (request.method !== 'OPTIONS' && !['GET', 'HEAD'].includes(request.method)) {
        const rate = legacyLimiter.consume(`submission:${request.socket?.remoteAddress || 'unknown'}`, 120);
        if (!rate.allowed) {
          response.setHeader('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt - Date.now()) / 1000))));
          sendJson(response, 429, { error: 'Too many requests; try again later', code: 'RATE_LIMITED', correlationId });
          return;
        }
      }
    }
    const requestsPlatform = /^\/api\/(public|admin|customer|partner)\/v1(?:\/|$)/.test(requestUrl.pathname) ||
      (platformRequested && !conversationStorageOnly && requestUrl.pathname === '/api/orders');
    if (requestsPlatform && platformError) {
      sendError(response, platformError, correlationId);
      return;
    }
    if (platformRuntime && !conversationStorageOnly) {
      const handledPlatform = await handlePlatformRequest(request, response, requestUrl, platformRuntime, correlationId);
      if (handledPlatform) return;
    }

    if (request.method === 'OPTIONS' && requestUrl.pathname.startsWith('/api/')) {
      if (origin && !corsOrigins.includes(origin)) {
        sendJson(response, 403, { error: 'Origin is not allowed', code: 'CORS_ORIGIN_DENIED', correlationId });
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Conversation-Token, X-Correlation-ID, X-Demo-User',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }

    const handledApi = await handleApi(request, response, requestUrl, {
      platformRuntime: conversationStorageOnly ? null : platformRuntime,
      chatRuntime: platformRuntime,
      platformError,
      correlationId,
      legacyLimiter,
    });
    if (!handledApi) sendStaticFile(request, response, requestUrl);
  });
};

if (require.main === module) {
  const start = async () => {
    if (process.env.DEALETT_CONVERSATION_STORAGE_ONLY === 'true') {
      const { Pool } = require('pg');
      const { loadPlatformConfig } = require('./platform/config');
      const { migrateUp } = require('./platform/migrations');
      const config = loadPlatformConfig();
      const pool = new Pool({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl ? { rejectUnauthorized: true } : false,
        connectionTimeoutMillis: 10000,
      });
      try { await migrateUp(pool); } finally { await pool.end(); }
    }
    const server = createServer();
    server.listen(PORT, HOST, () => {
      console.log(`Dealett backend running on port ${PORT}`);
    });
  };
  start().catch(() => {
    console.error('Backend startup failed. Check conversation database configuration and migrations.');
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
};
