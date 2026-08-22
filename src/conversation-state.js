const normalizeText = (value) => String(value || '')
  .trim()
  .toLocaleLowerCase('sv')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[–—]/g, '-');

const getLastAssistantMessage = (messages = []) => [...(Array.isArray(messages) ? messages : [])]
  .reverse()
  .find((item) => item?.role === 'assistant' && item?.content)?.content || '';

const hasValue = (value) => value !== null && value !== undefined && value !== '';

const isPeopleCountAnswer = (value) => {
  const answer = normalizeText(value);
  const prefix = '(?:(?:vi|jag|we|i)\\s+(?:ar|vill(?:\\s+(?:ha|jamfora))?|behover|ska(?:\\s+ha)?|are|want(?:\\s+to\\s+compare)?|need)\\s+)?';
  const count = '(?:[1-9]|10|ett|en|tva|tre|fyra|fem|sex|sju|atta|nio|tio)';
  const range = '(?:\\+|\\s+eller\\s+fler|\\s+or\\s+more)?';
  const subject = '(?:\\s+(?:personer?|abonnemang|subscriptions?|people))?';
  return new RegExp(`^${prefix}${count}${range}${subject}$`).test(answer);
};

const mergeQualificationState = (current = {}, analyzed = {}) => {
  const merged = { ...current };
  const scalarFields = [
    'peopleCount', 'mobileUsage', 'requiredDataGb', 'priceRange', 'familyPriceRange',
    'streamingCalculation', 'internationalTravel', 'internationalUsage',
    'exactMonthlyPrice', 'customerSegment', 'familyTotalPrice', 'recommendationMode',
  ];
  const arrayFields = [
    'people', 'operators', 'bindingEnds', 'streamingServices', 'exactMonthlyPrices',
  ];

  scalarFields.forEach((field) => {
    if (hasValue(analyzed[field])) merged[field] = analyzed[field];
  });
  arrayFields.forEach((field) => {
    if (Array.isArray(analyzed[field]) && analyzed[field].length) merged[field] = analyzed[field];
  });
  if (analyzed.streamingMonthlyCosts && Object.values(analyzed.streamingMonthlyCosts).some(hasValue)) {
    merged.streamingMonthlyCosts = {
      ...(current.streamingMonthlyCosts || {}),
      ...analyzed.streamingMonthlyCosts,
    };
  }

  merged.operatorAppliesToAll = Boolean(current.operatorAppliesToAll || analyzed.operatorAppliesToAll);
  merged.bindingAppliesToAll = Boolean(current.bindingAppliesToAll || analyzed.bindingAppliesToAll);
  merged.priceAppliesToAll = Boolean(current.priceAppliesToAll || analyzed.priceAppliesToAll);

  if (new Set(merged.operators || []).size > 1) merged.operatorAppliesToAll = false;
  if (new Set(merged.bindingEnds || []).size > 1) merged.bindingAppliesToAll = false;
  return merged;
};

const getFamilyPriceRange = (message) => {
  const text = normalizeText(message).replace(/\s/g, '');
  if (/ingen(grans|prisgrans)|spelaringenroll|vetinte/.test(text)) return 'unknown';
  if (/under1000|<1000/.test(text)) return 'under1000';
  if (/1000-?1500/.test(text)) return '1000-1500';
  if (/1500-?2000/.test(text)) return '1500-2000';
  if (/over2000|över2000|meran2000|merän2000|2000\+/.test(text)) return 'over2000';
  return null;
};

const applyConversationAnswer = ({ message, messages = [], qualification = {} }) => {
  const previousQuestion = normalizeText(getLastAssistantMessage(messages));
  const answer = normalizeText(message);
  const peopleCount = Number(qualification.peopleCount) || 0;
  const next = { ...qualification };
  const statedCount = answer.match(/\b(\d{1,2})\s*(?:abonnemang|subscriptions?)\b/);
  if (statedCount && Number(statedCount[1]) >= 1 && Number(statedCount[1]) <= 10) {
    next.peopleCount = Number(statedCount[1]);
  }
  const groupCount = Number(next.peopleCount) || peopleCount;
  const statedOperator = ['Telia', 'Tele2', 'Telenor', 'Tre']
    .find((operator) => answer.includes(operator.toLocaleLowerCase('sv')));
  if (groupCount > 1 && statedOperator && /(vi alla|alla (?:har|anvander|använder)|samma operator)/.test(answer)) {
    next.operators = Array.from({ length: groupCount }, () => statedOperator);
    next.operatorAppliesToAll = true;
  }
  if (/obegransad|fri surf|unlimited/.test(answer)) next.mobileUsage = 'high';
  const asksAnyBinding = /har (nagon|någon).*bindningstid kvar/.test(previousQuestion);
  const asksAllNoBinding = /har alla.*ingen bindningstid kvar/.test(previousQuestion);
  const explicitNoBinding = /^(nej|ingen|ingen av oss|nej,? ingen av oss|ingen bindningstid)$/.test(answer);
  const confirmsAllNoBinding = asksAllNoBinding && /^(ja|japp|stammer|det stammer)$/.test(answer);

  if (peopleCount > 0 && (explicitNoBinding || confirmsAllNoBinding) && (asksAnyBinding || asksAllNoBinding || /bindningstid/.test(answer))) {
    next.bindingEnds = Array.from({ length: peopleCount }, () => 'Ingen bindningstid');
    next.bindingAppliesToAll = true;
  }

  const familyPriceRange = getFamilyPriceRange(message);
  const asksCurrentFamilyTotal = /(betalar|kostar|pris).*?(tillsammans|totalt|idag)|totala.*?(kostnad|pris)/.test(previousQuestion);
  if (peopleCount > 1 && familyPriceRange && asksCurrentFamilyTotal) {
    next.familyPriceRange = familyPriceRange;
  }
  if (peopleCount > 1 && asksCurrentFamilyTotal && !familyPriceRange && !/-/.test(answer)) {
    const exactTotal = Number(answer.replace(/[^0-9]/g, ''));
    if (exactTotal >= 100 && exactTotal <= 10000) next.familyTotalPrice = exactTotal;
  }

  return next;
};

const makeReply = (label, qualificationPatch = null) => ({
  label,
  ...(qualificationPatch ? { qualificationPatch } : {}),
});

const buildQualificationStep = ({ qualification = {}, message = '', messages = [], language = 'sv' }) => {
  const missing = new Set(qualification.missingFields || []);
  if (!missing.size) return null;
  const english = language === 'en';
  const count = Number(qualification.peopleCount) || 0;
  const latest = normalizeText(message);
  const previousQuestion = normalizeText(getLastAssistantMessage(messages));

  if (missing.has('peopleCount')) {
    return {
      reply: english ? 'How many subscriptions should I compare?' : 'Hur många abonnemang vill du jämföra?',
      quickReplies: [1, 2, 3, 4].map((peopleCount) => makeReply(String(peopleCount), { peopleCount })),
    };
  }

  if (missing.has('operators')) {
    if (count > 1 && qualification.operators.length === 0 && /olika|different/.test(latest)) {
      return {
        reply: english
          ? 'Write the current operator for each person, for example: Person 1 Telia, Person 2 Tele2.'
          : 'Skriv nuvarande operatör för varje person, till exempel: Person 1 Telia, Person 2 Tele2.',
        quickReplies: [],
      };
    }
    if (count > 1 && qualification.operators.length === 0) {
      return {
        reply: english ? 'Do all of you have the same operator today?' : 'Har alla samma operatör idag?',
        quickReplies: ['Telia', 'Tele2', 'Telenor', 'Tre'].map((operator) => makeReply(
          english ? `All have ${operator}` : `Alla har ${operator}`,
          { operators: Array.from({ length: count }, () => operator), operatorAppliesToAll: true }
        )).concat(makeReply(english ? 'Different operators' : 'Olika operatörer')),
      };
    }
    const personNumber = Math.min((qualification.operators?.length || 0) + 1, count);
    return {
      reply: english
        ? `Which operator does person ${personNumber} have today?`
        : `Vilken operatör har person ${personNumber} idag?`,
      quickReplies: ['Telia', 'Tele2', 'Telenor', 'Tre'].map((operator) => makeReply(operator, {
        operators: [...(qualification.operators || []), operator],
        operatorAppliesToAll: false,
      })),
    };
  }

  if (missing.has('bindingEnds')) {
    const answeredYesToAnyBinding = /^(ja|ja,? en eller flera|en eller flera)$/.test(latest)
      && /har (nagon|någon).*bindningstid kvar/.test(previousQuestion);
    if (count > 1 && answeredYesToAnyBinding) {
      return {
        reply: english
          ? 'Write the end date for each person who has binding time left, for example: Person 1 2027-03-31.'
          : 'Skriv slutdatum för varje person som har bindningstid kvar, till exempel: Person 1 2027-03-31.',
        quickReplies: [makeReply(english ? 'We do not know the dates' : 'Vi vet inte datumen', {
          bindingEnds: Array.from({ length: count }, () => 'Vet inte'),
          bindingAppliesToAll: true,
        })],
      };
    }
    if (count > 1) {
      return {
        reply: english ? 'Do any of you have binding time left?' : 'Har någon av er bindningstid kvar?',
        quickReplies: [
          makeReply(english ? 'No, none of us' : 'Nej, ingen av oss', {
            bindingEnds: Array.from({ length: count }, () => 'Ingen bindningstid'),
            bindingAppliesToAll: true,
          }),
          makeReply(english ? 'Yes, one or more' : 'Ja, en eller flera'),
          makeReply(english ? 'We do not know' : 'Vi vet inte', {
            bindingEnds: Array.from({ length: count }, () => 'Vet inte'),
            bindingAppliesToAll: true,
          }),
        ],
      };
    }
    return {
      reply: english ? 'Do you have binding time left?' : 'Har du bindningstid kvar?',
      quickReplies: [
        makeReply(english ? 'No binding time' : 'Ingen bindningstid', {
          bindingEnds: ['Ingen bindningstid'], bindingAppliesToAll: true,
        }),
        makeReply(english ? 'Yes, binding time remains' : 'Ja, bindningstid kvar'),
        makeReply(english ? 'I do not know' : 'Vet inte', {
          bindingEnds: ['Vet inte'], bindingAppliesToAll: true,
        }),
      ],
    };
  }

  if (missing.has('mobileUsage')) {
    return {
      reply: english ? 'How much mobile data do you need?' : 'Hur mycket surf behöver ni?',
      quickReplies: [
        makeReply(english ? 'Mostly Wi-Fi' : 'Mest wifi', { mobileUsage: 'low' }),
        makeReply(english ? 'Normal use' : 'Normal användning', { mobileUsage: 'medium' }),
        makeReply(english ? 'A lot or unlimited' : 'Mycket eller obegränsat', { mobileUsage: 'high' }),
      ],
    };
  }

  if (missing.has('priceRange')) {
    if (count > 1) {
      return {
        reply: english
          ? 'Approximately how much do you pay in total for all subscriptions today?'
          : 'Ungefär vad betalar ni totalt för alla abonnemang idag?',
        quickReplies: [
          makeReply(english ? 'Under SEK 1,000' : 'Under 1 000 kr', { familyPriceRange: 'under1000' }),
          makeReply('1 000–1 500 kr', { familyPriceRange: '1000-1500' }),
          makeReply('1 500–2 000 kr', { familyPriceRange: '1500-2000' }),
          makeReply(english ? 'Over SEK 2,000' : 'Över 2 000 kr', { familyPriceRange: 'over2000' }),
          makeReply(english ? 'Do not know' : 'Vet inte', { familyPriceRange: 'unknown' }),
        ],
      };
    }
    return {
      reply: english ? 'Approximately how much do you pay per month today?' : 'Ungefär vad betalar du per månad idag?',
      quickReplies: [
        makeReply(english ? 'Under SEK 300' : 'Under 300 kr', { priceRange: 'under300' }),
        makeReply('300–400 kr', { priceRange: '300-400' }),
        makeReply('400–500 kr', { priceRange: '400-500' }),
        makeReply(english ? 'Over SEK 500' : 'Över 500 kr', { priceRange: 'no_limit' }),
        makeReply(english ? 'Do not know' : 'Vet inte', { priceRange: 'no_limit' }),
      ],
    };
  }

  return null;
};

const isQualificationPrompt = (messages = []) => /hur manga abonnemang|how many subscriptions|operator|operatör|bindningstid|binding time|end date|slutdatum|hur mycket surf|mobile data|data do you need|betalar.*(?:idag|manad)|kostar.*(?:totalt|idag)|pay.*(?:today|month|total)/
  .test(normalizeText(getLastAssistantMessage(messages)));

const isQualificationContinuation = (messages = [], message = '') => {
  const previousQuestion = normalizeText(getLastAssistantMessage(messages));
  const answer = normalizeText(message);
  if (!previousQuestion || !answer) return false;

  if (/hur manga abonnemang|how many subscriptions/.test(previousQuestion)) {
    return isPeopleCountAnswer(answer);
  }
  if (/operator|operatör/.test(previousQuestion)) {
    return /\b(telia|tele2|telenor|tre|samma|olika|same|different)\b/.test(answer);
  }
  if (/bindningstid|binding time|end date|slutdatum/.test(previousQuestion)) {
    return /^(ja|nej|yes|no|ingen|vet inte|i do not know|don't know)\b|\b\d{4}-\d{2}-\d{2}\b/.test(answer);
  }
  if (/hur mycket surf|mobile data|data do you need/.test(previousQuestion)) {
    return /\b(wifi|normal|mycket|obegransat|obegränsat|unlimited|\d+\s*gb)\b/.test(answer);
  }
  if (/betalar.*(?:idag|manad)|kostar.*(?:totalt|idag)|pay.*(?:today|month|total)/.test(previousQuestion)) {
    return /\d|under|over|över|vet inte|do not know|don't know/.test(answer);
  }
  return false;
};

module.exports = {
  applyConversationAnswer,
  buildQualificationStep,
  getFamilyPriceRange,
  getLastAssistantMessage,
  isQualificationContinuation,
  isQualificationPrompt,
  mergeQualificationState,
};
