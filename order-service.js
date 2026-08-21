const fs = require('node:fs');
const { getDataFilePath, writeJsonAtomic } = require('./data-storage');

const getOrderFile = () => getDataFilePath('checkout-orders.json');
const MAX_STORED_ORDERS = 500;

const readOrders = () => {
  const orderFile = getOrderFile();
  if (!fs.existsSync(orderFile)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeOrders = (orders) => {
  writeJsonAtomic(getOrderFile(), orders.slice(-MAX_STORED_ORDERS));
};

const requireText = (value, label) => {
  const normalized = String(value || '').trim().slice(0, 500);
  if (!normalized) {
    const error = new Error(`${label} saknas i beställningen.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
};

const optionalText = (value, maxLength = 1000) => {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
};

const optionalNumber = (value) => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};

const requireTimestamp = (value, label) => {
  const timestamp = requireText(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    const error = new Error(`${label} är inte en giltig tidsstämpel.`);
    error.statusCode = 400;
    throw error;
  }
  return timestamp;
};

const requireAcceptedConfirmations = (confirmations = {}) => {
  const required = [
    confirmations.operatorAgreement?.accepted,
    confirmations.dealettTerms?.accepted,
    confirmations.withdrawalInformation?.accepted,
    confirmations.privacyPolicy?.acknowledged,
  ];

  if (!required.every(Boolean)) {
    const error = new Error('Alla obligatoriska bekräftelser måste vara registrerade.');
    error.statusCode = 400;
    throw error;
  }

  requireTimestamp(confirmations.operatorAgreement?.acceptedAt, 'Tidpunkt för operatörsavtalet');
  requireTimestamp(confirmations.dealettTerms?.acceptedAt, 'Tidpunkt för Dealetts villkor');
  requireTimestamp(confirmations.withdrawalInformation?.acceptedAt, 'Tidpunkt för ångerrättsinformationen');
  requireTimestamp(confirmations.privacyPolicy?.acknowledgedAt, 'Tidpunkt för integritetspolicyn');
};

const sanitizePricePeriods = (periods) => (
  Array.isArray(periods)
    ? periods.slice(0, 12).map((period) => ({
      fromMonth: optionalNumber(period?.fromMonth),
      toMonth: optionalNumber(period?.toMonth),
      monthlyPrice: optionalNumber(period?.monthlyPrice),
      label: optionalText(period?.label, 100),
    }))
    : []
);

const sanitizeDocuments = (documents = {}) => ({
  agreementSummaryUrl: optionalText(documents.agreementSummaryUrl),
  fullAgreementUrl: optionalText(documents.fullAgreementUrl),
  generalTermsUrl: optionalText(documents.generalTermsUrl),
  specialTermsUrl: optionalText(documents.specialTermsUrl),
  priceListUrl: optionalText(documents.priceListUrl),
  withdrawalInformationUrl: optionalText(documents.withdrawalInformationUrl),
  version: optionalText(documents.version, 100),
  documentId: optionalText(documents.documentId, 200),
});

const sanitizeDealettDocuments = (documents = {}) => ({
  mediationAndGiftCardTermsUrl: optionalText(documents.mediationAndGiftCardTermsUrl),
  privacyPolicyUrl: optionalText(documents.privacyPolicyUrl),
  withdrawalInformationUrl: optionalText(documents.withdrawalInformationUrl),
  termsVersion: optionalText(documents.termsVersion, 100),
  privacyVersion: optionalText(documents.privacyVersion, 100),
  withdrawalVersion: optionalText(documents.withdrawalVersion, 100),
});

const sanitizeAgreement = (agreement = {}) => {
  const orderId = requireText(agreement.orderId, 'Order-ID');
  const sessionId = requireText(agreement.sessionId, 'Sessions-ID');
  const operatorName = requireText(agreement.operator?.name, 'Operatör');
  const subscriptionName = requireText(agreement.subscription?.name, 'Abonnemang');
  const currentMonthlyPrice = Number(agreement.pricing?.currentMonthlyPrice);

  if (!Number.isFinite(currentMonthlyPrice) || currentMonthlyPrice <= 0) {
    const error = new Error('Ett giltigt månadspris saknas i beställningen.');
    error.statusCode = 400;
    throw error;
  }

  requireAcceptedConfirmations(agreement.confirmations);
  const operatorDocuments = sanitizeDocuments(agreement.operatorDocuments);
  const dealettDocuments = sanitizeDealettDocuments(agreement.dealettDocuments);

  requireText(operatorDocuments.documentId, 'Operatörens dokument-ID');
  requireText(operatorDocuments.version, 'Operatörens dokumentversion');
  requireText(dealettDocuments.termsVersion, 'Version för Dealetts villkor');

  return {
    orderId,
    sessionId,
    operator: {
      name: operatorName,
      slug: String(agreement.operator?.slug || ''),
    },
    subscription: {
      offerId: optionalText(agreement.subscription?.offerId, 200),
      name: subscriptionName,
      data: optionalText(agreement.subscription?.data, 200),
    },
    pricing: {
      currentMonthlyPrice,
      laterMonthlyPrice: optionalNumber(agreement.pricing?.laterMonthlyPrice),
      pricePeriods: sanitizePricePeriods(agreement.pricing?.pricePeriods),
      bindingMonths: optionalNumber(agreement.pricing?.bindingMonths),
      noticePeriodMonths: optionalNumber(agreement.pricing?.noticePeriodMonths),
      startFee: optionalNumber(agreement.pricing?.startFee),
      invoiceFee: optionalNumber(agreement.pricing?.invoiceFee),
      invoiceFeeOptional: Boolean(agreement.pricing?.invoiceFeeOptional),
      minimumTotalCost: optionalNumber(agreement.pricing?.minimumTotalCost),
    },
    startDate: optionalText(agreement.startDate, 100),
    numberHandling: {
      type: optionalText(agreement.numberHandling?.type, 100),
      lineCount: optionalNumber(agreement.numberHandling?.lineCount),
      transferredNumberCount: optionalNumber(agreement.numberHandling?.transferredNumberCount),
    },
    giftCards: Array.isArray(agreement.giftCards)
      ? agreement.giftCards.slice(0, 20).map((gift) => ({
        provider: optionalText(gift?.provider, 200),
        value: optionalNumber(gift?.value),
        suppliedBy: optionalText(gift?.suppliedBy, 100),
      }))
      : [],
    operatorDocuments,
    dealettDocuments,
    confirmations: {
      operatorAgreement: {
        accepted: true,
        acceptedAt: requireTimestamp(
          agreement.confirmations.operatorAgreement.acceptedAt,
          'Tidpunkt för operatörsavtalet'
        ),
      },
      dealettTerms: {
        accepted: true,
        acceptedAt: requireTimestamp(
          agreement.confirmations.dealettTerms.acceptedAt,
          'Tidpunkt för Dealetts villkor'
        ),
      },
      withdrawalInformation: {
        accepted: true,
        acceptedAt: requireTimestamp(
          agreement.confirmations.withdrawalInformation.acceptedAt,
          'Tidpunkt för ångerrättsinformationen'
        ),
      },
      privacyPolicy: {
        acknowledged: true,
        acknowledgedAt: requireTimestamp(
          agreement.confirmations.privacyPolicy.acknowledgedAt,
          'Tidpunkt för integritetspolicyn'
        ),
      },
    },
    marketingConsent: {
      accepted: Boolean(agreement.marketingConsent?.accepted),
      recordedAt: agreement.marketingConsent?.accepted
        ? requireTimestamp(agreement.marketingConsent.recordedAt, 'Tidpunkt för marknadssamtycke')
        : optionalText(agreement.marketingConsent?.recordedAt, 100),
    },
    finalSubmissionTimestamp: requireTimestamp(
      agreement.finalSubmissionTimestamp,
      'Tidpunkt för beställningen'
    ),
    testMode: Boolean(agreement.testMode),
  };
};

const storeCheckoutOrder = (payload = {}) => {
  const agreement = sanitizeAgreement(payload.agreement);
  const orders = readOrders();
  const existing = orders.find((order) => order.orderId === agreement.orderId);

  if (existing) {
    return {
      ok: true,
      duplicate: true,
      orderReference: existing.orderReference,
      status: existing.status,
    };
  }

  const storedAt = new Date().toISOString();
  const orderReference = agreement.orderId;
  const status = payload.testMode || agreement.testMode
    ? 'development_signed'
    : 'submitted';
  const record = {
    orderReference,
    orderId: agreement.orderId,
    status,
    testMode: Boolean(payload.testMode || agreement.testMode),
    storedAt,
    agreement,
    bankId: {
      simulated: Boolean(payload.bankId?.simulated),
      orderRef: payload.bankId?.orderRef || null,
      signatureId: payload.bankId?.signatureId || null,
      signedAt: payload.bankId?.signedAt || null,
    },
  };

  orders.push(record);
  writeOrders(orders);

  return {
    ok: true,
    duplicate: false,
    orderReference,
    status,
    storedAt,
  };
};

module.exports = {
  storeCheckoutOrder,
};
