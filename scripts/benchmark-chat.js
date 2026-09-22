const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const baselinePath = args[args.indexOf('--baseline') + 1];
if (!args.includes('--baseline') || !baselinePath) throw new Error('Provide --baseline /path/to/baseline-backend');
const live = args.includes('--live');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*(OPENAI_API_KEY|OPENAI_MODEL|OPENAI_ANALYSIS_MODEL)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}
if (live && !process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for a live comparison');
if (!live) process.env.OPENAI_API_KEY = 'offline-benchmark';
const versions = {
  before: require(path.join(path.resolve(baselinePath), 'chat-service')),
  after: require('../chat-service'),
};
const scenarios = [
  { name: 'greeting', message: 'Hej', analysis: { interactionStage: 'greeting', topic: 'greeting', recommendationRequested: false } },
  { name: 'information', message: 'Vad är Dealett?', analysis: { interactionStage: 'understand', topic: 'Dealett', recommendationRequested: false, knowledgeQuery: 'Dealett' } },
  { name: 'guided', message: 'Jag vill göra en detaljerad jämförelse av mobilabonnemang.', analysis: { interactionStage: 'understand', topic: 'mobile', recommendationRequested: true, offerPreference: 'personalized' } },
  { name: 'preview', message: 'Visa mobilabonnemang under 300 kr direkt.', analysis: { interactionStage: 'solve', topic: 'mobile', recommendationRequested: true, offerPreference: 'preview', qualification: { monthlyBudget: { amount: 300, scope: 'total', inclusive: false } } } },
];
const output = [];
(async () => {
  for (const scenario of scenarios) {
    for (const [version, service] of Object.entries(versions)) {
      const requests = [], stages = [];
      let firstTextMs = null;
      let streamed = '';
      const started = performance.now();
      service.setOpenAiTransportForTests(async (url, options) => {
        const request = JSON.parse(options.body);
        const stage = request.text.format.name === 'dealett_customer_need' ? 'analysis' : 'answer';
        const entry = { stage, model: request.model, inputCharacters: request.input.reduce((n, item) => n + item.content.length, 0), requestCharacters: options.body.length, requiredFields: request.text.format.schema.required.length };
        requests.push(entry);
        if (live) {
          const apiStart = performance.now();
          const response = await fetch(url, options);
          return {
            ok: response.ok, status: response.status, body: response.body,
            json: async () => {
              const body = await response.json();
              entry.durationMs = Math.round(performance.now() - apiStart);
              entry.inputTokens = body.usage?.input_tokens;
              entry.outputTokens = body.usage?.output_tokens;
              return body;
            },
          };
        }
        const data = stage === 'analysis' ? { qualification: {}, ...scenario.analysis } : {
          reply: 'Testsvaret använder beräknade uppgifter.', showOfferCards: true, quickReplies: [],
          bestMatchReason: '', lowestEffectiveCostReason: '', bestMatchBenefits: [], lowestEffectiveCostBenefits: [],
          offerCardCopy: { bestMatchLabel: 'Exempel', lowestEffectiveCostLabel: 'Alternativ', dataTitle: 'Surf', monthlyPriceTitle: 'Pris', totalPriceTitle: 'Totalt', perPersonPriceTitle: 'Per person', perMonthSuffix: '/mån', perPersonSuffix: '/person/mån', bindingTitle: 'Bindningstid', bindingMonthsSuffix: ' månader', rewardLabel: 'Presentkort', ctaLabel: 'Välj' },
        };
        const completed = { status: 'completed', output_text: JSON.stringify(data) };
        return { ok: true, json: async () => completed, body: (async function* () {
          yield Buffer.from(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(data) })}\n\n`);
          yield Buffer.from(`data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`);
        })() };
      });
      try {
        const result = await service.createChatCompletion({ message: scenario.message, messages: [], language: 'sv', page: { path: 'index.html', title: 'Dealett' } }, version === 'after' ? {
          onMetric: m => stages.push(m),
          onReplyDelta: delta => { firstTextMs ??= Math.round(performance.now() - started); streamed += delta; },
        } : {});
        const totalMs = Math.round(performance.now() - started);
        output.push({ scenario: scenario.name, version, mode: live ? 'live-api' : 'offline-fixture', ...(live ? { totalMs, firstTextMs: firstTextMs ?? totalMs } : {}), requests, ...(live ? { stages } : {}), result: { reply: result.reply, cards: result.offerCards.map(card => ({ id: card.planId, price: card.monthlyPriceLabel })), mode: result.qualification.recommendationMode, streamedMatchesReply: version === 'after' ? streamed.trim() === result.reply : null } });
      } catch (error) {
        output.push({ scenario: scenario.name, version, error: error.message, requests });
      } finally { service.setOpenAiTransportForTests(); }
    }
  }
  console.log(JSON.stringify(output, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
