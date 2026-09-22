const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readEvents, replyPrefix } = require('./chat-stream');
const { createChatCompletion, setOpenAiTransportForTests } = require('./chat-service');
const { createServer } = require('./server');

process.env.OPENAI_API_KEY = 'test-key';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const analysis = { topic: 'greeting', interactionStage: 'greeting', recommendationRequested: false, qualification: {} };
const answer = { reply: 'Hej! Svenska åäö, "citat", ny rad\n😀', showOfferCards: false, quickReplies: [] };
const completed = { status: 'completed', output_text: JSON.stringify(answer), usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 50 } } };
const frame = event => `data: ${JSON.stringify(event)}\n\n`;

const transport = (mode = 'success', captured = []) => async (_url, options) => {
  const request = JSON.parse(options.body);
  captured.push(request);
  if (request.text.format.name === 'dealett_customer_need') return { ok: true, json: async () => ({ output_text: JSON.stringify(analysis), usage: { input_tokens: 200, output_tokens: 60 } }) };
  assert.equal(request.stream, true);
  assert.deepEqual(request.text.format.schema.required, ['reply', 'showOfferCards', 'quickReplies']);
  return {
    ok: true,
    body: (async function* () {
      const json = JSON.stringify(answer);
      for (let i = 0; i < json.length; i += 3) {
        yield Buffer.from(frame({ type: 'response.output_text.delta', delta: json.slice(i, i + 3) }));
      }
      await pause(80);
      if (mode === 'success') yield Buffer.from(frame({ type: 'response.completed', response: completed }));
      if (mode === 'failed') yield Buffer.from(frame({ type: 'response.failed' }));
    })(),
  };
};

test('reply prefix preserves escapes and split Unicode without exposing JSON fields', () => {
  const json = JSON.stringify(answer);
  let previous = '';
  for (let i = 0; i <= json.length; i++) {
    const prefix = replyPrefix(json.slice(0, i));
    assert.ok(answer.reply.startsWith(prefix));
    assert.ok(prefix.startsWith(previous));
    previous = prefix;
  }
  assert.equal(previous, answer.reply);
  assert.equal(replyPrefix('{"reply":"hello \\uD83D'), 'hello ');
  assert.equal(replyPrefix('{"reply":"hello \\uD83D\\uDE00"'), 'hello 😀');
});

test('SSE parser handles byte boundaries, CRLF, comments and multiline data', async () => {
  const bytes = Buffer.from(': keepalive\r\n\r\ndata: {"text":\r\ndata: "å😀"}\r\n\r\n');
  const results = [];
  await readEvents((async function* () { for (const byte of bytes) yield Uint8Array.of(byte); })(), e => results.push(e));
  assert.deepEqual(results, [{ text: 'å😀' }]);
  await assert.rejects(readEvents((async function* () { yield Buffer.from('data: {'); })(), () => {}), /Interrupted/);
});

test('chat streams text before completion, records tokens and reduces irrelevant inputs', async () => {
  const requests = [], metrics = [], deltas = [];
  setOpenAiTransportForTests(transport('success', requests));
  const start = performance.now();
  let first;
  const result = await createChatCompletion({ message: 'Hej' }, {
    onReplyDelta: text => { first ??= performance.now(); deltas.push(text); },
    onMetric: metric => metrics.push(metric),
  });
  assert.equal(deltas.join(''), answer.reply);
  assert.equal(result.reply, answer.reply);
  assert.ok(performance.now() - first >= 65);
  assert.ok(first >= start);
  assert.deepEqual(metrics.map(m => m.stage), ['analysis', 'preparation', 'answer']);
  assert.equal(metrics[2].outputTokens, 25);
  assert.equal(metrics[2].cachedInputTokens, 50);
  assert.equal(metrics[2].succeeded, true);
  assert.doesNotMatch(requests[0].input[0].content, /## Interface copy/);
  assert.doesNotMatch(requests[1].input[0].content, /## Message analysis/);
  assert.equal(JSON.parse(requests[1].input.at(-1).content).mobilePlanCatalog, undefined);
  assert.ok(!JSON.stringify(metrics).includes('Hej'));
});

test('interrupted and failed AI streams cannot become successful answers', async () => {
  for (const mode of ['truncated', 'failed']) {
    setOpenAiTransportForTests(transport(mode));
    const metrics = [];
    await assert.rejects(createChatCompletion({ message: 'Hej' }, { onReplyDelta() {}, onMetric: m => metrics.push(m) }));
    assert.equal(metrics.at(-1).succeeded, false);
  }
});

test('HTTP route emits delta then done; failures use error without done', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const mode of ['success', 'truncated']) {
      setOpenAiTransportForTests(transport(mode));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat`, {
        method: 'POST', headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Hej' }),
      });
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      const text = await response.text();
      assert.match(text, /event: delta/);
      if (mode === 'success') {
        assert.match(text, /event: done/);
        assert.ok(text.indexOf('event: delta') < text.indexOf('event: done'));
        assert.match(text, /"outputTokens":25/);
      } else {
        assert.match(text, /event: error/);
        assert.doesNotMatch(text, /event: done/);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    setOpenAiTransportForTests();
  }
});

test('client cancellation reaches the AI request', async () => {
  const controller = new AbortController();
  setOpenAiTransportForTests(async (_url, options) => {
    assert.ok(options.signal);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      controller.abort();
    });
  });
  await assert.rejects(createChatCompletion({ message: 'Hej' }, { signal: controller.signal }));
  setOpenAiTransportForTests();
});
