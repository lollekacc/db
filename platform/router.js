const { PlatformError } = require('./errors');
const { buildHeaders, readJsonBody, sendCsv, sendJson, sendPlatformError } = require('./http');
const { requirePermission, resolveAuthContext } = require('./permissions');

const getClientKey = (request) => {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket?.remoteAddress || 'unknown';
};

const consumeRateLimit = (runtime, request, kind) => {
  const limit = kind === 'chat' ? runtime.config.chatRateLimit : runtime.config.orderRateLimit;
  const result = runtime.limiter.consume(`${kind}:${getClientKey(request)}`, limit);
  if (!result.allowed) {
    const error = new PlatformError('RATE_LIMITED', 'Too many requests; try again later', 429, {
      retryAfterSeconds: Math.max(Math.ceil((result.resetAt - Date.now()) / 1000), 1),
    });
    error.rateLimit = result;
    throw error;
  }
  return result;
};

const makeDemoChatResult = (body) => ({
  reply: 'Detta är ett simulerat demosvar. Ingen extern AI-tjänst anropades.',
  message: 'Detta är ett simulerat demosvar. Ingen extern AI-tjänst anropades.',
  language: body.language || 'sv',
  topic: 'demo',
  qualification: body.qualification || {},
  flowState: body.flowState || {},
  offerCalculation: null,
  quickReplies: [],
  quickReplyMode: 'single',
  quickReplySubmitLabel: '',
  suggestions: [],
  offerCards: [],
  embeddedWidget: null,
  source: 'demo-simulated',
  model: 'demo-simulated',
  simulated: true,
});

const buildContext = (correlationId, actor = null) => ({ correlationId, actor });

const handlePlatformRequest = async (request, response, requestUrl, runtime, correlationId) => {
  const { pathname, searchParams } = requestUrl;
  const isVersioned = /^\/api\/(public|admin|customer|partner)\/v1(?:\/|$)/.test(pathname);
  const isCompatibilityOrder = pathname === '/api/orders';
  if (!isVersioned && !isCompatibilityOrder) return false;

  try {
    if (request.method === 'OPTIONS') {
      const origin = String(request.headers.origin || '').replace(/\/$/, '');
      if (origin && !runtime.config.corsOrigins.includes(origin)) {
        throw new PlatformError('CORS_ORIGIN_DENIED', 'Origin is not allowed', 403);
      }
      response.writeHead(204, buildHeaders(request, runtime.config, correlationId, {
        'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Conversation-Token, X-Correlation-ID, X-Demo-User',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
        'Access-Control-Max-Age': '600',
      }));
      response.end();
      return true;
    }

    if (pathname === '/api/public/v1/environment' && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, await runtime.repository.getEnvironmentSummary());
      return true;
    }

    if (pathname === '/api/public/v1/health/live' && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, { ok: true, status: 'live', correlationId });
      return true;
    }

    if (pathname === '/api/public/v1/health/ready' && request.method === 'GET') {
      const environment = await runtime.repository.getEnvironmentSummary();
      sendJson(request, response, runtime.config, correlationId, 200, { ok: true, status: 'ready', repository: environment.repository, demoMode: environment.demoMode, correlationId });
      return true;
    }

    if (pathname === '/api/public/v1/conversations' && request.method === 'POST') {
      consumeRateLimit(runtime, request, 'chat');
      const body = await readJsonBody(request);
      const created = await runtime.service.createConversation(body, buildContext(correlationId));
      sendJson(request, response, runtime.config, correlationId, created.existing ? 200 : 201, {
        conversationId: created.conversation.id,
        conversationToken: created.token,
        existing: created.existing,
        createdAt: created.conversation.createdAt,
        demoMode: runtime.config.demoMode,
      });
      return true;
    }

    const messageMatch = /^\/api\/public\/v1\/conversations\/([^/]+)\/messages$/.exec(pathname);
    if (messageMatch && request.method === 'POST') {
      consumeRateLimit(runtime, request, 'chat');
      const body = await readJsonBody(request);
      const conversationToken = String(request.headers['x-conversation-token'] || body.conversationToken || '');
      const chatPayload = {
        ...body,
        conversationId: decodeURIComponent(messageMatch[1]),
        conversationToken,
        message: body.message || body.content,
        clientMessage: body.clientMessage || { id: body.id, sequence: body.sequence, createdAt: body.createdAt },
      };
      const turn = await runtime.service.beginChatTurn(chatPayload, buildContext(correlationId));
      let result;
      if (body.generateReply === false) {
        if (!runtime.config.demoMode) throw new PlatformError('DEMO_ONLY', 'generateReply=false is available only in demo mode', 409);
        result = makeDemoChatResult(body);
      } else {
        try {
          result = await runtime.service.chatCompletion({
            ...body,
            message: chatPayload.message,
            messages: (await runtime.repository.getConversation(turn.conversationId, { token: turn.conversationToken, requireToken: true })).messages,
          });
        } catch (error) {
          if (!runtime.config.demoMode || error.statusCode !== 503) throw error;
          result = makeDemoChatResult(body);
        }
      }
      const assistant = await runtime.service.completeChatTurn(turn, result, buildContext(correlationId));
      sendJson(request, response, runtime.config, correlationId, 200, {
        ...result,
        conversationId: turn.conversationId,
        conversationToken: turn.conversationToken,
        messageMetadata: {
          id: assistant.message.id,
          sequence: assistant.message.sequence,
          createdAt: assistant.message.createdAt,
          model: assistant.message.model || result.model || null,
          assistant: { id: assistant.message.id, sequence: assistant.message.sequence, createdAt: assistant.message.createdAt },
        },
        userMessageMetadata: { id: turn.user.id, sequence: turn.user.sequence, createdAt: turn.user.createdAt },
      });
      return true;
    }

    if (pathname === '/api/public/v1/quotes' && request.method === 'POST') {
      consumeRateLimit(runtime, request, 'order');
      const body = await readJsonBody(request);
      const quote = await runtime.service.createQuote(body, buildContext(correlationId));
      sendJson(request, response, runtime.config, correlationId, 201, quote);
      return true;
    }

    if ((pathname === '/api/public/v1/orders' || isCompatibilityOrder) && request.method === 'POST') {
      consumeRateLimit(runtime, request, 'order');
      const body = await readJsonBody(request);
      const result = await runtime.service.createOrder(body, request.headers['idempotency-key'], buildContext(correlationId));
      const receipt = result.receipt;
      sendJson(request, response, runtime.config, correlationId, result.replayed ? 200 : 201, {
        ok: true,
        duplicate: result.replayed,
        replayed: result.replayed,
        ...receipt,
        storedAt: receipt.acceptedAt,
      }, { 'Idempotency-Replayed': result.replayed ? 'true' : 'false' });
      return true;
    }

    const audienceMatch = /^\/api\/(admin|customer|partner)\/v1(?:\/|$)/.exec(pathname);
    if (!audienceMatch) throw new PlatformError('ROUTE_NOT_FOUND', 'API route not found', 404);
    const audience = audienceMatch[1];
    const actor = resolveAuthContext(request, runtime.config, await runtime.repository.getUsers(), audience);
    const context = buildContext(correlationId, actor);

    if (pathname === `/api/${audience}/v1/session` && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, {
        actor,
        authentication: 'mock',
        demoMode: true,
        warning: 'Fictional demo data only. Live authentication is disabled.',
      });
      return true;
    }

    if (audience === 'admin' && pathname === '/api/admin/v1/overview' && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.getDashboard(actor));
      return true;
    }

    const base = `/api/${audience}/v1/orders`;
    if (pathname === `${base}/export.csv` && request.method === 'GET') {
      const csv = await runtime.service.exportOrdersCsv(actor, searchParams);
      sendCsv(request, response, runtime.config, correlationId, `dealett-${audience}-orders.csv`, csv);
      return true;
    }
    if (pathname === base && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.listOrders(actor, searchParams));
      return true;
    }
    const orderMatch = new RegExp(`^${base}/([^/]+)$`).exec(pathname);
    if (orderMatch && request.method === 'GET') {
      sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.getOrder(actor, decodeURIComponent(orderMatch[1])));
      return true;
    }
    const transitionMatch = new RegExp(`^${base}/([^/]+)/transitions$`).exec(pathname);
    if (transitionMatch && request.method === 'POST') {
      const body = await readJsonBody(request);
      sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.transitionOrder(actor, decodeURIComponent(transitionMatch[1]), body, context));
      return true;
    }

    if (audience === 'admin') {
      const reportCreateMatch = /^\/api\/admin\/v1\/orders\/([^/]+)\/reports$/.exec(pathname);
      if (reportCreateMatch && request.method === 'POST') {
        sendJson(request, response, runtime.config, correlationId, 201, await runtime.service.generateReport(actor, decodeURIComponent(reportCreateMatch[1]), context));
        return true;
      }
      const reportMatch = /^\/api\/admin\/v1\/reports\/([^/]+)$/.exec(pathname);
      if (reportMatch && request.method === 'GET') {
        sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.getReport(actor, decodeURIComponent(reportMatch[1])));
        return true;
      }
      if (pathname === '/api/admin/v1/audit' && request.method === 'GET') {
        sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.listAudit(actor, searchParams));
        return true;
      }
      const integrationMatch = /^\/api\/admin\/v1\/integrations\/([^/]+)\/simulate$/.exec(pathname);
      if (integrationMatch && request.method === 'POST') {
        const body = await readJsonBody(request);
        sendJson(request, response, runtime.config, correlationId, 200, await runtime.service.simulateIntegration(actor, decodeURIComponent(integrationMatch[1]), body, context));
        return true;
      }
      const resourceMatch = /^\/api\/admin\/v1\/(customers|conversations|operators|rules|campaigns|gift-cards|commissions|support-cases|communications|analytics|tasks|documents|integrations|employees|compliance|settings)$/.exec(pathname);
      if (resourceMatch && request.method === 'GET') {
        sendJson(request, response, runtime.config, correlationId, 200, {
          items: await runtime.service.listResource(actor, resourceMatch[1]),
          demoMode: runtime.config.demoMode,
        });
        return true;
      }
    }

    throw new PlatformError('ROUTE_NOT_FOUND', 'API route not found', 404);
  } catch (error) {
    const extraHeaders = error.rateLimit ? { 'Retry-After': String(Math.max(Math.ceil((error.rateLimit.resetAt - Date.now()) / 1000), 1)) } : {};
    if (Object.keys(extraHeaders).length) {
      response.setHeader('Retry-After', extraHeaders['Retry-After']);
    }
    sendPlatformError(request, response, runtime.config, correlationId, error);
    return true;
  }
};

module.exports = {
  handlePlatformRequest,
  makeDemoChatResult,
};
