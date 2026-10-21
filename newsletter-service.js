const fs = require('node:fs');
const { getDataFilePath, writeJsonAtomic } = require('./data-storage');

const getSubscriberFile = () => getDataFilePath('newsletter-subscribers.json');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const getNewsletterStatus = () => ({ enabled: process.env.NEWSLETTER_SIGNUP_ENABLED === 'true' });

const readSubscribers = () => {
  const subscriberFile = getSubscriberFile();
  if (!fs.existsSync(subscriberFile)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(subscriberFile, 'utf8'));
    if (!Array.isArray(data)) throw new Error('Invalid subscriber storage');
    return data;
  } catch {
    throw Object.assign(new Error('Subscriber storage unavailable'), { statusCode: 503 });
  }
};

const writeSubscribers = (subscribers) => {
  writeJsonAtomic(getSubscriberFile(), subscribers);
};

const subscribeToNewsletter = ({ email, source = 'homepage', consent } = {}) => {
  if (!getNewsletterStatus().enabled) {
    throw Object.assign(new Error('Newsletter registration is unavailable'), { statusCode: 503 });
  }
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (normalizedEmail.length > 254 || !EMAIL_PATTERN.test(normalizedEmail) || consent !== true) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  const subscribers = readSubscribers();
  const existing = subscribers.find((subscriber) => subscriber.email === normalizedEmail);
  const receipt = { ok: true, simulated: process.env.DEMO_MODE === 'true' };

  if (existing) {
    return receipt;
  }

  const subscriber = {
    email: normalizedEmail,
    source: String(source || 'homepage').trim().slice(0, 80) || 'homepage',
    createdAt: new Date().toISOString(),
    consent: { purpose: 'newsletter', version: '2026-10-21', granted: true },
  };

  subscribers.push(subscriber);
  writeSubscribers(subscribers);

  return receipt;
};

module.exports = {
  getNewsletterStatus,
  subscribeToNewsletter,
};
