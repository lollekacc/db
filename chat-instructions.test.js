const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildChatInstructions } = require('./chat-instructions');

const instructions = fs.readFileSync(path.join(__dirname, 'chat/CHAT_INSTRUCTIONS.md'), 'utf8').replace(/\r\n?/g, '\n');

test('Windows and Unix instruction files yield identical model prompts', () => {
  const expected = buildChatInstructions(instructions);
  assert.deepEqual(buildChatInstructions(instructions.replaceAll('\n', '\r\n')), expected);
  assert.deepEqual(buildChatInstructions(instructions.replaceAll('\n', '\r')), expected);
});

test('analysis retains authority, truthfulness and streaming rules without reply-only instructions', () => {
  const { analysisInstructions } = buildChatInstructions(instructions.replaceAll('\n', '\r\n'));
  for (const heading of ['Role', 'Source authority', 'Truthfulness and scope', 'Message analysis']) {
    assert.ok(analysisInstructions.includes(`## ${heading}\n`), heading);
  }
  assert.match(analysisInstructions, /Treat streaming, watching streaming, and streamar as interest in streaming services/);
  assert.doesNotMatch(analysisInstructions, /## Recommendation calculation/);
});

test('reply modes omit analysis instructions and keep the appropriate sales scope', () => {
  const { replyInstructions, ordinaryReplyInstructions } = buildChatInstructions(instructions.replaceAll('\n', '\r\n'));
  assert.doesNotMatch(replyInstructions, /## (Message analysis|Task modes)\n/);
  assert.match(replyInstructions, /## Recommendation calculation\n/);
  assert.doesNotMatch(ordinaryReplyInstructions, /## (Recommendation calculation|Decision support and tradeoffs|Secondary offer)\n/);
  assert.match(ordinaryReplyInstructions, /## Truthfulness and scope\n/);
});
