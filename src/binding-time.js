const STOCKHOLM_TIME_ZONE = 'Europe/Stockholm';
const MAX_BINDING_MONTHS = 120;

const SWEDISH_MONTH_WORDS = {
  en: 1,
  ett: 1,
  tva: 2,
  två: 2,
  tre: 3,
  fyra: 4,
  fem: 5,
  sex: 6,
  sju: 7,
  atta: 8,
  åtta: 8,
  nio: 9,
  tio: 10,
  elva: 11,
  tolv: 12,
};

const getStockholmDate = (now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: STOCKHOLM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const isValidIsoDate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
};

const addCalendarMonths = (isoDate, months) => {
  if (!isValidIsoDate(isoDate)) return null;
  const [year, month, day] = isoDate.split('-').map(Number);
  const targetMonthIndex = year * 12 + month - 1 + months;
  const targetYear = Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return [
    String(targetYear).padStart(4, '0'),
    String(targetMonth + 1).padStart(2, '0'),
    String(Math.min(day, lastDay)).padStart(2, '0'),
  ].join('-');
};

const calculateBindingEndDate = (monthsRemaining, now = new Date()) => {
  const months = Number(monthsRemaining);
  if (!Number.isInteger(months) || months < 0 || months > MAX_BINDING_MONTHS) return null;
  return addCalendarMonths(getStockholmDate(now), months);
};

const isStreamingOnlyBindingMessage = (message) => {
  const text = String(message || '').toLocaleLowerCase('sv');
  const mentionsStreaming = /streamingtj[aä]nst|streaming|netflix|hbo|max\b|disney|amazon\s*prime|tv4\s*play/i.test(text);
  const mentionsMobile = /mobilabonnemang|mobilavtal|mobiloperat[oö]r|\b(?:telia|tele2|telenor|tre|comviq|hallon|vimla|fello)\b/i.test(text);
  return mentionsStreaming && !mentionsMobile;
};

const parseMonthsRemaining = (message, { allowBareNumber = false } = {}) => {
  const text = String(message || '').trim().toLocaleLowerCase('sv');
  if (!text) return null;

  const numericMonths = /\b(\d{1,3})\s*(?:m[aå]n(?:ad(?:er)?)?|months?)\b/i.exec(text);
  if (numericMonths) {
    const months = Number(numericMonths[1]);
    return months <= MAX_BINDING_MONTHS ? months : null;
  }

  const wordMonths = new RegExp(`\\b(${Object.keys(SWEDISH_MONTH_WORDS).join('|')})\\s+m[aå]n(?:ad(?:er)?)?\\b`, 'i').exec(text);
  if (wordMonths) return SWEDISH_MONTH_WORDS[wordMonths[1].toLocaleLowerCase('sv')];

  const numericYears = /\b(\d{1,2})\s*(?:[aå]r|years?)\b/i.exec(text);
  if (numericYears) {
    const months = Number(numericYears[1]) * 12;
    return months <= MAX_BINDING_MONTHS ? months : null;
  }
  if (/\b(?:ett\s+)?halv[aå]r\b/i.test(text)) return 6;

  const bareNumber = allowBareNumber ? /^(\d{1,3})$/.exec(text) : null;
  return bareNumber && Number(bareNumber[1]) <= MAX_BINDING_MONTHS
    ? Number(bareNumber[1])
    : null;
};

const getExplicitIsoDate = (message) => {
  const date = String(message || '').match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] || null;
  return isValidIsoDate(date) ? date : null;
};

const isAffirmative = (message) => /^(?:ja|japp|yes|yep|st[aä]mmer|det st[aä]mmer|korrekt|precis)(?:[.!\s,]|$)/i
  .test(String(message || '').trim());
const isNegative = (message) => /^(?:nej|no|nope|st[aä]mmer inte|det st[aä]mmer inte|fel)(?:[.!\s,]|$)/i
  .test(String(message || '').trim());
const isUnknown = (message) => /\b(?:vet inte|os[aä]ker|ingen aning|don'?t know|not sure)\b/i
  .test(String(message || ''));
const isNoBinding = (message) => /\b(?:ingen|utan|saknar|har inte)\s+(?:bindningstid|bindning)|(?:no|without)\s+(?:binding|contract|commitment)\b/i
  .test(String(message || ''));
const mentionsBinding = (message) => /bindningstid|bindning|bunden|avtalstid|upps[aä]gning|contract|commitment|locked\s*in/i
  .test(String(message || ''));
const appliesToAll = (message) => /\b(?:alla|samtliga|b[aå]da|everyone|all of us|both)\b/i
  .test(String(message || ''));

const clearPersonBinding = (people, targetIndex, clearAll) => Array.isArray(people)
  ? people.map((person, index) => (
    clearAll || index === targetIndex ? { ...person, bindingEnd: null } : person
  ))
  : [];

const replaceBindingValue = (qualification, value, { targetIndex = 0, applyToAll = false } = {}) => {
  const count = Math.max(Number(qualification.peopleCount) || 1, 1);
  if (count === 1 || applyToAll) {
    return {
      ...qualification,
      bindingEnds: Array.from({ length: count }, () => value),
      people: Array.isArray(qualification.people)
        ? qualification.people.map((person) => ({ ...person, bindingEnd: value }))
        : qualification.people,
      bindingAppliesToAll: count > 1 && applyToAll,
    };
  }

  const bindingEnds = [...(qualification.bindingEnds || [])];
  bindingEnds[targetIndex] = value;
  return {
    ...qualification,
    bindingEnds,
    people: Array.isArray(qualification.people)
      ? qualification.people.map((person, index) => (
        index === targetIndex ? { ...person, bindingEnd: value } : person
      ))
      : qualification.people,
    bindingAppliesToAll: false,
  };
};

const clearBindingValue = (qualification, { targetIndex = 0, applyToAll = false } = {}) => {
  const count = Math.max(Number(qualification.peopleCount) || 1, 1);
  const clearAll = count === 1 || applyToAll;
  const bindingEnds = clearAll
    ? []
    : (qualification.bindingEnds || []).filter((_, index) => index !== targetIndex);
  return {
    ...qualification,
    bindingEnds,
    people: clearPersonBinding(qualification.people, targetIndex, clearAll),
    bindingAppliesToAll: false,
  };
};

const resetBindingQuestionState = (flowState, pendingBindingEnd) => {
  const attempts = { ...(flowState.attempts || {}) };
  delete attempts.bindingEnds;
  return {
    ...flowState,
    inProgress: true,
    activeQuestionField: null,
    blockedQuestionField: flowState.blockedQuestionField === 'bindingEnds'
      ? null
      : flowState.blockedQuestionField,
    attempts,
    deferredFields: (flowState.deferredFields || []).filter((field) => field !== 'bindingEnds'),
    pendingBindingEnd,
  };
};

const applyBindingTimeInput = ({
  qualification = {},
  flowState = {},
  message = '',
  now = new Date(),
} = {}) => {
  const pending = flowState.pendingBindingEnd || null;
  const activeBindingQuestion = flowState.activeQuestionField === 'bindingEnds';
  const monthsRemaining = parseMonthsRemaining(message, {
    allowBareNumber: activeBindingQuestion || Boolean(pending),
  });
  const explicitDate = getExplicitIsoDate(message);
  const statesRemainingDuration = monthsRemaining !== null && /\b(?:kvar|remaining|left)\b/i.test(message);
  const statesDateCorrection = explicitDate && /(?:ska vara|ist[aä]llet|[aä]ndra|r[aä]tta|fel|actually|change|correct)/i
    .test(message);
  const replacesKnownDate = explicitDate &&
    Array.isArray(qualification.bindingEnds) &&
    qualification.bindingEnds.length > 0 &&
    String(message || '').trim() === explicitDate;
  const bindingContext = activeBindingQuestion || pending || mentionsBinding(message) ||
    statesRemainingDuration || statesDateCorrection || replacesKnownDate;
  if (!bindingContext || isStreamingOnlyBindingMessage(message)) {
    return { qualification, flowState };
  }

  const applyToAll = appliesToAll(message);
  const count = Math.max(Number(qualification.peopleCount) || 1, 1);
  const targetIndex = pending?.targetIndex ?? Math.min(
    Array.isArray(qualification.bindingEnds) ? qualification.bindingEnds.length : 0,
    count - 1
  );

  if (monthsRemaining !== null) {
    if (monthsRemaining === 0) {
      return {
        qualification: replaceBindingValue(qualification, 'Ingen bindningstid', { targetIndex, applyToAll }),
        flowState: { ...flowState, pendingBindingEnd: null },
      };
    }
    const date = calculateBindingEndDate(monthsRemaining, now);
    return {
      qualification,
      flowState: resetBindingQuestionState(flowState, {
        date,
        monthsRemaining,
        targetIndex,
        appliesToAll: applyToAll,
      }),
    };
  }

  if (explicitDate) {
    return {
      qualification: replaceBindingValue(qualification, explicitDate, { targetIndex, applyToAll }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  if (isUnknown(message)) {
    return {
      qualification: clearBindingValue(qualification, { targetIndex, applyToAll }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  if (isNoBinding(message)) {
    return {
      qualification: replaceBindingValue(qualification, 'Ingen bindningstid', { targetIndex, applyToAll }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  if (!pending && activeBindingQuestion && isNegative(message)) {
    return {
      qualification: replaceBindingValue(qualification, 'Ingen bindningstid', { targetIndex, applyToAll }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  if (pending && isNegative(message)) {
    return {
      qualification: clearBindingValue(qualification, {
        targetIndex: pending.targetIndex,
        applyToAll: pending.appliesToAll,
      }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  if (pending && isAffirmative(message)) {
    return {
      qualification: replaceBindingValue(qualification, pending.date, {
        targetIndex: pending.targetIndex,
        applyToAll: pending.appliesToAll,
      }),
      flowState: { ...flowState, pendingBindingEnd: null },
    };
  }

  return { qualification, flowState };
};

module.exports = {
  addCalendarMonths,
  applyBindingTimeInput,
  calculateBindingEndDate,
  getStockholmDate,
  isStreamingOnlyBindingMessage,
  parseMonthsRemaining,
  isValidIsoDate,
};
