const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createVoiceSession } = require('./voice-service');

test('voice validates offers and keeps API credentials on the server', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_VOICE_MODEL;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_VOICE_MODEL;
    await assert.rejects(createVoiceSession({ sdp: 'invalid' }), { statusCode: 400 });
    await assert.rejects(createVoiceSession({ sdp: 'v=0' + 'x'.repeat(65536) }), { statusCode: 400 });
    await assert.rejects(createVoiceSession({ sdp: 'v=0\r\n' }), { statusCode: 503 });
    process.env.OPENAI_API_KEY = 'test-voice-secret';
    const result = await createVoiceSession({ sdp: 'v=0\r\n', language: 'en', model: 'untrusted' }, {
      transport: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
        assert.equal(options.headers.Authorization, 'Bearer test-voice-secret');
        const session = JSON.parse(options.body.get('session'));
        assert.equal(session.model, 'gpt-realtime-2');
        assert.equal(session.audio.input.turn_detection.create_response, false);
        assert.equal(session.audio.input.transcription.language, 'en');
        assert.equal(options.body.get('sdp'), 'v=0\r\n');
        return new Response('v=0\r\nanswer');
      },
    });
    assert.deepEqual(result, { sdp: 'v=0\r\nanswer' });
    for (const status of [401, 429, 500]) {
      await assert.rejects(createVoiceSession({ sdp: 'v=0' }, {
        transport: async () => new Response('private upstream details', { status }),
      }), { statusCode: status === 429 ? 429 : 503, message: 'Voice connection unavailable' });
    }
  } finally {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_VOICE_MODEL;
    else process.env.OPENAI_VOICE_MODEL = originalModel;
  }
});

test('voice endpoint respects preview, method, origin and rate limits', async () => {
  const { createServer } = require('./server');
  const start = async options => {
    const server = createServer(options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}/api/voice/session` };
  };
  for (const preview of [true, false]) {
    const { server, url } = await start({ publicPreview: preview, legacyLimiter: { consume: key => ({ allowed: !key.startsWith('voice:') }) } });
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, preview ? 423 : 429);
      assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
      if (!preview) assert.equal((await fetch(url)).status, 405);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }
});
