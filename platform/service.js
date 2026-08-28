const crypto = require('node:crypto');

const { buildBroadbandCartItem, getBroadbandPlans, getPlans } = require('../offer-service');
const { calculateOfferOptions } = require('../offer-calculator');
const { normalizeQualification } = require('../qualification-service');
const { PlatformError, assertPlatform } = require('./errors');
const { requirePermission } = require('./permissions');
const { clone, escapeCsv, hashObject, stableUuid, toMinorUnits } = require('./utils');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEMPOTENCY_PATTERN = /^[a-zA-Z0-9._:-]{8,200}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const trimText = (value, maxLength, required = false, label = 'value') => {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (required && !text) throw new PlatformError('VALIDATION_ERROR', `${label} is required`, 400);
  return text ? text.slice(0, maxLength) : null;
};

const safeTimestamp = (value, label, required = false) => {
  const text = trimText(value, 100, required, label);
  if (!text) return null;
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new PlatformError('VALIDATION_ERROR', `${label} must be an ISO timestamp`, 400);
  return new Date(milliseconds).toISOString();
};

const safeObject = (value, maxBytes = 100_000) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) throw new PlatformError('VALIDATION_ERROR', 'Structured data is too large', 400);
  return JSON.parse(serialized);
};

const normalizeConversationId = (value) => {
  const text = trimText(value, 200);
  if (!text) return null;
  return UUID_PATTERN.test(text) ? text.toLowerCase() : stableUuid(`dealett-conversation:${text}`);
};

const normalizeCustomer = (payload = {}, { demoMode = true, identityVerification = null } = {}) => {
  const customerInput = safeObject(payload.customer);
  const contact = safeObject(payload.contact);
  const givenName = trimText(customerInput.givenName || contact.givenName, 100);
  const familyName = trimText(customerInput.familyName || customerInput.surname || contact.familyName, 100);
  const trustedDisplayName = trimText(identityVerification?.displayName || identityVerification?.name, 200);
  const displayName = trimText(
    (!demoMode && trustedDisplayName) || customerInput.displayName || customerInput.name || contact.name ||
    (demoMode ? payload.bankId?.user?.name : null) || [givenName, familyName].filter(Boolean).join(' '),
    200
  ) || 'Ej angivet';
  const email = trimText(customerInput.email || contact.email, 254, true, 'customer.email')?.toLowerCase();
  assertPlatform(EMAIL_PATTERN.test(email), 'VALIDATION_ERROR', 'customer.email is invalid');
  const phone = trimText(customerInput.phone || customerInput.phoneNumber || contact.phone || contact.phoneNumber, 40, true, 'customer.phone');
  return {
    displayName,
    givenName,
    familyName,
    email,
    phone,
    language: trimText(customerInput.language || payload.language, 12) || 'sv',
    address: {
      line1: trimText(customerInput.address?.line1 || contact.address?.line1, 200),
      postalCode: trimText(customerInput.address?.postalCode || contact.address?.postalCode, 20),
      city: trimText(customerInput.address?.city || contact.address?.city, 100),
      countryCode: trimText(customerInput.address?.countryCode || contact.address?.countryCode, 2) || 'SE',
    },
  };
};

const getPhoneValue = (value) => value && typeof value === 'object'
  ? (value.phoneNumber || value.number || value.value)
  : value;

const normalizeParticipants = (payload = {}, selectedOffer = {}) => {
  const submitted = Array.isArray(payload.participants) ? payload.participants : [];
  const phoneNumbers = Array.isArray(payload.phoneNumbers)
    ? payload.phoneNumbers
    : (Array.isArray(payload.portedNumbers)
      ? payload.portedNumbers
      : (Array.isArray(payload.numberHandling?.phoneNumbers) ? payload.numberHandling.phoneNumbers : []));
  const expectedCount = Math.max(Number(selectedOffer.peopleCount || selectedOffer.persons || submitted.length || phoneNumbers.length) || 1, 1);
  const source = submitted.length ? submitted : Array.from({ length: expectedCount }, (_, index) => ({
    label: `Person ${index + 1}`,
    phoneNumber: phoneNumbers[index],
  }));
  assertPlatform(source.length > 0 && source.length <= 10, 'VALIDATION_ERROR', 'participants must contain 1-10 entries');
  return source.slice(0, 10).map((participant, index) => ({
    participantId: trimText(participant?.participantId || participant?.id, 200),
    subscriptionId: trimText(participant?.subscriptionId, 200),
    label: trimText(participant?.label, 100) || `Person ${index + 1}`,
    givenName: trimText(participant?.givenName, 100),
    familyName: trimText(participant?.familyName || participant?.surname, 100),
    phoneNumber: trimText(participant?.phoneNumber || participant?.number || participant?.numberPorting?.phoneNumber || getPhoneValue(phoneNumbers[index]), 40),
    currentOperator: trimText(participant?.currentOperator || participant?.numberPorting?.currentOperator, 80),
    numberHandling: trimText(
      participant?.numberHandling || participant?.keepNumberPreference ||
      (typeof participant?.numberPorting === 'string' ? participant.numberPorting : participant?.numberPorting?.action || participant?.numberPorting?.mode) ||
      (typeof payload.numberHandling === 'string' ? payload.numberHandling : payload.numberHandling?.mode),
      40
    ) || 'unknown',
    requestedActivationDate: trimText(participant?.requestedActivationDate || participant?.activationDate || participant?.numberPorting?.activationDate, 20),
    bindingEnd: trimText(participant?.bindingEnd || participant?.numberPorting?.bindingEnd, 20),
  }));
};

const normalizeConsents = (payload = {}) => {
  if (Array.isArray(payload.consents)) {
    assertPlatform(payload.consents.length > 0, 'CONSENT_REQUIRED', 'At least one accepted consent is required');
    const consents = payload.consents.slice(0, 20).map((consent) => ({
      type: trimText(consent?.type, 80, true, 'consent.type'),
      documentId: trimText(consent?.documentId, 200),
      documentVersion: trimText(consent?.documentVersion || consent?.version, 100, true, 'consent.documentVersion'),
      accepted: consent?.accepted === true || consent?.acknowledged === true,
      acceptedAt: safeTimestamp(consent?.acceptedAt || consent?.acknowledgedAt, 'consent.acceptedAt', true),
      textHash: trimText(consent?.textHash, 128),
      evidence: pickEvidence(consent?.evidence, ['adapter', 'adapterResultId', 'verificationId', 'source', 'capturedAt'], 10_000),
    }));
    assertPlatform(consents.every((consent) => consent.accepted), 'CONSENT_REQUIRED', 'All required consents must be accepted');
    return consents;
  }
  const agreement = safeObject(payload.agreement);
  const confirmations = safeObject(agreement.confirmations);
  const operatorDocuments = safeObject(agreement.operatorDocuments);
  const dealettDocuments = safeObject(agreement.dealettDocuments);
  const mappings = [
    ['operator_agreement', confirmations.operatorAgreement, operatorDocuments.documentId, operatorDocuments.version],
    ['dealett_terms', confirmations.dealettTerms, 'dealett-terms', dealettDocuments.termsVersion],
    ['withdrawal_information', confirmations.withdrawalInformation, 'withdrawal-information', dealettDocuments.withdrawalVersion || dealettDocuments.termsVersion],
    ['privacy_policy', confirmations.privacyPolicy, 'privacy-policy', dealettDocuments.privacyVersion || dealettDocuments.termsVersion],
  ];
  return mappings.map(([type, confirmation, documentId, version]) => {
    const accepted = confirmation?.accepted === true || confirmation?.acknowledged === true;
    assertPlatform(accepted, 'CONSENT_REQUIRED', `${type} must be accepted`);
    return {
      type,
      documentId: trimText(documentId, 200, true, `${type}.documentId`),
      documentVersion: trimText(version, 100, true, `${type}.documentVersion`),
      accepted: true,
      acceptedAt: safeTimestamp(confirmation.acceptedAt || confirmation.acknowledgedAt, `${type}.acceptedAt`, true),
      textHash: null,
      evidence: { source: 'compatibility_agreement', simulated: Boolean(agreement.testMode) },
    };
  });
};

const getTranscriptEnvelope = (payload = {}) => {
  const raw = (!Array.isArray(payload.conversationSnapshot) && payload.conversationSnapshot) || {};
  const messages = normalizeConversationSnapshot(payload);
  const droppedMessageCount = Math.max(Number(raw.droppedMessageCount ?? payload.droppedMessageCount) || 0, 0);
  const declaredMessageCount = Math.max(Number(
    raw.totalMessageCount ?? raw.originalMessageCount ?? payload.totalMessageCount
  ) || 0, 0);
  const highestSequence = messages.reduce((maximum, message) => Math.max(maximum, message.requestedSequence || 0), 0);
  return {
    messages,
    transcriptTruncated: raw.transcriptTruncated === true || raw.truncated === true || payload.transcriptTruncated === true || droppedMessageCount > 0,
    droppedMessageCount,
    expectedMessageCount: Math.max(declaredMessageCount, droppedMessageCount + messages.length, highestSequence),
  };
};

const normalizePriorChatMessages = (payload = {}) => {
  if (!Array.isArray(payload.messages)) return [];
  const client = safeObject(payload.clientMessage);
  const clientSequence = Number(client.sequence) || null;
  const clientId = trimText(client.id, 200);
  return payload.messages.slice(0, 500).map((message, index) => ({
    role: ['user', 'assistant'].includes(message?.role) ? message.role : 'user',
    content: trimText(message?.content || message?.message || message?.text, 20_000, true, `messages[${index}].content`),
    structuredContent: safeObject(message?.structuredContent || message?.metadata, 50_000),
    language: trimText(message?.language || payload.language, 12) || 'sv',
    clientMessageId: trimText(message?.id || message?.messageId, 200) || `chat-history-${index + 1}-${hashObject(message).slice(0, 16)}`,
    clientCreatedAt: safeTimestamp(message?.createdAt || message?.timestamp, `messages[${index}].createdAt`) || null,
    requestedSequence: Number(message?.sequence) || index + 1,
    model: trimText(message?.model, 100),
  })).filter((message) => {
    if (clientId && message.clientMessageId === clientId) return false;
    if (clientSequence && message.requestedSequence >= clientSequence) return false;
    return true;
  }).sort((left, right) => left.requestedSequence - right.requestedSequence);
};

const maskEmail = (value) => {
  const [local = '', domain = ''] = String(value || '').split('@');
  if (!domain) return value ? '***' : null;
  return `${local.slice(0, 1) || '*'}***@${domain}`;
};

const maskPhone = (value) => {
  const text = String(value || '');
  return text ? `${'*'.repeat(Math.max(text.length - 4, 3))}${text.slice(-4)}` : null;
};

const sanitizePageReference = (value) => {
  if (value && typeof value === 'object') value = value.path || value.url || null;
  const text = trimText(value, 2_000);
  if (!text) return null;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(text);
    const parsed = new URL(text, 'https://dealett.invalid');
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const path = parsed.pathname || '/';
    return absolute ? `${parsed.origin}${path}` : path;
  } catch {
    return null;
  }
};

const normalizeAttribution = (payload = {}) => {
  const attribution = safeObject(payload.attribution, 20_000);
  const utm = safeObject(attribution.utm, 5_000);
  const source = safeObject(payload.source, 10_000);
  const cartSources = Array.isArray(source.cartSources)
    ? source.cartSources.slice(0, 20).map((entry) => trimText(entry, 100)).filter(Boolean)
    : [];
  return {
    landingPage: sanitizePageReference(attribution.landingPage || payload.sourcePage || payload.page?.path),
    referrer: sanitizePageReference(attribution.referrer),
    source: trimText(attribution.source || attribution.utm_source || utm.source, 100),
    medium: trimText(attribution.medium || attribution.utm_medium || utm.medium, 100),
    campaign: trimText(attribution.campaign || attribution.utm_campaign || utm.campaign, 200),
    term: trimText(attribution.term || attribution.utm_term || utm.term, 200),
    content: trimText(attribution.content || attribution.utm_content || utm.content, 200),
    channel: trimText(source.channel, 100),
    checkoutMode: trimText(source.checkoutMode, 100),
    checkoutPage: sanitizePageReference(source.checkoutPage),
    originatingPage: sanitizePageReference(source.originatingPage),
    cartSources,
  };
};

const projectOrderForActor = (order, actor) => {
  const projected = clone(order);
  const ownsCustomerRecord = actor?.actorType === 'customer' && actor.customerId === order.customerId;
  const mayViewSensitive = ownsCustomerRecord || actor?.permissions?.includes('sensitive_data.view');
  if (mayViewSensitive) return projected;
  if (projected.customer) {
    projected.customer.email = maskEmail(projected.customer.email);
    projected.customer.phone = maskPhone(projected.customer.phone);
  }
  projected.participants = (projected.participants || []).map((participant) => ({
    ...participant,
    phoneNumber: undefined,
    phoneNumberMasked: participant.phoneNumberMasked || maskPhone(participant.phoneNumber),
  }));
  projected.consents = (projected.consents || []).map(({ evidence, ...consent }) => consent);
  delete projected.safeTechnicalMetadata;
  if (actor?.actorType === 'partner') {
    projected.attribution = null;
    projected.conversationArchive = projected.conversationArchive
      ? { messageCount: projected.conversationArchive.messageCount, hash: projected.conversationArchive.hash }
      : null;
  }
  return projected;
};

const getRequestedOfferId = (payload = {}) => trimText(
  payload.selectedOfferId ||
  payload.planId ||
  payload.recommendation?.selectedOfferId ||
  payload.recommendation?.selectedOffer?.planId ||
  payload.cartItems?.[0]?.offerId ||
  payload.cartItems?.[0]?.planId ||
  payload.agreement?.subscription?.offerId,
  200,
  true,
  'selectedOfferId'
);

const pickEvidence = (value, allowedKeys, maxBytes = 50_000) => {
  const object = safeObject(value, maxBytes);
  return Object.fromEntries(allowedKeys.filter((key) => Object.prototype.hasOwnProperty.call(object, key)).map((key) => [key, clone(object[key])]));
};

const maskSubmittedNumber = (value) => {
  const text = trimText(value, 40);
  return text ? `${'*'.repeat(Math.max(text.length - 4, 3))}${text.slice(-4)}` : null;
};

const BUSINESS_QUESTIONNAIRE_KEYS = Object.freeze([
  'peopleCount', 'operators', 'bindingEnds', 'mobileUsage', 'exactMonthlyPrice', 'priceRange',
  'streamingCalculation', 'streamingServices', 'streamingPrices', 'internationalTravel',
  'internationalUsage', 'oldCosts', 'currentCosts',
]);

const normalizeBusinessQuestionnaire = (value) => {
  const input = safeObject(value, 150_000);
  const normalized = pickEvidence(input, BUSINESS_QUESTIONNAIRE_KEYS, 150_000);
  if (input.answersBySubscription && typeof input.answersBySubscription === 'object') {
    normalized.answersBySubscription = Object.fromEntries(Object.entries(input.answersBySubscription).slice(0, 25).map(([key, answers]) => [
      trimText(key, 200) || 'unknown',
      pickEvidence(answers, BUSINESS_QUESTIONNAIRE_KEYS, 30_000),
    ]));
  }
  return normalized;
};

const normalizeEvidenceLine = (item) => {
  const input = safeObject(item, 150_000);
  const line = pickEvidence(input, [
    'id', 'cartItemId', 'type', 'category', 'productType', 'offerId', 'planId', 'operator', 'operatorId',
    'title', 'name', 'persons', 'quantity', 'monthlyPrice', 'price', 'bindingMonths', 'activationDate',
    'numberHandling', 'deliveryType', 'rewardTotal', 'benefits', 'features', 'subscriptionId', 'participantId',
  ], 150_000);
  line.pricing = pickEvidence(input.pricing, ['monthly', 'monthlyPrice', 'total', 'subtotal', 'discount', 'currency', 'pricePerPerson'], 20_000);
  line.rewards = pickEvidence(input.rewards, ['total', 'amount', 'currency', 'type', 'provider'], 20_000);
  line.addOn = pickEvidence(input.addOn || input.addon, ['id', 'planId', 'title', 'name', 'monthlyPrice', 'price', 'quantity', 'features'], 20_000);
  line.addOns = (Array.isArray(input.addOns || input.addons) ? (input.addOns || input.addons) : []).slice(0, 20)
    .map((entry) => pickEvidence(entry, ['id', 'planId', 'title', 'name', 'monthlyPrice', 'price', 'quantity', 'features'], 20_000));
  line.streamingOffer = pickEvidence(input.streamingOffer || input.streaming, [
    'id', 'service', 'services', 'mode', 'title', 'monthlyPrice', 'price', 'included',
  ], 30_000);
  line.internationalTravel = pickEvidence(input.internationalTravel, [
    'region', 'regions', 'countries', 'dataGb', 'callsIncluded', 'smsIncluded', 'monthlyPrice',
  ], 30_000);
  line.campaign = pickEvidence(input.campaign, ['id', 'key', 'name', 'version', 'discount', 'effectiveFrom', 'effectiveTo'], 20_000);
  line.campaignVersion = trimText(input.campaignVersion, 100);
  line.ruleVersion = trimText(input.ruleVersion, 100);
  line.source = pickEvidence(input.source, ['channel', 'catalogVersion', 'ruleVersion', 'campaignVersion'], 20_000);
  line.answers = normalizeBusinessQuestionnaire(input.answers);
  line.qualification = normalizeBusinessQuestionnaire(input.qualification);
  line.offerCalculation = pickEvidence(input.offerCalculation, [
    'id', 'calculationId', 'version', 'inputs', 'outputs', 'options', 'oldCosts', 'currentCosts',
    'monthlySavings', 'termMonths', 'explanation', 'assumptions', 'breakdown',
  ], 100_000);
  line.state = pickEvidence(input.state, ['status', 'step', 'ready', 'validatedAt'], 10_000);
  return line;
};

const normalizeSubmittedEvidence = (payload = {}) => {
  const recommendationKeys = [
    'selectedOfferId', 'selectedOffer', 'alternatives', 'reason', 'reasons', 'explanation', 'ranking',
    'bestMatch', 'secondaryOffer', 'lowestEffectiveCost', 'version',
  ];
  const calculationKeys = [
    'id', 'calculationId', 'version', 'inputs', 'outputs', 'options', 'oldCosts', 'currentCosts',
    'monthlySavings', 'termMonths', 'explanation', 'assumptions', 'breakdown',
  ];
  const participants = (Array.isArray(payload.participants) ? payload.participants : []).slice(0, 10).map((participant) => ({
    ...pickEvidence(participant, [
      'id', 'participantId', 'subscriptionId', 'label', 'currentOperator',
      'numberHandling', 'keepNumberPreference', 'requestedActivationDate', 'activationDate', 'bindingEnd',
    ], 20_000),
    phoneNumberMask: maskSubmittedNumber(participant?.phoneNumber || participant?.number || participant?.numberPorting?.phoneNumber),
    numberPorting: typeof participant?.numberPorting === 'string'
      ? trimText(participant.numberPorting, 40)
      : pickEvidence(participant?.numberPorting, ['action', 'mode', 'currentOperator', 'bindingEnd', 'activationDate'], 10_000),
  }));
  const agreementInput = safeObject(payload.agreement, 50_000);
  const submittedPhoneNumbers = Array.isArray(payload.phoneNumbers)
    ? payload.phoneNumbers
    : (Array.isArray(payload.numberHandling?.phoneNumbers) ? payload.numberHandling.phoneNumbers : []);
  return {
    classification: 'untrusted_submitted_evidence',
    valuesTrustedForBusinessLogic: false,
    cartItems: (Array.isArray(payload.cartItems) ? payload.cartItems : []).slice(0, 25).map(normalizeEvidenceLine),
    subscriptions: (Array.isArray(payload.subscriptions) ? payload.subscriptions : []).slice(0, 25).map(normalizeEvidenceLine),
    participants,
    phoneNumbers: submittedPhoneNumbers.slice(0, 10).map((value) => maskSubmittedNumber(getPhoneValue(value))),
    portedNumbers: (Array.isArray(payload.portedNumbers) ? payload.portedNumbers : []).slice(0, 10).map((value) => maskSubmittedNumber(getPhoneValue(value))),
    questionnaire: normalizeBusinessQuestionnaire(payload.questionnaire || payload.qualification),
    recommendation: (() => {
      const recommendation = safeObject(payload.recommendation, 100_000);
      return {
        ...pickEvidence(recommendation, recommendationKeys.filter((key) => ![
          'selectedOffer', 'alternatives', 'bestMatch', 'secondaryOffer', 'lowestEffectiveCost',
        ].includes(key)), 100_000),
        selectedOffer: normalizeEvidenceLine(recommendation.selectedOffer),
        alternatives: (Array.isArray(recommendation.alternatives) ? recommendation.alternatives : []).slice(0, 25).map((entry) =>
          typeof entry === 'string' ? { planId: trimText(entry, 200) } : normalizeEvidenceLine(entry)
        ),
        bestMatch: normalizeEvidenceLine(recommendation.bestMatch),
        secondaryOffer: normalizeEvidenceLine(recommendation.secondaryOffer),
        lowestEffectiveCost: normalizeEvidenceLine(recommendation.lowestEffectiveCost),
      };
    })(),
    calculation: pickEvidence(payload.calculation, calculationKeys, 150_000),
    agreement: {
      operatorDocuments: pickEvidence(agreementInput.operatorDocuments, ['documentId', 'version', 'operator', 'planId'], 20_000),
      dealettDocuments: pickEvidence(agreementInput.dealettDocuments, ['termsVersion', 'withdrawalVersion', 'privacyVersion'], 20_000),
      consentEvidence: (() => {
        const evidence = safeObject(payload.consentEvidence || agreementInput.consentEvidence, 50_000);
        const confirmations = safeObject(evidence.confirmations, 20_000);
        return {
          ...pickEvidence(evidence, ['source', 'sessionId', 'evidenceId', 'capturedAt', 'confirmationMethod', 'locale'], 50_000),
          confirmations: Object.fromEntries(Object.entries(confirmations).slice(0, 20).map(([key, confirmation]) => [
            trimText(key, 100) || 'unknown',
            pickEvidence(confirmation, ['accepted', 'acknowledged', 'acceptedAt', 'acknowledgedAt', 'documentId', 'version'], 10_000),
          ])),
          marketingConsent: pickEvidence(evidence.marketingConsent, ['accepted', 'acceptedAt', 'channel', 'version'], 10_000),
          operatorDocuments: pickEvidence(evidence.operatorDocuments, ['documentId', 'version', 'operator', 'planId'], 20_000),
          dealettDocuments: pickEvidence(evidence.dealettDocuments, ['termsVersion', 'withdrawalVersion', 'privacyVersion'], 20_000),
        };
      })(),
    },
    source: {
      ...pickEvidence(payload.source, ['channel', 'checkoutMode', 'cartSources'], 20_000),
      checkoutPage: sanitizePageReference(payload.source?.checkoutPage),
      originatingPage: sanitizePageReference(payload.source?.originatingPage),
    },
  };
};

const findCalculatedOffer = (calculation, offerId) => [
  calculation.bestMatch,
  calculation.bestTravelFit,
  calculation.bestStreamingFit,
  calculation.secondaryOffer,
  calculation.lowestEffectiveCost,
  ...(calculation.options || []),
].filter(Boolean).find((option) => option.planId === offerId || option.id === offerId || option.sourcePlanId === offerId);

const buildAuthoritativeSnapshot = (payload = {}) => {
  const selectedOfferId = getRequestedOfferId(payload);
  const submittedCartItems = Array.isArray(payload.cartItems) ? payload.cartItems : [];
  const distinctOfferIds = new Set(submittedCartItems.map((item) => trimText(item?.offerId || item?.planId, 200)).filter(Boolean));
  if (distinctOfferIds.size > 1) {
    throw new PlatformError(
      'MULTI_OFFER_CONSENT_REQUIRED',
      'Orders containing multiple distinct offers require per-line authoritative consent support',
      409,
      { recoverable: true, offerIds: [...distinctOfferIds] }
    );
  }
  const rawQualification = payload.questionnaire || payload.qualification || payload.cartItems?.[0]?.answers?.qualification || {};
  const qualification = normalizeQualification(rawQualification);
  const calculation = calculateOfferOptions(qualification);
  let selected = calculation.readyForOffer ? findCalculatedOffer(calculation, selectedOfferId) : null;
  let productType = 'mobile';

  if (!selected) {
    const catalogPlan = getPlans().find((plan) => plan.id === selectedOfferId || plan.sourcePlanId === selectedOfferId);
    if (catalogPlan) {
      selected = {
        planId: catalogPlan.id,
        sourcePlanId: catalogPlan.sourcePlanId,
        operator: catalogPlan.operator,
        operatorId: catalogPlan.operatorId,
        title: catalogPlan.title,
        data: catalogPlan.data,
        dataAmount: catalogPlan.dataAmount,
        peopleCount: Math.max(submittedCartItems.reduce((total, item) => total + (Number(item?.persons || item?.quantity) || 0), 0) || 1, 1),
        planMonthlyPrice: Number(catalogPlan.monthlyPrice ?? catalogPlan.price),
        bindingMonths: Number(catalogPlan.bindingMonths) || 0,
        benefits: clone(catalogPlan.benefits || catalogPlan.features || []),
        includedStreamingServices: clone(catalogPlan.includedStreaming || []),
        international: clone({ roaming: catalogPlan.roaming || null, calls: catalogPlan.internationalCalls || null }),
        giftCardValue: 0,
      };
    }
  }
  if (!selected) {
    const broadband = getBroadbandPlans().find((plan) => String(plan.id) === selectedOfferId);
    if (broadband) {
      const built = buildBroadbandCartItem({ planId: broadband.id, address: payload.cartItems?.[0]?.answers?.broadbandAddress });
      selected = {
        planId: String(broadband.id),
        sourcePlanId: String(broadband.id),
        operator: broadband.operator,
        operatorId: broadband.operator.toLowerCase(),
        title: broadband.title,
        data: broadband.speed,
        peopleCount: 1,
        planMonthlyPrice: Number(broadband.price),
        bindingMonths: Number(broadband.bindingMonths) || 0,
        benefits: clone(broadband.features || []),
        giftCardValue: Number(built.cartItem.rewardTotal) || 0,
      };
      productType = 'broadband';
    }
  }
  if (!selected) {
    throw new PlatformError('OFFER_NOT_FOUND', 'The selected offer is not available in the authoritative catalogue', 409);
  }

  const monthlyPriceMinor = toMinorUnits(selected.planMonthlyPrice, 'selected offer monthly price');
  const giftCardValueMinor = toMinorUnits(selected.giftCardValue || 0, 'selected offer gift-card value');
  const normalizedOffer = {
    planId: selected.planId,
    sourcePlanId: selected.sourcePlanId || selected.planId,
    productType,
    operator: selected.operator,
    operatorId: selected.operatorId,
    title: selected.title || selected.planName,
    data: selected.data,
    dataAmount: selected.dataAmount ?? null,
    peopleCount: Number(selected.peopleCount) || 1,
    monthlyPriceMinor,
    pricePerPersonMinor: selected.pricePerPerson === null || selected.pricePerPerson === undefined
      ? Math.round(monthlyPriceMinor / (Number(selected.peopleCount) || 1))
      : toMinorUnits(selected.pricePerPerson),
    currency: 'SEK',
    bindingMonths: Number(selected.bindingMonths) || 0,
    giftCardValueMinor,
    benefits: clone(selected.benefits || []),
    includedStreamingServices: clone(selected.includedStreamingServices || []),
    international: clone(selected.international || null),
    switchAction: selected.switchAction || null,
  };
  const submittedEvidence = normalizeSubmittedEvidence(payload);
  const authoritativeLines = [{
    lineId: trimText(submittedCartItems[0]?.id || submittedCartItems[0]?.cartItemId, 200) || 'primary',
    subscriptionId: trimText(submittedCartItems[0]?.subscriptionId, 200),
    participantId: trimText(submittedCartItems[0]?.participantId, 200),
    ...clone(normalizedOffer),
  }];
  return {
    catalogVersion: 'legacy-schema-v1',
    ruleVersion: 'demo-rules-v1',
    campaignVersion: 'demo-campaign-v1',
    selectedOffer: normalizedOffer,
    authoritativeLines,
    aggregateMonthlyValueMinor: authoritativeLines.reduce((total, line) => total + line.monthlyPriceMinor, 0),
    aggregateGiftCardValueMinor: authoritativeLines.reduce((total, line) => total + line.giftCardValueMinor, 0),
    totalSubscriptionCount: authoritativeLines.reduce((total, line) => total + (Number(line.peopleCount) || 1), 0),
    alternatives: calculation.readyForOffer
      ? (calculation.options || []).filter((option) => option.planId !== selected.planId).map((option) => ({
        planId: option.planId,
        operator: option.operator,
        title: option.title,
        monthlyPriceMinor: toMinorUnits(option.planMonthlyPrice),
        currency: 'SEK',
      }))
      : [],
    qualification,
    calculation: calculation.readyForOffer ? clone(calculation) : {
      readyForOffer: false,
      missingFields: clone(qualification.missingFields),
      selectedFromAuthoritativeCatalogue: true,
    },
    calculationVersion: 'effective_monthly_cost_24_months-v1',
    commissionExpectedMinor: 0,
    commissionRuleState: 'not_configured_demo',
    sourceEvidence: {
      submittedRecommendation: clone(submittedEvidence.recommendation),
      submittedCalculation: clone(submittedEvidence.calculation),
      valuesTrustedForBusinessLogic: false,
    },
    submittedEvidence,
  };
};

const normalizeConversationSnapshot = (payload = {}) => {
  const source = Array.isArray(payload.conversationSnapshot)
    ? payload.conversationSnapshot
    : payload.conversationSnapshot?.messages;
  if (!Array.isArray(source)) return [];
  return source.slice(0, 500).map((message, index) => ({
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    content: trimText(message?.content || message?.message || message?.text, 20_000, true, `conversationSnapshot[${index}].content`),
    structuredContent: safeObject(message?.structuredContent || message?.metadata, 50_000),
    language: trimText(message?.language || payload.language, 12) || 'sv',
    clientMessageId: trimText(message?.id || message?.messageId, 200) || `compat-${index + 1}-${hashObject(message).slice(0, 16)}`,
    clientCreatedAt: safeTimestamp(message?.createdAt || message?.timestamp, `conversationSnapshot[${index}].createdAt`) || null,
    requestedSequence: Number(message?.sequence) || index + 1,
    model: trimText(message?.model, 100),
  }));
};

const RESOURCE_PERMISSIONS = Object.freeze({
  customers: 'customers.view',
  conversations: 'conversations.view',
  operators: 'catalog.view',
  rules: 'rules.view',
  campaigns: 'rules.view',
  'gift-cards': 'gift_cards.view',
  commissions: 'finance.view',
  'support-cases': 'support.view',
  communications: 'communications.view',
  analytics: 'analytics.view',
  tasks: 'tasks.view',
  documents: 'documents.view',
  integrations: 'integrations.view',
  employees: 'employees.view',
  compliance: 'compliance.view',
  settings: 'settings.view',
});

const CONSEQUENTIAL_TRANSITIONS = Object.freeze({
  order: new Set(['cancelled', 'rejected', 'completed', 'activation_reversed', 'customer_withdrew', 'duplicate']),
  operator: new Set(['cancelled', 'rejected', 'activation_reversed']),
  commission: new Set(['paid', 'clawed_back', 'reversed', 'cancelled']),
  gift_card: new Set(['delivered_mock', 'reversed', 'cancelled', 'rejected']),
});

class OperationsService {
  constructor({ repository, config, clock = () => new Date(), chatCompletion = null }) {
    this.repository = repository;
    this.config = config;
    this.clock = clock;
    this.chatCompletion = chatCompletion;
  }

  async createConversation(payload, context = {}) {
    return this.repository.createConversation({
      id: normalizeConversationId(payload.conversationId || payload.sessionId),
      token: trimText(payload.conversationToken, 500),
      customerId: payload.customerId || null,
      language: trimText(payload.language, 12) || 'sv',
      sourcePage: sanitizePageReference(payload.sourcePage || payload.page?.path),
      attribution: normalizeAttribution(payload),
    }, context);
  }

  async ensureConversation(payload, context = {}) {
    const id = normalizeConversationId(payload.conversationId || payload.sessionId);
    if (!id) return this.createConversation(payload, context);
    try {
      const token = trimText(payload.conversationToken, 500);
      return {
        conversation: await this.repository.getConversation(id, { token, requireToken: true }),
        token,
        existing: true,
      };
    } catch (error) {
      if (error.code !== 'CONVERSATION_NOT_FOUND') throw error;
      return this.createConversation({ ...payload, conversationId: id }, context);
    }
  }

  async appendConversationMessage(conversationId, payload, context = {}) {
    return this.repository.appendConversationMessage(normalizeConversationId(conversationId), {
      role: payload.role,
      content: trimText(payload.content || payload.message, 20_000, true, 'message'),
      structuredContent: safeObject(payload.structuredContent, 50_000),
      language: trimText(payload.language, 12),
      model: trimText(payload.model, 100),
      clientMessageId: trimText(payload.clientMessageId || payload.id, 200),
      clientCreatedAt: safeTimestamp(payload.clientCreatedAt || payload.createdAt, 'clientCreatedAt'),
      requestedSequence: payload.sequence === undefined ? null : Number(payload.sequence),
      relatedMessageId: trimText(payload.relatedMessageId, 200),
    }, context);
  }

  async persistChatExchange(requestPayload, result, context = {}) {
    const turn = await this.beginChatTurn(requestPayload, context);
    const assistantRecord = await this.completeChatTurn(turn, result, context);
    return {
      conversationId: turn.conversationId,
      user: turn.user,
      assistant: assistantRecord.message,
      conversationToken: turn.conversationToken,
    };
  }

  async beginChatTurn(requestPayload, context = {}) {
    const ensured = await this.ensureConversation({
      ...requestPayload,
      conversationToken: requestPayload.conversationToken,
    }, context);
    const conversationId = ensured.conversation.id;
    const client = safeObject(requestPayload.clientMessage);
    if (!ensured.existing) {
      const priorMessages = normalizePriorChatMessages(requestPayload);
      for (const priorMessage of priorMessages) {
        await this.appendConversationMessage(conversationId, priorMessage, {
          ...context,
          token: ensured.token,
        });
      }
    }
    const userRecord = await this.appendConversationMessage(conversationId, {
      role: 'user',
      content: requestPayload.message,
      id: client.id,
      sequence: client.sequence,
      createdAt: client.createdAt,
      language: requestPayload.language,
      structuredContent: { page: safeObject(requestPayload.page), source: 'legacy_chat_route' },
    }, { ...context, token: ensured.token || null });
    return {
      conversationId,
      conversationToken: ensured.token || requestPayload.conversationToken || null,
      user: userRecord.message,
    };
  }

  async completeChatTurn(turn, result, context = {}) {
    return this.appendConversationMessage(turn.conversationId, {
      role: 'assistant',
      content: result.message || result.reply,
      language: result.language,
      model: result.model,
      relatedMessageId: turn.user.id,
      structuredContent: {
        offerCards: clone(result.offerCards || []),
        embeddedWidget: clone(result.embeddedWidget || null),
        qualification: clone(result.qualification || null),
        flowState: clone(result.flowState || null),
        offerCalculation: clone(result.offerCalculation || null),
        source: result.source,
      },
    }, { ...context, token: turn.conversationToken });
  }

  async createQuote(payload, context = {}) {
    const snapshot = buildAuthoritativeSnapshot(payload);
    const expiresAt = new Date(this.clock().getTime() + 30 * 60_000).toISOString();
    return this.repository.createQuote({
      selectedOfferId: snapshot.selectedOffer.planId,
      snapshot,
      snapshotHash: hashObject(snapshot),
      expiresAt,
      mode: this.config.demoMode ? 'demo' : 'live',
    }, context);
  }

  async createOrder(payload, idempotencyKey, context = {}) {
    assertPlatform(IDEMPOTENCY_PATTERN.test(String(idempotencyKey || '')), 'IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    if (!this.config.demoMode && context.identityVerification?.backendVerified !== true) {
      throw new PlatformError(
        'IDENTITY_VERIFICATION_REQUIRED',
        'Live order capture requires a backend-verified identity and consent result',
        409
      );
    }
    if (!this.config.demoMode && (
      context.consentVerification?.backendVerified !== true ||
      !Array.isArray(context.consentVerification?.consents) ||
      context.consentVerification.consents.length === 0
    )) {
      throw new PlatformError(
        'CONSENT_VERIFICATION_REQUIRED',
        'Live order capture requires backend-verified registered consent documents',
        409
      );
    }
    const customer = normalizeCustomer(payload, {
      demoMode: this.config.demoMode,
      identityVerification: context.identityVerification,
    });
    const consentPayload = this.config.demoMode
      ? payload
      : { consents: context.consentVerification.consents };
    let consents = normalizeConsents(consentPayload);
    if (this.config.demoMode) {
      consents = consents.map((consent) => ({
        ...consent,
        evidence: { ...consent.evidence, source: 'demo_client_fixture', simulated: true },
      }));
    }
    if (!this.config.demoMode) {
      assertPlatform(consents.every((consent, index) =>
        context.consentVerification.consents[index]?.registeredDocument === true && Boolean(consent.documentId) && Boolean(consent.textHash)
      ), 'CONSENT_VERIFICATION_REQUIRED', 'Live consent evidence must reference verified registered document versions and hashes', 409);
    }
    let quote;
    if (payload.quoteId) {
      quote = await this.repository.getQuote(payload.quoteId);
    } else {
      quote = await this.createQuote(payload, context);
    }
    const participants = normalizeParticipants(payload, { peopleCount: quote.snapshot.totalSubscriptionCount || quote.snapshot.selectedOffer.peopleCount });
    const transcript = getTranscriptEnvelope(payload);
    const snapshotMessages = transcript.messages;
    let archiveConversationToken = trimText(payload.conversationToken, 500);
    const requestedConversationId = normalizeConversationId(payload.conversationId || payload.sessionId || payload.agreement?.sessionId);
    const conversationId = requestedConversationId && (archiveConversationToken || snapshotMessages.length || transcript.transcriptTruncated)
      ? requestedConversationId
      : null;
    if (conversationId && (snapshotMessages.length || transcript.transcriptTruncated)) {
      let ensured;
      if (transcript.transcriptTruncated) {
        try {
          ensured = {
            conversation: await this.repository.getConversation(conversationId, {
              token: archiveConversationToken,
              requireToken: true,
            }),
            token: archiveConversationToken,
            existing: true,
          };
        } catch (error) {
          if (error.code !== 'CONVERSATION_NOT_FOUND') throw error;
          throw new PlatformError('CONVERSATION_ARCHIVE_INCOMPLETE', 'A truncated conversation snapshot cannot create an archival source', 409, {
            recoverable: true,
            expectedMessageCount: transcript.expectedMessageCount,
            droppedMessageCount: transcript.droppedMessageCount,
          });
        }
      } else {
        ensured = await this.ensureConversation({
          conversationId,
          conversationToken: archiveConversationToken,
          language: payload.language,
          sourcePage: payload.sourcePage,
          attribution: payload.attribution,
        }, context);
      }
      archiveConversationToken = ensured.token;
      const current = await this.repository.getConversation(ensured.conversation.id, {
        token: archiveConversationToken,
        requireToken: true,
      });
      const currentMessages = [...current.messages].sort((left, right) => left.sequence - right.sequence);
      currentMessages.forEach((message, index) => {
        if (message.sequence !== index + 1 || !message.createdAt) {
          throw new PlatformError('CONVERSATION_ARCHIVE_INCOMPLETE', 'The server conversation transcript is not contiguous', 409, {
            recoverable: true,
            expectedSequence: index + 1,
            receivedSequence: message.sequence,
          });
        }
      });
      if (transcript.transcriptTruncated && currentMessages.length < transcript.expectedMessageCount) {
        throw new PlatformError('CONVERSATION_ARCHIVE_INCOMPLETE', 'The submitted conversation snapshot is truncated and the complete server transcript is unavailable', 409, {
          recoverable: true,
          serverMessageCount: currentMessages.length,
          expectedMessageCount: transcript.expectedMessageCount,
          droppedMessageCount: transcript.droppedMessageCount,
        });
      }
      for (const message of snapshotMessages.sort((left, right) => left.requestedSequence - right.requestedSequence)) {
        const existing = currentMessages[message.requestedSequence - 1];
        if (existing) {
          if (existing.role !== message.role || existing.content !== message.content) {
            throw new PlatformError('CONVERSATION_ARCHIVE_MISMATCH', 'The submitted conversation snapshot does not match the server transcript', 409, {
              recoverable: true,
              sequence: message.requestedSequence,
            });
          }
          continue;
        }
        if (transcript.transcriptTruncated) {
          throw new PlatformError('CONVERSATION_ARCHIVE_INCOMPLETE', 'A truncated snapshot cannot be used to fill gaps in the server transcript', 409, {
            recoverable: true,
            sequence: message.requestedSequence,
          });
        }
        const appended = await this.repository.appendConversationMessage(ensured.conversation.id, message, {
          ...context,
          token: ensured.token,
        });
        currentMessages.push(appended.message);
      }
    }
    const attribution = normalizeAttribution(payload);
    const identityEvidence = this.config.demoMode ? safeObject(payload.bankId, 20_000) : safeObject(context.identityVerification, 20_000);
    const safeTechnicalMetadata = {
      checkoutSessionId: trimText(payload.checkoutSessionId || payload.agreement?.sessionId, 200),
      clientOrderId: trimText(payload.orderId || payload.agreement?.orderId, 200),
      bankId: {
        simulated: this.config.demoMode,
        orderRef: trimText(identityEvidence.orderRef, 200),
        signatureId: trimText(identityEvidence.signatureId, 200),
        signedAt: safeTimestamp(identityEvidence.signedAt, 'bankId.signedAt'),
        verifiedByBackend: context.identityVerification?.backendVerified === true,
        verificationAdapter: context.identityVerification?.adapter || (this.config.demoMode ? 'demo_mock' : null),
      },
      ipAddressStored: false,
      deviceIdentifierStored: false,
    };
    const requestForHash = {
      customer,
      participants,
      consents,
      quoteSnapshotHash: quote.snapshotHash,
      conversationId,
      attribution,
      clientOrderId: safeTechnicalMetadata.clientOrderId,
    };
    return this.repository.createOrderAtomic({
      idempotencyKey,
      requestHash: hashObject(requestForHash),
      quoteId: quote.id,
      customer,
      participants,
      consents,
      conversationId,
      conversationToken: archiveConversationToken || null,
      attribution,
      safeTechnicalMetadata,
    }, context);
  }

  async listOrders(actor, query) {
    requirePermission(actor, 'orders.view');
    const result = await this.repository.listOrders({
      actor,
      filters: {
        search: query.get('search'),
        status: query.get('status'),
        operator: query.get('operator'),
        commissionStatus: query.get('commissionStatus'),
        giftCardStatus: query.get('giftCardStatus'),
      },
      page: query.get('page'),
      pageSize: query.get('pageSize'),
    });
    return { ...result, items: result.items.map((order) => projectOrderForActor(order, actor)) };
  }

  async getOrder(actor, id) {
    requirePermission(actor, 'orders.view');
    return projectOrderForActor(await this.repository.getOrder(id, actor), actor);
  }

  async transitionOrder(actor, id, payload, context = {}) {
    const machine = trimText(payload.machine, 40, true, 'machine');
    const permission = machine === 'commission'
      ? 'finance.transition'
      : (machine === 'gift_card' ? 'gift_cards.transition' : 'orders.transition');
    requirePermission(actor, permission);
    if (actor.actorType === 'partner' && machine !== 'operator') {
      throw new PlatformError('FORBIDDEN', 'Partner users may update only operator processing status', 403);
    }
    const targetState = trimText(payload.to || payload.status, 80, true, 'status');
    if (CONSEQUENTIAL_TRANSITIONS[machine]?.has(targetState) && payload.confirmed !== true) {
      throw new PlatformError('CONFIRMATION_REQUIRED', 'This consequential transition requires confirmed=true', 409, {
        machine,
        targetState,
      });
    }
    const order = await this.repository.transitionOrder(id, {
      machine,
      to: targetState,
      reason: trimText(payload.reason, 500, true, 'reason'),
      note: trimText(payload.note, 2_000),
      expectedVersion: Number(payload.version),
      amountMinor: payload.amount === undefined ? null : toMinorUnits(payload.amount, 'transition amount', { allowNegative: true }),
    }, { ...context, actor });
    return projectOrderForActor(order, actor);
  }

  generateReport(actor, id, context = {}) {
    requirePermission(actor, 'orders.report');
    requirePermission(actor, 'sensitive_data.view');
    return this.repository.createReport(id, { ...context, actor });
  }

  getReport(actor, id) {
    requirePermission(actor, 'documents.view');
    requirePermission(actor, 'sensitive_data.view');
    return this.repository.getReport(id, actor);
  }

  async exportOrdersCsv(actor, query) {
    requirePermission(actor, actor.actorType === 'partner' ? 'finance.export' : 'orders.export');
    const page = await this.repository.listOrders({ actor, filters: { status: query.get('status'), operator: query.get('operator') }, page: 1, pageSize: 100 });
    const columns = ['orderNumber', 'createdAt', 'customer', 'email', 'operator', 'plan', 'subscriptions', 'monthlyValueMinor', 'giftCardValueMinor', 'status', 'operatorStatus', 'commissionStatus'];
    const rows = page.items.map((entry) => projectOrderForActor(entry, actor)).map((order) => [
      order.orderNumber,
      order.createdAt,
      order.customer.displayName,
      order.customer.email,
      order.operator,
      order.planName,
      order.subscriptionCount,
      order.monthlyValueMinor,
      order.giftCardValueMinor,
      order.status,
      order.operatorStatus,
      order.commissionStatus,
    ]);
    return [columns, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n') + '\n';
  }

  getDashboard(actor) {
    requirePermission(actor, 'overview.view');
    return this.repository.getDashboard(actor);
  }

  listAudit(actor, query) {
    requirePermission(actor, 'audit.view');
    return this.repository.listAudit({ objectType: query.get('objectType'), actorId: query.get('actorId'), limit: query.get('limit'), actor });
  }

  async listResource(actor, name) {
    const permission = RESOURCE_PERMISSIONS[name];
    if (!permission) throw new PlatformError('RESOURCE_NOT_FOUND', 'Admin resource not found', 404);
    requirePermission(actor, permission);
    const items = clone(await this.repository.listResource(name, actor));
    const mayViewSensitive = actor?.permissions?.includes('sensitive_data.view');
    return items.map((item) => {
      if (name === 'customers') {
        return {
          id: item.id,
          displayName: item.displayName || item.display_name,
          language: item.language || item.preferred_language,
          classification: item.classification,
          createdAt: item.createdAt || item.created_at,
          email: item.email ? (mayViewSensitive ? item.email : maskEmail(item.email)) : (item.emailMask || null),
          phone: item.phone ? (mayViewSensitive ? item.phone : maskPhone(item.phone)) : (item.phoneMask || null),
        };
      }
      if (name === 'conversations' && !mayViewSensitive) {
        delete item.attribution;
        delete item.qualification;
        delete item.flowState;
        delete item.messages;
      }
      if (!mayViewSensitive) {
        delete item.evidence;
        delete item.consentEvidence;
        delete item.email;
        delete item.phone;
        delete item.contact;
      }
      return item;
    });
  }

  simulateIntegration(actor, slug, payload, context = {}) {
    requirePermission(actor, 'integrations.test_mock');
    assertPlatform(this.config.demoMode, 'MOCK_ONLY', 'Integration simulations are available only in demo mode', 409);
    return this.repository.simulateIntegration(slug, trimText(payload.action, 100) || 'simulate-success', { ...context, actor });
  }
}

module.exports = {
  OperationsService,
  buildAuthoritativeSnapshot,
  normalizeConsents,
  normalizeConversationId,
  normalizeConversationSnapshot,
  normalizeCustomer,
  normalizeParticipants,
};
