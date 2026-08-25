const QUESTION_DEFINITIONS = {
  peopleCount: {
    focus: 'number_of_subscriptions',
    guidance: 'Ask for the exact number of people or mobile subscriptions. Use only exact-number quick replies such as 1, 2, and 3; never use ranges such as "3 or more".',
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
    guidance: 'Ask whether the customer travels mainly within the EU/EEA, outside the EU/EEA, or not at all.',
  },
  internationalUsage: {
    focus: 'outside_eu_usage',
    guidance: 'Ask whether data or calls matter most when the customer is outside the EU/EEA.',
  },
  streamingCalculation: {
    focus: 'paid_streaming',
    guidance: 'Ask whether the customer currently pays for streaming services.',
  },
  streamingServices: {
    focus: 'streaming_services',
    guidance: 'Ask which streaming services the customer currently pays for.',
  },
  operators: {
    focus: 'current_operator',
    guidance: 'Ask which operator the customer currently uses.',
  },
  bindingEnds: {
    focus: 'binding_status',
    guidance: 'Ask about binding time only now; frame it as determining when a switch can happen, not which plan best fits.',
  },
  people: {
    focus: 'person_details',
    guidance: 'Ask for the one missing per-person detail that is needed to complete the comparison.',
  },
};

const DEFAULT_PRIORITY = [
  'peopleCount',
  'priceRange',
  'mobileUsage',
  'internationalTravel',
  'streamingCalculation',
  'streamingServices',
  'operators',
  'bindingEnds',
  'internationalUsage',
  'people',
];

const RELEVANCE_RULES = [
  {
    fields: ['streamingCalculation', 'streamingServices'],
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

const getAdaptiveQuestionPlan = ({ message = '', analysis = {}, qualification = {} } = {}) => {
  const missingFields = Array.isArray(qualification.missingFields)
    ? qualification.missingFields.filter((field) => QUESTION_DEFINITIONS[field])
    : [];
  if (!analysis.recommendationRequested || !missingFields.length) return null;

  const contextText = [message, analysis.topic, analysis.desiredOutcome]
    .filter(Boolean)
    .join(' ');
  const relevantFields = RELEVANCE_RULES
    .filter((rule) => rule.pattern.test(contextText))
    .flatMap((rule) => rule.fields);
  const orderedFields = unique([...relevantFields, ...DEFAULT_PRIORITY, ...missingFields]);
  const qualificationField = orderedFields.find((field) => missingFields.includes(field));
  if (!qualificationField) return null;

  return {
    qualificationField,
    ...QUESTION_DEFINITIONS[qualificationField],
    unresolvedFields: missingFields,
  };
};

module.exports = {
  getAdaptiveQuestionPlan,
};
