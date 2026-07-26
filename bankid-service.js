const crypto = require('node:crypto');

const sessions = new Map();
const COMPLETE_AFTER_MS = 4200;
const EXPIRE_AFTER_MS = 120000;

const createId = (prefix) => `${prefix}-${crypto.randomBytes(16).toString('hex')}`;

const cleanExpiredSessions = () => {
  const now = Date.now();
  sessions.forEach((session, orderRef) => {
    if (now - session.createdAt > EXPIRE_AFTER_MS) sessions.delete(orderRef);
  });
};

const normalizeIntent = (intent) => {
  if (intent === 'sign') return 'sign';
  return 'login';
};

const getHintCode = (elapsedMs) => {
  if (elapsedMs < 1200) return 'outstandingTransaction';
  if (elapsedMs < 2800) return 'userSign';
  return 'started';
};

const buildCompletion = (session) => {
  const user = {
    name: 'BankID Kund',
    givenName: 'BankID',
    surname: 'Kund',
    personalNumberMasked: '19******-****',
  };

  return {
    status: 'complete',
    intent: session.intent,
    simulated: true,
    orderRef: session.orderRef,
    user,
    signature: session.intent === 'sign'
      ? {
        id: createId('sig'),
        signedAt: new Date().toISOString(),
        text: session.userVisibleData || 'Dealett beställning signerad med BankID.',
      }
      : null,
  };
};

const startBankIdSession = ({ intent, userVisibleData, payload } = {}) => {
  cleanExpiredSessions();

  const normalizedIntent = normalizeIntent(intent);
  const orderRef = createId('order');
  const session = {
    orderRef,
    intent: normalizedIntent,
    userVisibleData: String(userVisibleData || ''),
    payload: payload || {},
    createdAt: Date.now(),
    completed: false,
  };

  sessions.set(orderRef, session);

  return {
    orderRef,
    autoStartToken: createId('autostart'),
    status: 'pending',
    hintCode: 'outstandingTransaction',
    simulated: true,
    message: normalizedIntent === 'sign'
      ? 'Öppna BankID och signera beställningen.'
      : 'Öppna BankID för att logga in.',
  };
};

const collectBankIdSession = ({ orderRef } = {}) => {
  cleanExpiredSessions();

  const session = sessions.get(orderRef);
  if (!session) {
    const error = new Error('BankID-sessionen hittades inte eller har gått ut.');
    error.statusCode = 404;
    throw error;
  }

  const elapsedMs = Date.now() - session.createdAt;
  if (elapsedMs >= COMPLETE_AFTER_MS) {
    session.completed = true;
    sessions.delete(orderRef);
    return buildCompletion(session);
  }

  return {
    status: 'pending',
    intent: session.intent,
    simulated: true,
    orderRef,
    hintCode: getHintCode(elapsedMs),
    message: session.intent === 'sign'
      ? 'Väntar på signering i BankID.'
      : 'Väntar på inloggning i BankID.',
  };
};

const cancelBankIdSession = ({ orderRef } = {}) => {
  if (orderRef) sessions.delete(orderRef);

  return {
    status: 'cancelled',
    orderRef,
  };
};

module.exports = {
  cancelBankIdSession,
  collectBankIdSession,
  startBankIdSession,
};
