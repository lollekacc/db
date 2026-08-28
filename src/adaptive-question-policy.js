const { isStreamingOnlyBindingMessage, isValidIsoDate } = require('./binding-time');

const QUESTION_DEFINITIONS = {
  peopleCount: {
    focus: 'number_of_subscriptions',
    guidance: 'Ask for the exact number of people or mobile subscriptions. The interface provides every exact-number quick reply from 1 through 10; never use ranges such as "3 or more".',
  },
  priceRange: {
    focus: 'current_monthly_price',
    guidance: 'Ask what the customer currently pays per person each month; prefer an exact amount.',
  },
  mobileUsage: {
    focus: 'mobile_data_usage',
    guidance: 'Ask about normal mobile-data usage or an approximate number of GB.',
  },
  internationalTravel: {
    focus: 'travel_region',
    guidance: 'Ask neutrally whether travel needs to be considered at all. Do not imply that the customer travels. In Swedish, use "Behöver vi ta hänsyn till resor i jämförelsen?" or an equally neutral equivalent. Offer three clear choices: no travel to consider, mainly within the EU/EEA, or also outside the EU/EEA.',
  },
  internationalUsage: {
    focus: 'outside_eu_usage',
    guidance: 'Ask whether the customer needs only mobile data outside the EU/EEA, or both local calls and mobile data. Use those two concrete choices; do not ask which one matters most.',
  },
  streamingCalculation: {
    focus: 'paid_streaming',
    guidance: 'Ask which of Netflix, HBO Max, and Disney+ the customer currently pays for. Do not reduce this to a yes/no question because the interface will collect each selected service and its monthly price.',
  },
  streamingServices: {
    focus: 'streaming_services',
    guidance: 'Ask which of Netflix, HBO Max, and Disney+ the customer currently pays for. The interface will collect each selected service and its monthly price.',
  },
  streamingPrices: {
    focus: 'streaming_monthly_prices',
    guidance: 'Ask only for the monthly prices that are still missing for the selected streaming services. Name the services with missing prices and let the customer answer in the normal chat input. Do not show quick replies.',
  },
  operators: {
    focus: 'current_operator',
    guidance: 'Ask which operator the customer currently uses. Only present Dealett operators: Telia, Tele2, Telenor, Tre, plus "Annan". Do not list other market operators.',
  },
  bindingEnds: {
    focus: 'binding_status',
    guidance: 'Ask only about binding time on the customer\'s current mobile subscription. Explicitly say "mobile subscription" so this can never be mistaken for Netflix, HBO Max, Disney+, or another streaming service. Frame it as determining when a switch can happen, not which plan best fits. Accept a date, months remaining, no binding time, or that the customer does not know.',
  },
  people: {
    focus: 'person_details',
    guidance: 'Ask for the one missing per-person detail that is needed to complete the comparison.',
  },
};

const CANONICAL_QUESTION_ORDER = [
  'peopleCount',
  'operators',
  'bindingEnds',
  'priceRange',
  'mobileUsage',
  'streamingCalculation',
  'streamingServices',
  'streamingPrices',
  'internationalTravel',
  'internationalUsage',
  'people',
];
const MAX_QUESTION_ATTEMPTS = 3;

const RELEVANCE_RULES = [
  {
    fields: ['streamingCalculation', 'streamingServices', 'streamingPrices'],
    pattern: /streamingtj[aä]nst|netflix|hbo|max\b|disney|amazon\s*prime|tv4\s*play|paid streaming/i,
  },
  {
    fields: ['internationalTravel', 'internationalUsage'],
    pattern: /\bres(?:a|er|or|ande)?\b|utomlands|utanf[oö]r\s*(?:eu|ees)|inom\s*(?:eu|ees)|roaming|abroad|travel|outside\s*(?:the\s*)?eu|eu\/?eea/i,
  },
  {
    fields: ['priceRange'],
    pattern: /f[oö]r\s*(?:dyrt|mycket)|dyrt?|kostar|kostnad|pris|betalar|m[aå]nad|faktura|too\s*much|expensive|cost|price|pay|bill/i,
  },
  {
    fields: ['mobileUsage'],
    pattern: /\bsurf(?:ar|m[aä]ngd)?\b|\bdata(?:m[aä]ngd)?\b|\bgb\b|mobildata|internet usage/i,
  },
  {
    fields: ['bindingEnds'],
    pattern: /bindningstid|bunden|avtalstid|upps[aä]gning|contract|commitment|locked\s*in/i,
  },
  {
    fields: ['peopleCount'],
    pattern: /familj|personer|abonnemang(?:en)?|familjeabonnemang|family|people|lines?/i,
  },
  {
    fields: ['operators'],
    pattern: /operat[oö]r|telia|tele2|telenor|\btre\b|comviq|hallon|vimla|fello|provider|carrier/i,
  },
];

const unique = (items) => [...new Set(items)];

const normalizeQuestionFlowState = (flowState = {}) => {
  const source = flowState && typeof flowState === 'object' && !Array.isArray(flowState)
    ? flowState
    : {};
  const activeQuestionField = QUESTION_DEFINITIONS[source.activeQuestionField]
    ? source.activeQuestionField
    : null;
  const blockedQuestionField = QUESTION_DEFINITIONS[source.blockedQuestionField]
    ? source.blockedQuestionField
    : null;
  const attempts = source.attempts && typeof source.attempts === 'object' && !Array.isArray(source.attempts)
    ? Object.entries(source.attempts).reduce((result, [field, value]) => {
      if (!QUESTION_DEFINITIONS[field]) return result;
      const count = Number(value);
      if (Number.isFinite(count) && count > 0) {
        result[field] = Math.min(Math.round(count), MAX_QUESTION_ATTEMPTS);
      }
      return result;
    }, {})
    : {};
  const deferredFields = Array.isArray(source.deferredFields)
    ? unique(source.deferredFields.filter((field) => QUESTION_DEFINITIONS[field]))
    : [];
  const pendingSource = source.pendingBindingEnd && typeof source.pendingBindingEnd === 'object'
    ? source.pendingBindingEnd
    : null;
  const pendingBindingEnd = pendingSource &&
    isValidIsoDate(pendingSource.date) &&
    Number.isInteger(Number(pendingSource.monthsRemaining)) &&
    Number(pendingSource.monthsRemaining) >= 0 &&
    Number(pendingSource.monthsRemaining) <= 120
    ? {
      date: pendingSource.date,
      monthsRemaining: Number(pendingSource.monthsRemaining),
      targetIndex: Math.max(0, Math.min(Number(pendingSource.targetIndex) || 0, 9)),
      appliesToAll: pendingSource.appliesToAll === true,
    }
    : null;

  return {
    version: 1,
    inProgress: source.inProgress === true,
    activeQuestionField,
    blockedQuestionField,
    attempts,
    deferredFields,
    pendingBindingEnd,
  };
};

const getAdaptiveQuestionPlan = ({
  message = '',
  analysis = {},
  qualification = {},
  flowState = {},
} = {}) => {
  const missingFields = Array.isArray(qualification.missingFields)
    ? qualification.missingFields.filter((field) => QUESTION_DEFINITIONS[field])
    : [];
  const currentFlow = normalizeQuestionFlowState(flowState);
  const pendingBindingEnd = currentFlow.pendingBindingEnd;
  const explicitlyClosed = analysis.interactionStage === 'close';
  const shouldContinue = !explicitlyClosed && (
    analysis.recommendationRequested === true || currentFlow.inProgress
  );
  if ((!shouldContinue && !pendingBindingEnd) || (!missingFields.length && !pendingBindingEnd)) return null;

  const contextText = [message, analysis.topic, analysis.desiredOutcome]
    .filter(Boolean)
    .join(' ');
  const relevantFields = analysis.recommendationRequested === true
    ? RELEVANCE_RULES
      .filter((rule) => rule.pattern.test(contextText))
      .flatMap((rule) => rule.fields)
      .filter((field) => field !== 'bindingEnds' || !isStreamingOnlyBindingMessage(contextText))
    : [];
  const relevantMissingFields = unique(relevantFields).filter((field) => missingFields.includes(field));
  if (
    currentFlow.blockedQuestionField &&
    (missingFields.includes(currentFlow.blockedQuestionField) ||
      currentFlow.blockedQuestionField === 'bindingEnds' && pendingBindingEnd) &&
    !relevantMissingFields.length
  ) {
    return null;
  }
  const activeQuestionField = missingFields.includes(currentFlow.activeQuestionField)
    ? currentFlow.activeQuestionField
    : null;
  const deferredFields = currentFlow.deferredFields.filter((field) => missingFields.includes(field));
  const jumpField = relevantMissingFields.find((field) => (
    field !== activeQuestionField && missingFields.includes(field)
  ));
  const resumableActiveField = activeQuestionField && !deferredFields.includes(activeQuestionField)
    ? activeQuestionField
    : null;
  const orderedField = CANONICAL_QUESTION_ORDER.find((field) => (
    missingFields.includes(field) && !deferredFields.includes(field)
  ));
  const fallbackField = CANONICAL_QUESTION_ORDER.find((field) => missingFields.includes(field)) || missingFields[0];
  const qualificationField = pendingBindingEnd
    ? 'bindingEnds'
    : (jumpField || resumableActiveField || orderedField || fallbackField);
  if (!qualificationField) return null;

  const selectionReason = pendingBindingEnd
    ? 'binding_date_confirmation'
    : (jumpField
    ? 'customer_jump'
    : (resumableActiveField ? 'resume_active' : 'canonical_order'));
  const previousAttempts = Number(currentFlow.attempts[qualificationField]) || 0;
  const attemptNumber = Math.min(
    currentFlow.activeQuestionField === qualificationField ? previousAttempts + 1 : 1,
    MAX_QUESTION_ATTEMPTS
  );
  const retryGuidance = attemptNumber === 2
    ? ' Rephrase the question clearly instead of repeating the previous wording.'
    : (attemptNumber >= MAX_QUESTION_ATTEMPTS
      ? ' Do not repeat the question verbatim. Briefly explain why this answer is needed. If the customer cannot provide it, say that an exact recommendation must wait and allow the conversation to continue with another unanswered topic.'
      : '');

  const missingStreamingPrices = qualificationField === 'streamingPrices'
    ? (qualification.streamingServices || []).filter((service) => (
      !Number(qualification.streamingMonthlyCosts?.[service])
    ))
    : [];
  const combinesOperatorAndBinding = qualificationField === 'operators' &&
    missingFields.includes('bindingEnds');
  const questionDefinition = combinesOperatorAndBinding
    ? {
      focus: 'current_operator_and_binding',
      guidance: 'Ask one combined question, matching the quiz: which mobile operator the customer currently has and when that same mobile subscription\'s binding time ends. Only present Dealett operators: Telia, Tele2, Telenor, Tre, plus "Annan". Do not list other market operators. For multiple people, ask for both facts per person. Accept an exact date, months remaining, no binding time, or that the customer does not know. Make both requested answers clear, but keep them in one question.',
    }
    : QUESTION_DEFINITIONS[qualificationField];
  const questionGuidance = pendingBindingEnd
    ? `Confirm the calculated end date ${pendingBindingEnd.date} for the customer's current mobile subscription. It was calculated from ${pendingBindingEnd.monthsRemaining} months remaining. Ask whether the mobile subscription's binding time ends on that exact date; do not request a different date unless the customer rejects it.`
    : questionDefinition.guidance;

  return {
    qualificationField,
    ...questionDefinition,
    guidance: `${questionGuidance}${retryGuidance}`,
    unresolvedFields: pendingBindingEnd && !missingFields.includes('bindingEnds')
      ? [...missingFields, 'bindingEnds']
      : missingFields,
    missingStreamingPrices,
    combinedQualificationFields: combinesOperatorAndBinding
      ? ['operators', 'bindingEnds']
      : [],
    pendingBindingEnd: qualificationField === 'bindingEnds' ? pendingBindingEnd : null,
    selectionReason,
    attemptNumber,
    resumedAfterTangent: analysis.recommendationRequested !== true && currentFlow.inProgress,
  };
};

const buildNextQuestionFlowState = ({
  previousFlowState = {},
  adaptiveQuestionPlan = null,
  qualification = {},
} = {}) => {
  const previous = normalizeQuestionFlowState(previousFlowState);
  const missingFields = Array.isArray(qualification.missingFields)
    ? qualification.missingFields.filter((field) => QUESTION_DEFINITIONS[field])
    : [];
  if (previous.pendingBindingEnd && !missingFields.includes('bindingEnds')) {
    missingFields.push('bindingEnds');
  }
  const qualificationField = adaptiveQuestionPlan?.qualificationField;
  if (!qualificationField || !missingFields.length) {
    if (previous.blockedQuestionField && missingFields.includes(previous.blockedQuestionField)) {
      return normalizeQuestionFlowState({
        ...previous,
        inProgress: false,
        activeQuestionField: null,
      });
    }
    return normalizeQuestionFlowState({});
  }

  const attempts = {
    ...Object.fromEntries(Object.entries(previous.attempts).filter(([field]) => missingFields.includes(field))),
    [qualificationField]: Math.min(
      Number(adaptiveQuestionPlan.attemptNumber) || 1,
      MAX_QUESTION_ATTEMPTS
    ),
  };
  const deferredFields = previous.deferredFields.filter((field) => missingFields.includes(field));
  if (attempts[qualificationField] >= MAX_QUESTION_ATTEMPTS && missingFields.length > 1) {
    deferredFields.push(qualificationField);
  }
  const blockedQuestionField = attempts[qualificationField] >= MAX_QUESTION_ATTEMPTS &&
    missingFields.length === 1
    ? qualificationField
    : null;

  return normalizeQuestionFlowState({
    inProgress: !blockedQuestionField,
    activeQuestionField: blockedQuestionField ? null : qualificationField,
    blockedQuestionField,
    attempts,
    deferredFields,
    pendingBindingEnd: previous.pendingBindingEnd,
  });
};

module.exports = {
  CANONICAL_QUESTION_ORDER,
  buildNextQuestionFlowState,
  getAdaptiveQuestionPlan,
  normalizeQuestionFlowState,
};
