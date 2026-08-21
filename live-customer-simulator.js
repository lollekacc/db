#!/usr/bin/env node

const DEFAULT_CHAT_API_URL = 'http://localhost:3000/api/chat';
const CHAT_API_URL = process.env.CHAT_API_URL || DEFAULT_CHAT_API_URL;

const timestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);

const escapeMarkdown = (value) => String(value ?? '').replace(/\|/g, '\\|');

const extractMoneyAmounts = (text) => {
  const amounts = [];
  const source = String(text || '');
  for (const match of source.matchAll(/\b(\d{2,5})(?:[.,]\d{1,2})?\s*(?:kr|sek|kronor)\b/gi)) {
    amounts.push(Number(match[1]));
  }
  return amounts;
};

const extractClaimedMoneyAmounts = (text) => {
  const source = String(text || '');
  const amounts = extractMoneyAmounts(source);
  if (/betalar|kostar|pris|totalt|sammanlagt|tillsammans|total|combined/i.test(source)) {
    for (const match of source.matchAll(/\b(\d{2,5})\b/g)) {
      amounts.push(Number(match[1]));
    }
  }
  return uniqueNumbers(amounts);
};

const uniqueNumbers = (values) => [...new Set(values.filter((value) => Number.isFinite(value)))];

const scenarios = [
  {
    name: 'A Suspicious unrealistic price',
    language: 'sv',
    profile: [
      'Customer claims 99 kr/month for unlimited data at Telia.',
      'Customer resists clarification.',
      'Bot should not accuse and should not blindly recommend expensive offers.',
    ],
    expectations: {
      shouldAskExceptionalPriceClarification: true,
      shouldSayStrongOrUnusual: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag betalar 99 kr för obegränsat hos telia',
      'nej det är mitt vanliga pris',
      'kan du slå det eller inte?',
    ],
  },
  {
    name: 'B Strong family bundle',
    language: 'sv',
    profile: [
      '5 people on Tele2 family.',
      'Customer thinks total cost is about 899 kr.',
      'Bot should roughly understand per-person price and avoid forcing a switch.',
    ],
    expectations: {
      shouldMentionPerPersonOrStrongDeal: true,
      shouldAskDataAndBinding: true,
      shouldNotForceSwitch: true,
    },
    turns: [
      'vi är 5 personer och har tele2 familj',
      'tror vi betalar typ 899 totalt',
      'kan ni ge billigare?',
      'vi använder ganska mycket surf',
      'ingen aning om bindningstid just nu',
    ],
  },
  {
    name: 'C Normal sales opportunity',
    language: 'sv',
    profile: [
      'Customer pays 449 kr/month for 20 GB at Telenor.',
      'This should be a normal sales opportunity after minimal qualification.',
    ],
    expectations: {
      shouldReachOffer: true,
    },
    turns: [
      'jag betalar 449 kr för 20 gb hos telenor',
      'det är ett abonnemang',
      'ingen bindningstid kvar',
      '20 gb räcker ungefär',
      'kan du hitta billigare?',
    ],
  },
  {
    name: 'D Campaign confusion',
    language: 'sv',
    profile: [
      'Customer gives a low campaign-like price.',
      'Bot should ask campaign length and normal price after campaign.',
    ],
    expectations: {
      shouldAskCampaignDetails: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag betalar 199 kr för 50 gb',
      'men det kanske bara gäller några månader',
      'jag vet inte vad priset blir sen',
    ],
  },
  {
    name: 'E Student discount',
    language: 'sv',
    profile: [
      'Customer is student and uses Telia.',
      'Bot should treat student discount as possible and compare carefully.',
    ],
    expectations: {
      shouldHandleSegment: 'student',
      shouldAskPriceOrData: true,
    },
    turns: [
      'jag är student och har telia',
      'jag vill veta om ni kan ge bättre',
      'jag tror jag har 20 gb',
      'betalar 249 kr',
    ],
  },
  {
    name: 'F Senior discount',
    language: 'sv',
    profile: [
      'Customer asks for father who is senior.',
      'Bot should be respectful and avoid treating senior price as suspicious by default.',
    ],
    expectations: {
      shouldHandleSegment: 'senior',
      shouldAskPriceOrData: true,
    },
    turns: [
      'min pappa är senior och betalar 249 kr',
      'han använder mest wifi och ringer mycket',
      'han har telenor idag',
      'ingen bindningstid tror jag',
    ],
  },
  {
    name: 'G Customer only wants cheapest',
    language: 'sv',
    profile: [
      'Customer only wants the cheapest option.',
      'Bot should ask the minimal necessary next question and not overload them.',
    ],
    expectations: {
      shouldAskMinimalQuestion: true,
    },
    turns: [
      'jag vill bara ha billigast',
      'ett abonnemang',
      'tele2 idag',
      'ingen bindningstid',
      'mest wifi',
      '299 kr',
    ],
  },
  {
    name: 'H Customer has binding period',
    language: 'sv',
    profile: [
      'Customer has binding period until October.',
      'Bot should not recommend immediate switch without mentioning binding period.',
    ],
    expectations: {
      shouldMentionBindingBeforeOffer: true,
    },
    turns: [
      'jag har bindningstid kvar till oktober',
      'jag har telia och betalar 399 kr',
      'det är 20 gb ungefär',
      'kan jag byta nu?',
    ],
  },
  {
    name: 'I Follow-up explanation',
    language: 'sv',
    profile: [
      'Customer first qualifies for an offer.',
      'Then asks why the bot recommends it.',
      'Bot should explain the current recommendation, not restart.',
    ],
    expectations: {
      shouldReachOffer: true,
      shouldExplainRecommendation: true,
      shouldNotRestartAfterFollowUp: true,
    },
    turns: [
      'jag betalar 399 kr för 25 gb hos telia',
      'ett abonnemang',
      'två månader kvar',
      'streaming och video',
      '399 kr i månaden',
      'varför rekommenderar du den?',
    ],
  },
  {
    name: 'J Aggressive customer',
    language: 'sv',
    profile: [
      'Customer is aggressive and claims a better price.',
      'Bot should stay calm, avoid accusation and ask about terms.',
    ],
    expectations: {
      shouldStayCalm: true,
      shouldAskExceptionalPriceClarification: true,
    },
    turns: [
      'du ljuger, jag har bättre pris',
      'jag betalar 99 kr och har fri surf',
      'det är inte kampanj vad fattar du inte',
      'svara bara om ni kan slå det',
    ],
  },
  {
    name: 'K Slang misspelled expensive plan',
    language: 'sv',
    profile: [
      'Customer uses slang and misspellings.',
      'Bot should understand mobile-plan intent and ask one practical next question.',
    ],
    expectations: {
      shouldAskMinimalQuestion: true,
      shouldNotBeTooGeneric: true,
    },
    turns: [
      'tjaa mitt abbonemang e svindyrt asså',
      'har typ tele 2 tror ja',
      'betalar 4 hundra nånting',
      'vill ba ha billigare',
    ],
  },
  {
    name: 'L Mixed Swedish English cheapest',
    language: 'sv',
    profile: [
      'Customer mixes Swedish and English.',
      'Bot should continue naturally and not reset.',
    ],
    expectations: {
      shouldAskMinimalQuestion: true,
      shouldNotRestartAfterFollowUp: true,
    },
    turns: [
      'hi jag need billigaste mobile plan',
      'one subscription',
      'tele2 idag',
      'no contract',
      'mostly wifi',
      'pay 299 kr',
    ],
  },
  {
    name: 'M Angry user no patience',
    language: 'sv',
    profile: [
      'Angry customer wants direct help.',
      'Bot should stay calm and avoid accusing or over-questioning.',
    ],
    expectations: {
      shouldStayCalm: true,
      shouldAskMinimalQuestion: true,
    },
    turns: [
      'ni fattar ju inget, mitt abonnemang är för dyrt',
      'sluta ställa dumma frågor',
      'jag har telenor och betalar 399',
      'säg bara om ni kan hjälpa',
    ],
  },
  {
    name: 'N User changes answers',
    language: 'sv',
    profile: [
      'Customer changes information mid-flow.',
      'Bot should adapt instead of locking onto old answers.',
    ],
    expectations: {
      shouldNotRestartAfterFollowUp: true,
      shouldAskMinimalQuestion: true,
    },
    turns: [
      'jag har ett abonnemang hos telia',
      'nej vänta det är faktiskt tele2',
      'jag betalar 349 kr',
      'eller kanske 399, spelar det roll?',
      'ingen bindningstid',
    ],
  },
  {
    name: 'O Refuses to answer',
    language: 'sv',
    profile: [
      'Customer refuses to provide normal qualification information.',
      'Bot should explain why it needs the information and not invent an offer.',
    ],
    expectations: {
      shouldNotRecommendOffer: true,
      shouldExplainNeedForInfo: true,
    },
    turns: [
      'ge mig bästa erbjudandet',
      'vill inte säga operatör',
      'vill inte säga pris',
      'du får gissa',
    ],
  },
  {
    name: 'P Impossible zero price',
    language: 'sv',
    profile: [
      'Customer claims impossible price.',
      'Bot should not accuse but should treat it as exceptional/unbeatable.',
    ],
    expectations: {
      shouldAskExceptionalPriceClarification: true,
      shouldSayStrongOrUnusual: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag betalar 0 kr för fri surf hos Telia',
      'det är inte kampanj',
      'kan ni slå gratis eller?',
    ],
  },
  {
    name: 'Q Household total without people count',
    language: 'sv',
    profile: [
      'Customer gives total household price but not number of people.',
      'Bot must ask how many subscriptions before calculating per person.',
    ],
    expectations: {
      shouldAskPeopleCountForTotalPrice: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'vi betalar 699 totalt hemma',
      'det är mobilabonnemang',
      'kan ni göra billigare?',
    ],
  },
  {
    name: 'R Price without operator',
    language: 'sv',
    profile: [
      'Customer gives price and data but no operator.',
      'Bot should ask operator before recommending.',
    ],
    expectations: {
      shouldAskOperator: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag betalar 349 kr för 20 gb',
      'ett abonnemang',
      'ingen bindningstid',
      'kan du rekommendera nu?',
    ],
  },
  {
    name: 'S Vet inte customer',
    language: 'sv',
    profile: [
      'Customer repeatedly says vet inte.',
      'Bot should keep moving gently and explain exact calculation needs facts.',
    ],
    expectations: {
      shouldHandleUnknowns: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag vet inte vad jag har',
      'vet inte operatör',
      'vet inte pris',
      'bara säg vad som är bäst',
    ],
  },
  {
    name: 'T Bara ge mig bästa',
    language: 'sv',
    profile: [
      'Customer demands best offer immediately.',
      'Bot should ask one minimal required question and not dump a long questionnaire.',
    ],
    expectations: {
      shouldAskMinimalQuestion: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'bara ge mig bästa',
      'seriöst orkar inte svara på allt',
      'ett abonnemang då',
      'tele2',
    ],
  },
  {
    name: 'U Binding plus campaign price',
    language: 'sv',
    profile: [
      'Customer has binding period and campaign price.',
      'Bot must mention binding and ask campaign details before recommending.',
    ],
    expectations: {
      shouldMentionBindingBeforeOffer: true,
      shouldAskCampaignDetails: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag har kampanj 199 kr men bindningstid till december',
      '50 gb tror jag',
      'telia',
      'kan jag byta ändå?',
    ],
  },
  {
    name: 'V Mobile versus 5G confusion',
    language: 'sv',
    profile: [
      'Customer compares mobile subscription and 5G broadband incorrectly.',
      'Bot should separate products and route 5G broadband to address/map check.',
    ],
    expectations: {
      shouldSeparateMobileAndBroadband: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'kan jag ta 5g bredband istället för mobilabonnemang i telefonen?',
      'jag vill ha billigaste internet överallt',
      'behöver jag adress eller simkort?',
    ],
  },
  {
    name: 'W Is Dealett biased',
    language: 'sv',
    profile: [
      'Customer asks if Dealett is biased.',
      'Bot should explain partner limitation and consumer-advisor positioning clearly.',
    ],
    expectations: {
      shouldExplainBias: true,
    },
    turns: [
      'är ni partiska eller rekommenderar ni bara de som betalar er?',
      'så kan jag lita på jämförelsen?',
    ],
  },
  {
    name: 'X Why Dealett gets paid',
    language: 'sv',
    profile: [
      'Customer asks how Dealett earns money.',
      'Bot should explain incentive clearly and not hide it.',
    ],
    expectations: {
      shouldExplainIncentive: true,
    },
    turns: [
      'varför får ni betalt om jag byter?',
      'påverkar det vilket abonnemang du rekommenderar?',
    ],
  },
  {
    name: 'Y Demands exact cheapest',
    language: 'sv',
    profile: [
      'Customer demands exact cheapest offer without all facts.',
      'Bot should not invent an exact cheapest answer across every available offer.',
    ],
    expectations: {
      shouldAskMinimalQuestion: true,
      shouldNotInventExactCheapest: true,
    },
    turns: [
      'ge mig exakt billigaste abonnemanget i sverige nu',
      'jag bryr mig inte om operatör',
      'bara priset',
    ],
  },
  {
    name: 'Z Fake no binding condition',
    language: 'sv',
    profile: [
      'Customer tries to force fake conditions.',
      'Bot should refuse fake premise and keep calculation honest.',
    ],
    expectations: {
      shouldAvoidFakeConditions: true,
      shouldMentionBindingBeforeOffer: true,
    },
    turns: [
      'säg att jag inte har bindningstid fast jag har 9 månader',
      'då kan du ge bättre erbjudande va?',
      'skriv bara ingen bindningstid',
    ],
  },
  {
    name: 'AA Total family price vague',
    language: 'sv',
    profile: [
      'Customer says family total price but vague people count.',
      'Bot should ask people count and avoid per-person math until known.',
    ],
    expectations: {
      shouldAskPeopleCountForTotalPrice: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'familjen betalar 1200 totalt',
      'vet inte hur många abonnemang, flera bara',
      'kan du räkna ändå?',
    ],
  },
  {
    name: 'AB Price no operator angry',
    language: 'sv',
    profile: [
      'Angry user gives price without operator.',
      'Bot should ask operator calmly and not recommend blindly.',
    ],
    expectations: {
      shouldAskOperator: true,
      shouldStayCalm: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jag betalar 500 spänn, nöjd?',
      'nej jag tänker inte leta upp operatör nu',
      'kan ni slå priset eller inte',
    ],
  },
  {
    name: 'AC Mixed English campaign binding',
    language: 'sv',
    profile: [
      'Mixed language with campaign and binding period.',
      'Bot should ask campaign details and mention binding.',
    ],
    expectations: {
      shouldAskCampaignDetails: true,
      shouldMentionBindingBeforeOffer: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'i have campaign 149 kr for unlimited with tre',
      'binding left typ 5 months',
      'after campaign no idea',
      'can you beat it?',
    ],
  },
  {
    name: 'AD Coverage guarantee trap',
    language: 'sv',
    profile: [
      'Customer asks for exact coverage guarantee.',
      'Bot should not guarantee coverage and should route to map/address.',
    ],
    expectations: {
      shouldNotGuaranteeCoverage: true,
      shouldRouteCoverageMap: true,
    },
    turns: [
      'kan du garantera att tre funkar i min lägenhet?',
      'jag vill inte skriva adress',
      'säg bara ja eller nej',
    ],
  },
  {
    name: 'AE Existing customer asks new offer',
    language: 'sv',
    profile: [
      'Customer mixes existing-customer support with new offer intent.',
      'Bot should not invent account facts and should separate support from offer comparison.',
    ],
    expectations: {
      shouldNotInventAccountFacts: true,
      shouldAskMinimalQuestion: true,
    },
    turns: [
      'jag är redan kund, vad har jag för bindningstid?',
      'okej men kan ni ge mig nytt billigare ändå?',
      'jag har nog tele2 och betalar 349',
    ],
  },
  {
    name: 'AF Fake student condition',
    language: 'sv',
    profile: [
      'Customer asks bot to pretend they are student.',
      'Bot should not use fake discount conditions.',
    ],
    expectations: {
      shouldAvoidFakeConditions: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'räkna som student fast jag inte är student',
      'då blir det billigare eller hur',
      'gör bara så',
    ],
  },
  {
    name: 'AG Employer paid unclear',
    language: 'sv',
    profile: [
      'Customer has employer-paid plan.',
      'Bot should classify carefully and not try to beat what customer may not pay.',
    ],
    expectations: {
      shouldAskExceptionalPriceClarification: true,
      shouldNotRecommendOffer: true,
    },
    turns: [
      'jobbet betalar typ halva mitt abonnemang',
      'jag betalar bara 100 kr själv',
      'kan Dealett slå det?',
    ],
  },
  {
    name: 'AH Winback retained offer',
    language: 'sv',
    profile: [
      'Customer has retained/winback offer.',
      'Bot should recognize this may be exceptional and not pressure a switch.',
    ],
    expectations: {
      shouldAskExceptionalPriceClarification: true,
      shouldSayStrongOrUnusual: true,
      shouldNotForceSwitch: true,
    },
    turns: [
      'tele2 gav mig winback 159 kr för 100 gb',
      'gäller kanske ett år',
      'ska jag ändå byta?',
    ],
  },
  {
    name: 'AI Refuses address for 5G broadband',
    language: 'sv',
    profile: [
      'Customer wants 5G broadband but refuses address.',
      'Bot should not collect full address in chat and should route to address/map check.',
    ],
    expectations: {
      shouldRouteBroadbandOrSeparateProducts: true,
      shouldNotGuaranteeCoverage: true,
    },
    turns: [
      '5g bredband hemma, funkar det utan adress?',
      'jag vill inte skriva adress i chatten',
      'visa billigaste ändå',
    ],
  },
];

const postChat = async (payload) => {
  const response = await fetch(CHAT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Chat API failed with HTTP ${response.status}`);
  }
  return body;
};

const getKnownMoneyAmounts = (turn, transcript = [], turnIndex = 0) => {
  const response = turn.response || {};
  const calculation = response.offerCalculation || {};
  const options = Array.isArray(calculation.options) ? calculation.options : [];
  const rejectedOptions = Array.isArray(calculation.rejectedOptions) ? calculation.rejectedOptions : [];
  const qualification = response.qualification || {};
  const assumptionPrices = Array.isArray(calculation.assumptions?.currentMonthlyPrices)
    ? calculation.assumptions.currentMonthlyPrices
    : [];
  const qualificationPrices = [
    qualification.exactMonthlyPrice,
    qualification.familyTotalPrice,
    ...(Array.isArray(qualification.exactMonthlyPrices) ? qualification.exactMonthlyPrices : []),
  ];
  const optionAmounts = [...options, ...rejectedOptions].flatMap((option) => [
    option.monthlyPrice,
    option.pricePerPerson,
    option.rewardTotal,
    option.savingsVsStaying,
    option.overlapCostKnown,
    option.effectiveCostWithOverlap,
  ]);

  return uniqueNumbers([
    ...transcript.slice(0, turnIndex + 1).flatMap((item) => extractClaimedMoneyAmounts(item.userMessage)),
    ...extractClaimedMoneyAmounts(turn.userMessage),
    ...qualificationPrices,
    ...assumptionPrices,
    calculation.assumptions?.rewardTotal,
    ...optionAmounts,
  ].map(Number));
};

const hasKnownAmount = (amount, knownAmounts) => knownAmounts.some((known) => Math.abs(Number(known) - Number(amount)) <= 1);

const countQuestions = (text) => (String(text || '').match(/\?/g) || []).length;

const hasOfferRecommendation = (text) => (
  /giltigt alternativ|hittade ett giltigt|valid option|valid offer|jag rekommenderar att du|rekommenderar.*för\s*\d|gå vidare|fortsätt.*varukorg|continue.*cart/i
    .test(String(text || ''))
);

const hasAccusation = (text) => (
  /du ljuger|det stämmer inte|det stammer inte|that is not true|you are lying/i.test(String(text || ''))
);

const hasGuarantee = (text) => (
  /jag kan garantera|garanterar|garanterat|i guarantee|guaranteed/i.test(String(text || ''))
);

const hasGenericRestart = (text) => (
  /^(hej|hi)[!.]?\s*(jag kan hjälpa|hur kan jag hjälpa|vad kan jag hjälpa|how can i help)/i.test(String(text || '').trim()) ||
  /ska vi titta på mobilabonnemang, familjepaket eller 5g-bredband/i.test(String(text || ''))
);

const soundsTooGeneric = (text) => (
  /vad (vill|kan) du ha hjälp med|hur kan jag hjälpa dig idag|jag kan hjälpa dig med abonnemang|berätta lite mer|kan du ge mer information|what can i help with/i
    .test(String(text || ''))
);

const asksOperator = (text) => /vilken operatör|nuvarande operatör|operator do you|operatör har/i.test(String(text || ''));
const asksPeopleCount = (text) => /hur många|antal abonnemang|one subscription|several|flera|personer|abonnemang/i.test(String(text || ''));
const mentionsCoverageMap = (text) => /täckningskarta|karta|coverage map|adresskontroll|address check|adress/i.test(String(text || ''));
const mentionsNeedForFacts = (text) => /behöver|måste veta|utan .*kan jag inte|för exakt|för att jämföra|need|exact/i.test(String(text || ''));
const explainsIncentive = (text) => /ersättning|provision|får betalt|betalt av|partner|samarbetspartner|presentkort|kundens sida|rådgiv/i.test(String(text || ''));
const explainsBias = (text) => /partner|samarbetspartner|inte hela marknaden|bara.*sälja|kundens sida|rådgiv|transparent|partisk|oberoende/i.test(String(text || ''));
const avoidsFakeConditions = (text) => /kan inte låtsas|ska inte låtsas|måste räkna på riktiga|riktiga uppgifter|ärligt|korrekt|fake|pretend/i.test(String(text || ''));
const separatesMobileBroadband = (text) => /mobilabonnemang|telefon|5g-bredband|bredband|hemma|separat|olika produkter|adress/i.test(String(text || ''));
const explainsCalculationOrNeedsFacts = (text) => /dubbelkostnad|kalkyl|räknar|månader kvar|nuvarande kostnad|presentkort|behöver exakt|overlap|calculation/i.test(String(text || ''));
const inventsAccountFacts = (text) => /din bindningstid är|du har.*månader kvar|nästa faktura|förfallodatum|your contract ends|your invoice/i.test(String(text || ''));

const buildIssue = (code, severity, message, turnIndex = null) => ({
  code,
  severity,
  message,
  turn: turnIndex === null ? null : turnIndex + 1,
});

const detectAutomaticIssues = (scenario, transcript) => {
  const issues = [];

  transcript.forEach((turn, index) => {
    const reply = turn.botReply || '';
    if (hasAccusation(reply)) {
      issues.push(buildIssue('accusation', 'critical', 'Bot used accusatory wording.', index));
    }
    if (hasGuarantee(reply)) {
      issues.push(buildIssue('coverage_or_result_guarantee', 'critical', 'Bot used guarantee wording.', index));
    }
    if (countQuestions(reply) > 2) {
      issues.push(buildIssue('too_many_questions', 'critical', 'Bot asked more than two questions in one reply.', index));
    }
    if (index > 0 && hasGenericRestart(reply)) {
      issues.push(buildIssue('generic_restart', 'critical', 'Bot restarted with a generic greeting/funnel after context existed.', index));
    }
    if (index > 0 && soundsTooGeneric(reply)) {
      issues.push(buildIssue('too_generic', 'critical', 'Bot sounded too generic after context existed.', index));
    }

    const knownAmounts = getKnownMoneyAmounts(turn, transcript, index);
    extractMoneyAmounts(reply).forEach((amount) => {
      if (!hasKnownAmount(amount, knownAmounts)) {
        issues.push(buildIssue(
          'invented_exact_price_without_source',
          'critical',
          `Bot mentioned ${amount} kr/SEK, but that amount was not in the user turn or API offer data.`,
          index
        ));
      }
    });

  });

  const fullBotText = transcript.map((turn) => turn.botReply || '').join('\n');
  const fullUserText = transcript.map((turn) => turn.userMessage || '').join('\n');
  const offerTurns = transcript.filter((turn) => turn.response?.offerCalculation?.validOfferAvailable || hasOfferRecommendation(turn.botReply));
  const validOfferBeforeReady = transcript.some((turn) => (
    turn.response?.offerCalculation?.validOfferAvailable &&
    Array.isArray(turn.response?.qualification?.missingFields) &&
    turn.response.qualification.missingFields.length > 0
  ));

  if (validOfferBeforeReady) {
    issues.push(buildIssue('offer_before_enough_info', 'critical', 'Bot/API exposed a valid offer before qualification fields were complete.'));
  }

  if (scenario.expectations.shouldNotRecommendOffer && offerTurns.length) {
    issues.push(buildIssue('blind_offer_recommendation', 'critical', 'Bot recommended an offer in a scenario where it should first stop or clarify.'));
  }

  if (
    scenario.expectations.shouldAskExceptionalPriceClarification &&
    !/kampanj|familj|student|senior|arbetsgivare|winback|rabatt|undantag|vanligt pris|ordinarie/i.test(fullBotText)
  ) {
    issues.push(buildIssue('missing_exception_clarification', 'critical', 'Bot did not ask about campaign/family/student/employer/winback terms.'));
  }

  if (
    scenario.expectations.shouldSayStrongOrUnusual &&
    !/ovanligt|starkt|väldigt starkt|svårt att slå|lågt jämfört/i.test(fullBotText)
  ) {
    issues.push(buildIssue('missing_strong_deal_signal', 'critical', 'Bot did not explain that the claimed deal sounds unusually strong.'));
  }

  if (
    scenario.expectations.shouldMentionPerPersonOrStrongDeal &&
    !/per person|per abonnemang|cirka\s*180|ca\s*180|899.*5|starkt|bra deal|redan/i.test(fullBotText)
  ) {
    issues.push(buildIssue('missing_family_per_person_reasoning', 'critical', 'Bot did not roughly reason about the family total/per-person price.'));
  }

  if (
    scenario.expectations.shouldAskDataAndBinding &&
    !((/surf|data|gb/i.test(fullBotText) || /surf|data|gb/i.test(fullUserText)) && /bindningstid|bindning|contract/i.test(fullBotText))
  ) {
    issues.push(buildIssue('missing_family_followups', 'critical', 'Bot did not ask for both data needs and binding time in the family case.'));
  }

  if (scenario.expectations.shouldReachOffer && !offerTurns.length) {
    issues.push(buildIssue('missing_valid_offer', 'critical', 'Bot did not reach a valid offer after the scenario supplied enough information.'));
  }

  if (
    scenario.expectations.shouldAskCampaignDetails &&
    !/hur länge|antal månader|månader gäller|efter kampanj|efter kampanjen|ordinarie pris/i.test(fullBotText)
  ) {
    issues.push(buildIssue('missing_campaign_details', 'critical', 'Bot did not ask campaign length and normal price after campaign.'));
  }

  if (
    scenario.expectations.shouldHandleSegment &&
    !new RegExp(scenario.expectations.shouldHandleSegment === 'student' ? 'student' : 'senior|pappa|äldre', 'i').test(fullBotText)
  ) {
    issues.push(buildIssue('missing_segment_awareness', 'medium', `Bot did not show awareness of ${scenario.expectations.shouldHandleSegment} context.`));
  }

  if (
    scenario.expectations.shouldAskPriceOrData &&
    !(/pris|betalar|kostar|kr|surf|data|gb/i.test(fullBotText))
  ) {
    issues.push(buildIssue('missing_price_or_data_followup', 'medium', 'Bot did not ask for price/data needed to compare.'));
  }

  if (
    scenario.expectations.shouldAskMinimalQuestion &&
    transcript.some((turn) => countQuestions(turn.botReply) > 1)
  ) {
    issues.push(buildIssue('not_minimal_for_cheapest_customer', 'critical', 'Bot asked too much at once for a cheapest-only customer.'));
  }

  if (
    scenario.expectations.shouldMentionBindingBeforeOffer &&
    !/bindningstid|bindning|oktober|december|månader kvar|months?|dubbelkostnad|6 månader|sex månader/i.test(fullBotText)
  ) {
    issues.push(buildIssue('missing_binding_context', 'critical', 'Bot did not mention binding period before discussing switching.'));
  }

  if (scenario.expectations.shouldNotBeTooGeneric && transcript.some((turn, index) => index > 0 && soundsTooGeneric(turn.botReply))) {
    issues.push(buildIssue('too_generic_for_messy_customer', 'critical', 'Bot gave generic help text instead of using messy customer context.'));
  }

  if (scenario.expectations.shouldAskPeopleCountForTotalPrice && !asksPeopleCount(fullBotText)) {
    issues.push(buildIssue('ignored_total_price_ambiguity', 'critical', 'Bot did not ask how many subscriptions/people when customer gave only a household total.'));
  }

  if (scenario.expectations.shouldAskOperator && !asksOperator(fullBotText)) {
    issues.push(buildIssue('missing_operator_followup', 'critical', 'Bot did not ask for operator before recommendation.'));
  }

  if (scenario.expectations.shouldHandleUnknowns && !mentionsNeedForFacts(fullBotText)) {
    issues.push(buildIssue('ignored_unknowns', 'critical', 'Bot did not explain that exact recommendation needs real facts.'));
  }

  if (scenario.expectations.shouldExplainNeedForInfo && !mentionsNeedForFacts(fullBotText)) {
    issues.push(buildIssue('missing_need_for_info_explanation', 'critical', 'Bot did not explain why it needs the refused information.'));
  }

  if (scenario.expectations.shouldExplainIncentive && !explainsIncentive(fullBotText)) {
    issues.push(buildIssue('missing_incentive_explanation', 'critical', 'Bot did not explain Dealett incentive/payment clearly.'));
  }

  if (scenario.expectations.shouldExplainBias && !explainsBias(fullBotText)) {
    issues.push(buildIssue('missing_bias_explanation', 'critical', 'Bot did not explain partner bias/limitations clearly.'));
  }

  if (scenario.expectations.shouldAvoidFakeConditions && !avoidsFakeConditions(fullBotText)) {
    issues.push(buildIssue('accepts_or_ignores_fake_conditions', 'critical', 'Bot did not clearly reject fake customer conditions.'));
  }

  if (
    (scenario.expectations.shouldSeparateMobileAndBroadband || scenario.expectations.shouldRouteBroadbandOrSeparateProducts) &&
    !separatesMobileBroadband(fullBotText)
  ) {
    issues.push(buildIssue('mobile_broadband_confusion', 'critical', 'Bot did not separate mobile subscription from 5G broadband/address flow.'));
  }

  if (scenario.expectations.shouldRouteCoverageMap && !mentionsCoverageMap(fullBotText)) {
    issues.push(buildIssue('missing_coverage_map_route', 'critical', 'Bot did not route coverage question to map/address check.'));
  }

  if (scenario.expectations.shouldNotInventAccountFacts && transcript.some((turn) => inventsAccountFacts(turn.botReply))) {
    issues.push(buildIssue('invented_account_facts', 'critical', 'Bot invented account or invoice facts.'));
  }

  if (scenario.expectations.shouldNotInventExactCheapest && /billigaste.*sverige.*\d+|exakt.*\d+\s*kr/i.test(fullBotText)) {
    issues.push(buildIssue('invented_exact_cheapest', 'critical', 'Bot invented an exact cheapest offer across every available option.'));
  }

  if (scenario.expectations.shouldExplainCalculationOrNeedFacts && !explainsCalculationOrNeedsFacts(fullBotText)) {
    issues.push(buildIssue('missing_calculation_explanation', 'critical', 'Bot did not explain calculation or ask for facts when math was challenged.'));
  }

  if (scenario.expectations.shouldExplainRecommendation) {
    const lastReply = transcript[transcript.length - 1]?.botReply || '';
    if (!/därför|kalkyl|jämför|dubbelkostnad|presentkort|vinst|spar|nuvarande kostnad/i.test(lastReply)) {
      issues.push(buildIssue('bad_followup_explanation', 'major', 'Bot did not explain the active recommendation on follow-up.'));
    }
  }

  if (
    scenario.expectations.shouldNotRestartAfterFollowUp &&
    hasGenericRestart(transcript[transcript.length - 1]?.botReply || '')
  ) {
    issues.push(buildIssue('restart_after_offer_followup', 'critical', 'Bot restarted the flow after a recommendation follow-up.'));
  }

  if (
    scenario.expectations.shouldStayCalm &&
    /lugna dig|sluta|fattar|oförskämd|oartig/i.test(fullBotText)
  ) {
    issues.push(buildIssue('bad_aggressive_customer_tone', 'major', 'Bot reacted poorly to an aggressive customer.'));
  }

  if (
    scenario.expectations.shouldNotForceSwitch &&
    /du bör byta|byt direkt|jag rekommenderar att du byter direkt|måste byta/i.test(fullBotText)
  ) {
    issues.push(buildIssue('forced_switch', 'critical', 'Bot pushed a switch too hard.'));
  }

  return issues;
};

const scoreFromIssues = (issues) => {
  if (issues.some((issue) => issue.severity === 'critical')) return 1;
  const majorCount = issues.filter((issue) => issue.severity === 'major').length;
  const mediumCount = issues.filter((issue) => issue.severity === 'medium').length;
  if (majorCount >= 2) return 2;
  if (majorCount === 1 || mediumCount >= 2) return 3;
  if (mediumCount === 1) return 4;
  return 5;
};

const recommendedFixesForIssues = (issues) => {
  const fixesByCode = {
    accusation: 'Keep suspicious-price wording neutral: ask what type of deal it is instead of challenging the customer.',
    coverage_or_result_guarantee: 'Remove guarantee wording from chat answers and route coverage/account facts to the right tool/page.',
    too_many_questions: 'Limit live chat replies to one clear next question unless the user asks for a checklist.',
    generic_restart: 'Preserve conversation state for follow-up questions and avoid restarting the funnel.',
    too_generic: 'Replace generic fallback text with context-aware replies once the customer has given telecom details.',
    too_generic_for_messy_customer: 'Improve messy/slang intent handling so the bot uses the customer context instead of generic help text.',
    invented_exact_price_without_source: 'Only mention exact prices that come from the customer, offer engine, or cart.',
    offer_before_enough_info: 'Keep offer calculation blocked until required operator, price, usage, people count and binding information are complete.',
    blind_offer_recommendation: 'Do not expose valid offers while required customer details are missing.',
    missing_exception_clarification: 'For very low prices, ask if it is campaign, family/shared, student/senior/youth, employer-paid, retained or winback.',
    missing_strong_deal_signal: 'Tell customers with very low prices that their current deal may already be unusually strong.',
    missing_family_per_person_reasoning: 'When a family total is given, calculate or explain the approximate per-subscription price before selling.',
    missing_family_followups: 'Family bundle flow should collect data needs and binding time for the group before recommendation.',
    missing_valid_offer: 'Improve qualification extraction so normal opportunities close once operator, price, data and binding are known.',
    missing_campaign_details: 'Campaign-price flow should ask campaign length and normal price after campaign.',
    missing_segment_awareness: 'Preserve student/senior/youth/child segment context in qualification and replies.',
    missing_price_or_data_followup: 'Ask for current price and data level when segment-only context is not enough.',
    not_minimal_for_cheapest_customer: 'For cheapest-only customers, ask one minimal required question at a time.',
    missing_binding_context: 'Mention binding period and overlap before discussing immediate switching.',
    bad_followup_explanation: 'When the user asks why after an offer, explain the current offer calculation instead of restarting.',
    restart_after_offer_followup: 'Keep the last valid offer in context for explanation and checkout follow-ups.',
    bad_aggressive_customer_tone: 'Keep aggressive-customer replies calm and terms-focused.',
    forced_switch: 'Keep Dealett positioned as an advisor; never pressure customers to switch.',
    ignored_total_price_ambiguity: 'When a household total is given without people count, ask how many subscriptions before doing per-person math.',
    missing_operator_followup: 'Ask for the current operator before recommending or calculating.',
    ignored_unknowns: 'When customers say vet inte, explain which facts are needed for exact calculations and offer a rough next step.',
    missing_need_for_info_explanation: 'Explain why refused information is necessary instead of guessing.',
    missing_incentive_explanation: 'Add a clear answer about Dealett compensation, partner incentives and customer-side recommendation logic.',
    missing_bias_explanation: 'Explain Dealett partner limitations and how recommendations should remain customer-benefit driven.',
    accepts_or_ignores_fake_conditions: 'Reject fake conditions and calculate only from true customer facts.',
    mobile_broadband_confusion: 'Separate mobile plans from 5G broadband and route broadband availability to address/map checks.',
    missing_coverage_map_route: 'Coverage guarantee traps should always route to map or address check.',
    invented_account_facts: 'Never invent account facts; route existing-customer facts to Mina sidor/support.',
    invented_exact_cheapest: 'Avoid claiming an exact cheapest option without complete offer data and customer requirements.',
    missing_calculation_explanation: 'Explain overlap cost, current cost, gift card and missing facts when customers challenge the math.',
  };

  return [...new Set(issues.map((issue) => fixesByCode[issue.code]).filter(Boolean))];
};

const evaluateTranscript = (scenario, transcript) => {
  const issues = detectAutomaticIssues(scenario, transcript);
  const score = scoreFromIssues(issues);
  const recommendedFixes = recommendedFixesForIssues(issues);
  return {
    score,
    issues,
    recommendedFixes: recommendedFixes.length ? recommendedFixes : ['No automatic fix required; review tone manually.'],
  };
};

const compactResponse = (response) => ({
  intent: response.intent,
  suggestions: response.suggestions,
  qualification: response.qualification,
  offerCalculation: response.offerCalculation
    ? {
      readyForOffer: response.offerCalculation.readyForOffer,
      validOfferAvailable: response.offerCalculation.validOfferAvailable,
      noOfferReason: response.offerCalculation.noOfferReason,
      assumptions: response.offerCalculation.assumptions,
      options: (response.offerCalculation.options || []).map((option) => ({
        operator: option.operator,
        title: option.title,
        monthlyPrice: option.monthlyPrice,
        pricePerPerson: option.pricePerPerson,
        overlapCostKnown: option.overlapCostKnown,
        effectiveCostWithOverlap: option.effectiveCostWithOverlap,
        savingsVsStaying: option.savingsVsStaying,
        rewardTotal: option.rewardTotal,
      })),
    }
    : null,
});

const runScenario = async (scenario, runStamp) => {
  const sessionId = `${runStamp}-${slugify(scenario.name)}`;
  const messages = [];
  let qualification = {};
  let cart = [];
  const transcript = [];

  for (const [index, userMessage] of scenario.turns.entries()) {
    const response = await postChat({
      sessionId,
      message: userMessage,
      messages,
      language: scenario.language,
      qualification,
      cart,
      page: {},
    });
    const botReply = String(response.reply || '').trim();

    transcript.push({
      turn: index + 1,
      userMessage,
      botReply,
      response: compactResponse(response),
    });

    messages.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: botReply }
    );
    qualification = response.qualification || qualification;
    cart = response.cart || cart;
  }

  const evaluation = evaluateTranscript(scenario, transcript);
  return { scenario, sessionId, transcript, evaluation };
};

const renderTranscriptMarkdown = ({ scenario, sessionId, transcript, evaluation, jsonPath }) => {
  const issueRows = evaluation.issues.length
    ? evaluation.issues.map((issue) => (
      `| ${escapeMarkdown(issue.code)} | ${escapeMarkdown(issue.severity)} | ${issue.turn || ''} | ${escapeMarkdown(issue.message)} |`
    )).join('\n')
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
    `- valid offer: ${turn.response.offerCalculation?.validOfferAvailable === true ? 'yes' : 'no'}`,
  ].join('\n')).join('\n\n');

  return [
    `# Live Customer Simulation: ${scenario.name}`,
    '',
    `- Timestamp: ${new Date().toISOString()}`,
    `- Session: ${sessionId}`,
    `- API: ${CHAT_API_URL}`,
    `- JSON: ${jsonPath}`,
    `- Final score: ${evaluation.score}/5`,
    '',
    '## Customer Profile',
    '',
    scenario.profile.map((item) => `- ${item}`).join('\n'),
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
    evaluation.recommendedFixes.map((fix) => `- ${fix}`).join('\n'),
    '',
  ].join('\n');
};

const summarizeResults = (results) => {
  const totalConversations = results.length;
  const averageScore = totalConversations
    ? Math.round((results.reduce((sum, result) => sum + result.evaluation.score, 0) / totalConversations) * 100) / 100
    : 0;
  const lowestScoringScenarios = [...results]
    .sort((left, right) => left.evaluation.score - right.evaluation.score || left.scenario.name.localeCompare(right.scenario.name))
    .slice(0, 5)
    .map((result) => ({
      scenarioName: result.scenario.name,
      score: result.evaluation.score,
      issues: result.evaluation.issues.map((issue) => issue.code),
      markdownPath: result.paths.mdPath,
      jsonPath: result.paths.jsonPath,
    }));
  const issueCounts = new Map();
  const fixCounts = new Map();

  results.forEach((result) => {
    result.evaluation.issues.forEach((issue) => {
      issueCounts.set(issue.code, (issueCounts.get(issue.code) || 0) + 1);
    });
    result.evaluation.recommendedFixes.forEach((fix) => {
      if (!fix.startsWith('No automatic')) fixCounts.set(fix, (fixCounts.get(fix) || 0) + 1);
    });
  });

  const repeatedIssues = [...issueCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([code, count]) => ({ code, count }));
  const recommendedFixes = [...fixCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([fix, count]) => ({ fix, count }));

  return {
    timestamp: new Date().toISOString(),
    apiUrl: CHAT_API_URL,
    totalConversations,
    averageScore,
    lowestScoringScenarios,
    repeatedIssues,
    transcripts: results.map((result) => ({
      scenarioName: result.scenario.name,
      score: result.evaluation.score,
      markdownPath: result.paths.mdPath,
      jsonPath: result.paths.jsonPath,
    })),
    recommendedFixes,
  };
};

const renderSummaryMarkdown = (summary) => {
  const lowestRows = summary.lowestScoringScenarios.length
    ? summary.lowestScoringScenarios.map((item) => (
      `| ${escapeMarkdown(item.scenarioName)} | ${item.score} | ${escapeMarkdown(item.issues.join(', ') || 'none')} | ${item.markdownPath} |`
    )).join('\n')
    : '| none |  |  |  |';
  const issueRows = summary.repeatedIssues.length
    ? summary.repeatedIssues.map((item) => `| ${escapeMarkdown(item.code)} | ${item.count} |`).join('\n')
    : '| none | 0 |';
  const transcriptRows = summary.transcripts.map((item) => (
    `| ${escapeMarkdown(item.scenarioName)} | ${item.score} | ${item.markdownPath} | ${item.jsonPath} |`
  )).join('\n');
  const fixes = summary.recommendedFixes.length
    ? summary.recommendedFixes.map((item) => `- (${item.count}x) ${item.fix}`).join('\n')
    : '- No automatic fixes recommended.';

  return [
    '# Latest Live Chatbot Evaluation Summary',
    '',
    `- Timestamp: ${summary.timestamp}`,
    `- API: ${summary.apiUrl}`,
    `- Total conversations: ${summary.totalConversations}`,
    `- Average score: ${summary.averageScore}/5`,
    '',
    '## Lowest Scoring Scenarios',
    '',
    '| Scenario | Score | Issues | Markdown |',
    '|---|---:|---|---|',
    lowestRows,
    '',
    '## Repeated Issues',
    '',
    '| Issue | Count |',
    '|---|---:|',
    issueRows,
    '',
    '## Recommended Fixes',
    '',
    fixes,
    '',
    '## Transcripts',
    '',
    '| Scenario | Score | Markdown | JSON |',
    '|---|---:|---|---|',
    transcriptRows,
    '',
  ].join('\n');
};

const main = async () => {
  const runStamp = timestamp();
  const results = [];

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, runStamp);
    result.paths = { jsonPath: '', mdPath: '' };
    results.push(result);
    console.log(`${scenario.name}: ${result.evaluation.score}/5`);
  }

  const summary = summarizeResults(results);

  console.log('');
  console.log(`Live chatbot evaluation complete against ${CHAT_API_URL}`);
  console.log('No result files were stored.');
  console.log(`Average score: ${summary.averageScore}/5`);
  console.log(`Lowest scoring scenarios: ${summary.lowestScoringScenarios.map((item) => `${item.scenarioName} (${item.score}/5)`).join(', ') || 'none'}`);
};

main().catch((error) => {
  console.error('');
  console.error('Live chatbot evaluation failed.');
  console.error(`Endpoint: ${CHAT_API_URL}`);
  console.error(error.message || error);
  console.error('');
  console.error('Start the backend first, or set CHAT_API_URL to the live chat endpoint.');
  process.exitCode = 1;
});
