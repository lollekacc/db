const STYLE_POLICIES = {
  advisor: {
    answerFirst: false,
    maxQuestions: 2,
    allowReasonableGuess: false,
    requireDisclaimer: false,
    preserveSalesFlow: true,
  },
  direct_answer: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  impatient: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  skeptical: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: false,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  browsing: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: false,
    requireDisclaimer: false,
    preserveSalesFlow: false,
  },
  confused: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: false,
    preserveSalesFlow: false,
  },
  comparison: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  complaint_or_problem: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  reward_focused: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: false,
    requireDisclaimer: true,
    preserveSalesFlow: true,
  },
  human_test: {
    answerFirst: true,
    maxQuestions: 1,
    allowReasonableGuess: true,
    requireDisclaimer: true,
    preserveSalesFlow: false,
  },
};

const STYLE_ORDER = [
  'skeptical',
  'reward_focused',
  'complaint_or_problem',
  'comparison',
  'direct_answer',
  'impatient',
  'browsing',
  'confused',
  'human_test',
  'advisor',
];

const STYLE_PATTERNS = {
  advisor: [
    /hjälp.*(jämföra|hitta|välja)|hjalp.*(jamfora|hitta|valja)/i,
    /vad passar mig|bästa abonnemanget för familjen|basta abonnemanget for familjen/i,
    /kan du hjälpa mig|kan du hjalpa mig|what suits me|help me compare/i,
  ],
  direct_answer: [
    /välj.*(abonnemang|något|nåt|plan|bredband|mobil)|valj.*(abonnemang|nagot|nat|plan|bredband|mobil)/i,
    /säg vad jag ska ta|sag vad jag ska ta|ge mig bara ett svar/i,
    /om du var jag|utan att fråga|utan fragor|without asking/i,
    /välj något åt mig|valj nagot at mig|pick.*for me/i,
  ],
  impatient: [
    /orkar inte.*frågor|orkar inte.*fragor|ställ inte.*frågor|stall inte.*fragor/i,
    /kort svar|snabbt|bara säg|bara sag|don't ask|dont ask/i,
  ],
  skeptical: [
    /får ni betalt|far ni betalt|oberoende|partisk|lita på|lita pa/i,
    /vill bara sälja|vill bara salja|är detta reklam|ar detta reklam|biased|can i trust|do i trust|trust you|trusted|are you paid|get paid|paid by/i,
    /bara.*sälj|bara.*salj|så ni kan sälja|sa ni kan salja|reklam.*sälj|reklam.*salj/i,
  ],
  browsing: [
    /såg.*reklam|sag.*reklam|reklam|tänkte bara kika|tankte bara kika/i,
    /kikar runt|tittar runt|vad är detta|vad ar detta|vad gör ni|vad gor ni/i,
  ],
  confused: [
    /^(ria|rea|n+ä+|n+a+|nä+|nej+|vet inte|ingen aning)$/i,
    /fattar inte|förstår inte|forstar inte|oklart|confused/i,
  ],
  comparison: [
    /jämför|jamfor|vilken operatör|vilken operator|bäst täckning|bast tackning/i,
    /\b(telia|tele2|telenor|tre)\s+eller\s+(telia|tele2|telenor|tre)\b/i,
    /vad är billigast|vad ar billigast|cheapest|compare/i,
  ],
  complaint_or_problem: [
    /suger|dålig täckning|dalig tackning|laggar|funkar inte/i,
    /betalar för mycket|betalar for mycket|för dyrt|for dyrt|faktura.*konstig/i,
  ],
  reward_focused: [
    /högsta presentkort|hogsta presentkort|mest bonus|största belöning|storsta beloning/i,
    /presentkort.*bara|bonus.*bara|gift card|reward/i,
  ],
  human_test: [
    /sälj något till mig|salj nagot till mig|överraska mig|overraska mig/i,
    /du får bestämma|du far bestamma|gissa|imponera på mig|imponera pa mig/i,
  ],
};

const normalizeHistory = (history = []) => (
  Array.isArray(history)
    ? history
      .slice(-8)
      .map((item) => String(item?.content || item || '').toLowerCase())
      .filter(Boolean)
    : []
);

const getStyleGuidance = (style = 'advisor') => {
  const normalizedStyle = STYLE_POLICIES[style] ? style : 'advisor';
  return {
    style: normalizedStyle,
    responsePolicy: { ...STYLE_POLICIES[normalizedStyle] },
  };
};

const scoreStyle = (style, text) => {
  const patterns = STYLE_PATTERNS[style] || [];
  const matches = patterns
    .map((pattern) => pattern.test(text))
    .filter(Boolean).length;
  if (!matches) return null;
  return {
    style,
    score: Math.min(0.55 + matches * 0.2, 0.95),
    reasons: patterns
      .filter((pattern) => pattern.test(text))
      .map((pattern) => pattern.source),
  };
};

const detectConversationStyle = ({ message, history = [], context = {} } = {}) => {
  const text = String(message || '').trim().toLowerCase();
  const recentHistory = normalizeHistory(history).join(' ');
  const candidates = STYLE_ORDER
    .map((style) => scoreStyle(style, text))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return STYLE_ORDER.indexOf(left.style) - STYLE_ORDER.indexOf(right.style);
    });

  const previousStyle = context?.conversationStyle?.style || context?.style || null;
  const lowInformation = /^(ok|okej|ja|nej|nä|nää|näää|vet inte|ingen aning|kanske)$/i.test(text);
  const previousCanPersist = previousStyle && ['direct_answer', 'impatient', 'skeptical', 'browsing', 'confused', 'comparison', 'complaint_or_problem', 'reward_focused', 'human_test'].includes(previousStyle);

  if (lowInformation && previousCanPersist) {
    const guidance = getStyleGuidance(previousStyle);
    return {
      style: previousStyle,
      confidence: 0.55,
      reasons: ['preserved_previous_style_for_low_information_reply'],
      responsePolicy: guidance.responsePolicy,
    };
  }

  if (!candidates.length && /jämför|jamfor|abonnemang|mobil|bredband|täckning|tackning|operatör|operator|pris|billig|familj/.test(recentHistory)) {
    const guidance = getStyleGuidance('advisor');
    return {
      style: 'advisor',
      confidence: 0.45,
      reasons: ['telecom_context_without_specific_style'],
      responsePolicy: guidance.responsePolicy,
    };
  }

  const selected = candidates[0] || { style: 'advisor', score: 0.35, reasons: ['default_advisor'] };
  const guidance = getStyleGuidance(selected.style);

  return {
    style: selected.style,
    confidence: Math.round(selected.score * 100) / 100,
    reasons: selected.reasons,
    responsePolicy: guidance.responsePolicy,
  };
};

module.exports = {
  detectConversationStyle,
  getStyleGuidance,
  STYLE_POLICIES,
};
