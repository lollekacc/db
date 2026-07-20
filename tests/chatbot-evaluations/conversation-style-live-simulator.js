#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CHAT_API_URL = 'http://localhost:3000/api/chat';
const CHAT_API_URL = process.env.CHAT_API_URL || DEFAULT_CHAT_API_URL;
const OUTPUT_DIR = path.join(__dirname, 'results');

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
const escapeMarkdown = (value) => String(value ?? '').replace(/\|/g, '\\|');

const scenarios = [
  { name: 'Direct choose for me', style: 'direct_answer', turns: ['välj ett abonnemang åt mig utan att fråga någonting alls'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Direct if you were me', style: 'direct_answer', turns: ['om du var jag, vad hade du valt?'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Direct say what to take', style: 'direct_answer', turns: ['säg vad jag ska ta'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Direct no questions mobile', style: 'direct_answer', turns: ['välj ett mobilabonnemang åt mig utan frågor'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Impatient many questions', style: 'impatient', turns: ['jag orkar inte svara på massa frågor'], expectsGuess: true, expectsAnswer: /kort|täckning|stabilitet|mobilabonnemang|bredband/i },
  { name: 'Impatient short answer', style: 'impatient', turns: ['kort svar tack'], expectsGuess: true, expectsAnswer: /kort|täckning|stabilitet|mobilabonnemang|bredband/i },
  { name: 'Impatient just say', style: 'impatient', turns: ['ställ inte massa frågor bara säg'], expectsGuess: true, expectsAnswer: /kort|täckning|stabilitet|mobilabonnemang|bredband/i },
  { name: 'Skeptical paid', style: 'skeptical', turns: ['får ni betalt?'], expectsAnswer: /ersättning|partners|nuvarande avtal|inte värt|tillit|pressa/i },
  { name: 'Skeptical trust', style: 'skeptical', turns: ['varför ska jag lita på er?'], expectsAnswer: /ersättning|partners|nuvarande avtal|inte värt|tillit|pressa/i },
  { name: 'Skeptical ad motive', style: 'skeptical', turns: ['är detta bara reklam så ni kan sälja?'], expectsAnswer: /ersättning|partners|nuvarande avtal|inte värt|tillit|pressa/i },
  { name: 'Browsing from ad', style: 'browsing', turns: ['jag såg er reklam och tänkte kika'], expectsAnswer: /välkommen|dealett|pris|täckning|bindningstid|belöning|kika/i },
  { name: 'Browsing what is this', style: 'browsing', turns: ['vad är detta? såg något om er'], expectsAnswer: /dealett|kika|jämföra|abonnemang|täckning|pris/i },
  { name: 'Browsing casual', style: 'browsing', turns: ['tänkte bara kika runt lite'], expectsAnswer: /kika|dealett|jämför|abonnemang|börjar.*när du vill/i },
  { name: 'Confused fragment ria', style: 'confused', turns: ['ria'], expectsAnswer: /inte helt säker|mobil|bredband|täckning|dealett/i },
  { name: 'Confused no idea', style: 'confused', turns: ['ingen aning'], expectsAnswer: /inte helt säker|mobil|bredband|täckning|dealett/i },
  { name: 'Confused invoice', style: 'confused', turns: ['fattar inte fakturan'], expectsAnswer: /faktura|total|användare|tjänster|rader|kostnad/i },
  { name: 'Comparison coverage', style: 'comparison', turns: ['vilken operatör har bäst täckning?'], expectsGuess: true, expectsAnswer: /täckning|adress|hemma|pendling|kan inte garantera|nät/i },
  { name: 'Comparison two operators', style: 'comparison', turns: ['Telia eller Tele2?'], expectsGuess: true, expectsAnswer: /täckning|nät|pris|jämför|kan inte garantera|område/i },
  { name: 'Comparison Telia Tre', style: 'comparison', turns: ['jämför telia och tre snabbt'], expectsGuess: true, expectsAnswer: /jämförelse|pris|täckning|villkor|surf|nät/i },
  { name: 'Complaint Tele2 home', style: 'complaint_or_problem', turns: ['Tele2 suger hemma'], expectsGuess: true, expectsAnswer: /täckning|inomhus|wifi|nät|operatör|hemma/i },
  { name: 'Complaint internet lag', style: 'complaint_or_problem', turns: ['internet laggar hela tiden'], expectsGuess: true, expectsAnswer: /täckning|hastighet|router|enhet|problem|kostnad/i },
  { name: 'Complaint expensive', style: 'complaint_or_problem', turns: ['jag betalar för mycket'], expectsGuess: true, expectsAnswer: /kostnad|pris|jämför|huvudproblemet|täckning|hastighet/i },
  { name: 'Reward highest gift card', style: 'reward_focused', turns: ['jag vill ha högsta presentkortet bara'], expectsAnswer: /presentkort|belöning|totalvärde|dyrare|inte.*bara|passar/i },
  { name: 'Reward most bonus', style: 'reward_focused', turns: ['vilket ger mest bonus?'], expectsAnswer: /bonus|belöning|presentkort|totalvärde|dyrare|inte.*bara/i },
  { name: 'Human test sell me', style: 'human_test', turns: ['sälj något till mig'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Human test surprise', style: 'human_test', turns: ['överraska mig'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Human test guess', style: 'human_test', turns: ['jag vet inte, gissa'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|allround|gissning|inte exakt/i },
  { name: 'Advisor normal family', style: 'advisor', turns: ['Jag vill hitta bästa abonnemanget för familjen'], expectsAnswer: /familj|abonnemang|hur många|jämför/i },
  { name: 'Advisor compare help', style: 'advisor', turns: ['Kan du hjälpa mig jämföra?'], expectsAnswer: /jämför|abonnemang|mobil|bredband|hur många/i },
  { name: 'Multi turn preserve direct', style: 'direct_answer', turns: ['välj något åt mig utan frågor', 'okej gissa vidare'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|gissning|inte exakt/i },
  { name: 'Browsing to direct answer', style: 'direct_answer', turns: ['jag såg er reklam och tänkte kika', 'okej välj något åt mig'], expectsGuess: true, expectsAnswer: /mellanstort|20-30|gissning|inte exakt/i },
  { name: 'Direct broadband context', style: 'direct_answer', turns: ['välj bredband åt mig utan frågor'], expectsGuess: true, expectsAnswer: /5g-bredband|adress|täckningskarta|gissning|inte.*exakt/i },
];

const postChat = async (payload) => {
  const response = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Chat API failed with HTTP ${response.status}`);
  return body;
};

const countQuestions = (text) => (String(text || '').match(/\?/g) || []).length;
const firstSentence = (text) => String(text || '').split(/[.!?]\s+/)[0] || '';

const hasGenericRestart = (text) => (
  /^(hej|hi)[!.]?\s*(jag kan hjälpa|hur kan jag hjälpa|vad kan jag hjälpa|how can i help)/i.test(String(text || '').trim()) ||
  /vad vill du ha hjälp med hos dealett/i.test(String(text || ''))
);

const hasFakeSpecificRecommendation = (text) => (
  /(jag rekommenderar|välj|ta)\s+(telia|tele2|telenor|tre).{0,80}\d{2,4}\s*(kr|sek)/i.test(String(text || ''))
);

const answerComesBeforeQuestion = (text) => {
  const reply = String(text || '').trim();
  const firstQuestion = reply.indexOf('?');
  if (firstQuestion < 0) return true;
  const answerPrefix = /(om jag måste|kort svar|praktiskt|ja,|välkommen|jag kan|först|ett säkert|as a practical|if i must|short answer)/i;
  return answerPrefix.test(firstSentence(reply)) && firstQuestion > 35;
};

const rewardOverFit = (text) => (
  /presentkort|bonus|belöning/i.test(String(text || '')) &&
  !/passar|behov|totalvärde|total|dyrare|inte.*bara|värt|värde|kostnad/i.test(String(text || ''))
);

const noDisclaimerOnGuess = (scenario, turn) => {
  const text = String(turn.botReply || '');
  const style = turn.response.conversationStyle?.style || scenario.style;
  const guessLike = scenario.expectsGuess &&
    ['direct_answer', 'human_test', 'impatient', 'comparison', 'complaint_or_problem'].includes(style);
  if (!guessLike) return false;
  return !/gissning|inte en exakt|inte exakt|kvalificerad|kan inte garantera|första bedömning|rough|not an exact|not a guarantee|first assessment/i.test(text);
};

const buildIssue = (code, severity, message, turn = null) => ({ code, severity, message, turn });

const detectIssues = (scenario, transcript) => {
  const issues = [];
  const fullBotText = transcript.map((turn) => turn.botReply).join('\n');
  const detectedStyles = transcript.map((turn) => turn.response.conversationStyle?.style).filter(Boolean);

  transcript.forEach((turn, index) => {
    const reply = turn.botReply || '';
    const style = turn.response.conversationStyle?.style || scenario.style;
    const maxQuestions = Number(turn.response.conversationStyle?.responsePolicy?.maxQuestions || 1);

    if (countQuestions(reply) > maxQuestions) {
      issues.push(buildIssue('too_many_questions', 'critical', `Bot asked more than ${maxQuestions} question(s).`, index + 1));
    }
    if (hasGenericRestart(reply) && index > 0) {
      issues.push(buildIssue('generic_restart', 'critical', 'Bot restarted after context existed.', index + 1));
    }
    if (hasFakeSpecificRecommendation(reply)) {
      issues.push(buildIssue('fake_specific_recommendation', 'critical', 'Bot gave an exact operator/price recommendation without validated offer context.', index + 1));
    }
    if (['direct_answer', 'human_test', 'impatient'].includes(style) && !answerComesBeforeQuestion(reply)) {
      issues.push(buildIssue('asked_before_answer_when_direct', 'critical', 'Bot asked before giving a direct safe answer.', index + 1));
    }
    if (style === 'reward_focused' && rewardOverFit(reply)) {
      issues.push(buildIssue('reward_over_fit', 'critical', 'Bot prioritized reward without plan fit or total value.', index + 1));
    }
    if (noDisclaimerOnGuess(scenario, turn)) {
      issues.push(buildIssue('no_disclaimer_on_guess', 'critical', 'Bot made or implied a guess without a disclaimer.', index + 1));
    }
  });

  if (scenario.style && !detectedStyles.includes(scenario.style)) {
    issues.push(buildIssue('confusing_response', 'major', `Expected style ${scenario.style}, detected ${detectedStyles.join(', ') || 'none'}.`));
  }
  if (scenario.expectsAnswer && !scenario.expectsAnswer.test(fullBotText)) {
    issues.push(buildIssue('confusing_response', 'critical', 'Bot response did not contain the expected style-specific guidance.'));
  }
  if (scenario.style === 'skeptical' && !/ersättning|partners|nuvarande avtal|tillit|pressa/i.test(fullBotText)) {
    issues.push(buildIssue('ignored_skepticism', 'critical', 'Bot did not explain Dealett incentive/trust clearly.'));
  }
  if (scenario.style === 'browsing' && !/kika|reklam|välkommen|börjar.*när du vill|jämför/i.test(fullBotText)) {
    issues.push(buildIssue('ignored_browsing_context', 'critical', 'Bot ignored browsing/ad context.'));
  }
  if (scenario.style === 'impatient' && !/kort|en fråga|mobilabonnemang eller bredband|stabilitet/i.test(fullBotText)) {
    issues.push(buildIssue('ignored_impatience', 'critical', 'Bot ignored impatience.'));
  }

  return issues;
};

const scoreFromIssues = (issues) => {
  if (issues.some((issue) => issue.severity === 'critical')) return 1;
  const major = issues.filter((issue) => issue.severity === 'major').length;
  if (major >= 2) return 2;
  if (major === 1) return 3;
  return 5;
};

const recommendedFixesForIssues = (issues) => {
  const fixes = {
    asked_before_answer_when_direct: 'For direct/impatient/human-test styles, answer first with a safe qualified guess, then ask one optional question.',
    too_many_questions: 'Enforce the style maxQuestions policy before sending replies.',
    generic_restart: 'Preserve conversation style/context across turns.',
    ignored_skepticism: 'Use the trust/incentive explanation for skeptical style.',
    ignored_browsing_context: 'Keep browsing/ad users out of strict qualification until they ask to compare.',
    ignored_impatience: 'Compress impatient replies and ask at most one question.',
    fake_specific_recommendation: 'Do not name an exact operator and price unless the offer calculator validated it.',
    reward_over_fit: 'Keep plan fit and total value ahead of reward size.',
    no_disclaimer_on_guess: 'Label guesses as qualified guesses, not exact personal recommendations.',
    confusing_response: 'Add or tune style-specific response guidance.',
  };
  return [...new Set(issues.map((issue) => fixes[issue.code]).filter(Boolean))];
};

const runScenario = async (scenario, runStamp) => {
  const sessionId = `${runStamp}-style-${slugify(scenario.name)}`;
  const messages = [];
  let qualification = {};
  let cart = [];
  let conversationStyle = null;
  const transcript = [];

  for (const [index, userMessage] of scenario.turns.entries()) {
    const response = await postChat({
      sessionId,
      message: userMessage,
      messages,
      language: 'sv',
      qualification,
      cart,
      conversationStyle,
      context: { conversationStyle },
      page: {},
    });
    const botReply = String(response.reply || '').trim();
    transcript.push({
      turn: index + 1,
      userMessage,
      botReply,
      response: {
        intent: response.intent,
        qualification: response.qualification,
        conversationStyle: response.conversationStyle,
        marketClassification: response.marketClassification,
        offerCalculation: response.offerCalculation
          ? {
            readyForOffer: response.offerCalculation.readyForOffer,
            validOfferAvailable: response.offerCalculation.validOfferAvailable,
          }
          : null,
      },
    });
    messages.push({ role: 'user', content: userMessage }, { role: 'assistant', content: botReply });
    qualification = response.qualification || qualification;
    cart = response.cart || cart;
    conversationStyle = response.conversationStyle || conversationStyle;
  }

  const issues = detectIssues(scenario, transcript);
  const evaluation = {
    score: scoreFromIssues(issues),
    issues,
    recommendedFixes: recommendedFixesForIssues(issues),
  };

  return { scenario, sessionId, transcript, evaluation };
};

const renderTranscriptMarkdown = ({ scenario, sessionId, transcript, evaluation, jsonPath }) => {
  const issueRows = evaluation.issues.length
    ? evaluation.issues.map((issue) => `| ${escapeMarkdown(issue.code)} | ${escapeMarkdown(issue.severity)} | ${issue.turn || ''} | ${escapeMarkdown(issue.message)} |`).join('\n')
    : '| none | none |  | No automatic issues detected. |';
  const transcriptText = transcript.map((turn) => [
    `### Turn ${turn.turn}`,
    '',
    '**Customer:**',
    '',
    turn.userMessage,
    '',
    '**Dealett AI:**',
    '',
    turn.botReply,
    '',
    '**API Signals:**',
    '',
    `- intent: ${turn.response.intent || 'unknown'}`,
    `- style: ${turn.response.conversationStyle?.style || 'unknown'}`,
    `- market status: ${turn.response.marketClassification?.status || 'none'}`,
    `- valid offer: ${turn.response.offerCalculation?.validOfferAvailable === true ? 'yes' : 'no'}`,
  ].join('\n')).join('\n\n');

  return [
    `# Conversation Style Live Simulation: ${scenario.name}`,
    '',
    `- Timestamp: ${new Date().toISOString()}`,
    `- Session: ${sessionId}`,
    `- API: ${CHAT_API_URL}`,
    `- Expected style: ${scenario.style}`,
    `- JSON: ${jsonPath}`,
    `- Final score: ${evaluation.score}/5`,
    '',
    '## Transcript',
    '',
    transcriptText,
    '',
    '## Detected Issues',
    '',
    '| Code | Severity | Turn | Notes |',
    '|---|---|---:|---|',
    issueRows,
    '',
    '## Recommended Fixes',
    '',
    (evaluation.recommendedFixes.length ? evaluation.recommendedFixes : ['No automatic fix required.']).map((fix) => `- ${fix}`).join('\n'),
    '',
  ].join('\n');
};

const saveScenarioResult = (result, runStamp) => {
  const baseName = `${runStamp}-style-${slugify(result.scenario.name)}`;
  const jsonPath = path.join(OUTPUT_DIR, `${baseName}.json`);
  const mdPath = path.join(OUTPUT_DIR, `${baseName}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    apiUrl: CHAT_API_URL,
    scenarioName: result.scenario.name,
    expectedStyle: result.scenario.style,
    sessionId: result.sessionId,
    transcript: result.transcript,
    evaluation: result.evaluation,
  }, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderTranscriptMarkdown({ ...result, jsonPath }));
  return { jsonPath, mdPath };
};

const summarizeResults = (results) => {
  const totalConversations = results.length;
  const averageScore = totalConversations
    ? Math.round((results.reduce((sum, result) => sum + result.evaluation.score, 0) / totalConversations) * 100) / 100
    : 0;
  const issueCounts = new Map();
  const fixCounts = new Map();
  results.forEach((result) => {
    result.evaluation.issues.forEach((issue) => issueCounts.set(issue.code, (issueCounts.get(issue.code) || 0) + 1));
    result.evaluation.recommendedFixes.forEach((fix) => fixCounts.set(fix, (fixCounts.get(fix) || 0) + 1));
  });

  return {
    timestamp: new Date().toISOString(),
    apiUrl: CHAT_API_URL,
    totalConversations,
    averageScore,
    lowestScoringScenarios: [...results]
      .sort((left, right) => left.evaluation.score - right.evaluation.score || left.scenario.name.localeCompare(right.scenario.name))
      .slice(0, 5)
      .map((result) => ({
        scenarioName: result.scenario.name,
        expectedStyle: result.scenario.style,
        score: result.evaluation.score,
        issues: result.evaluation.issues.map((issue) => issue.code),
        markdownPath: result.paths.mdPath,
        jsonPath: result.paths.jsonPath,
      })),
    repeatedFlags: [...issueCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([code, count]) => ({ code, count })),
    transcripts: results.map((result) => ({
      scenarioName: result.scenario.name,
      expectedStyle: result.scenario.style,
      score: result.evaluation.score,
      markdownPath: result.paths.mdPath,
      jsonPath: result.paths.jsonPath,
    })),
    recommendedFixes: [...fixCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([fix, count]) => ({ fix, count })),
  };
};

const renderSummaryMarkdown = (summary) => {
  const lowestRows = summary.lowestScoringScenarios.length
    ? summary.lowestScoringScenarios.map((item) => `| ${escapeMarkdown(item.scenarioName)} | ${escapeMarkdown(item.expectedStyle)} | ${item.score} | ${escapeMarkdown(item.issues.join(', ') || 'none')} | ${item.markdownPath} |`).join('\n')
    : '| none |  |  |  |  |';
  const issueRows = summary.repeatedFlags.length
    ? summary.repeatedFlags.map((item) => `| ${escapeMarkdown(item.code)} | ${item.count} |`).join('\n')
    : '| none | 0 |';
  const fixRows = summary.recommendedFixes.length
    ? summary.recommendedFixes.map((item) => `- ${item.fix} (${item.count})`).join('\n')
    : '- No repeated fixes suggested.';

  return [
    '# Conversation Style Live Evaluation Summary',
    '',
    `- Timestamp: ${summary.timestamp}`,
    `- API: ${summary.apiUrl}`,
    `- Total conversations: ${summary.totalConversations}`,
    `- Average score: ${summary.averageScore}/5`,
    '',
    '## Lowest Scoring Scenarios',
    '',
    '| Scenario | Expected Style | Score | Issues | Transcript |',
    '|---|---|---:|---|---|',
    lowestRows,
    '',
    '## Repeated Flags',
    '',
    '| Flag | Count |',
    '|---|---:|',
    issueRows,
    '',
    '## Recommended Fixes',
    '',
    fixRows,
    '',
  ].join('\n');
};

(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const runStamp = timestamp();
  const results = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, runStamp);
    result.paths = saveScenarioResult(result, runStamp);
    results.push(result);
    console.log(`Saved ${scenario.name}: ${result.paths.mdPath}`);
  }

  const summary = summarizeResults(results);
  const summaryJsonPath = path.join(OUTPUT_DIR, 'latest-conversation-style-summary.json');
  const summaryMdPath = path.join(OUTPUT_DIR, 'latest-conversation-style-summary.md');
  fs.writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(summaryMdPath, renderSummaryMarkdown(summary));

  console.log('');
  console.log(`Conversation style live evaluation complete against ${CHAT_API_URL}`);
  console.log(`Saved ${results.length} conversations to: ${OUTPUT_DIR}`);
  console.log(`Summary JSON: ${summaryJsonPath}`);
  console.log(`Summary MD: ${summaryMdPath}`);
  console.log(`Average score: ${summary.averageScore}/5`);
  console.log(`Lowest scoring scenarios: ${summary.lowestScoringScenarios.map((item) => `${item.scenarioName} (${item.score}/5)`).join(', ')}`);

  if (summary.averageScore < 4.3) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
