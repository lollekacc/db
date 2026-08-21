const fs = require('node:fs');
const { getDataFilePath, writeJsonAtomic } = require('./data-storage');

const getSubscriberFile = () => getDataFilePath('newsletter-subscribers.json');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const readSubscribers = () => {
  const subscriberFile = getSubscriberFile();
  if (!fs.existsSync(subscriberFile)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(subscriberFile, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

const writeSubscribers = (subscribers) => {
  writeJsonAtomic(getSubscriberFile(), subscribers);
};

const subscribeToNewsletter = ({ email, source = 'homepage' } = {}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    const error = new Error('Invalid email address');
    error.statusCode = 400;
    throw error;
  }

  const subscribers = readSubscribers();
  const existing = subscribers.find((subscriber) => subscriber.email === normalizedEmail);

  if (existing) {
    return {
      ok: true,
      duplicate: true,
      subscriber: existing,
    };
  }

  const subscriber = {
    email: normalizedEmail,
    source: String(source || 'homepage').trim().slice(0, 80) || 'homepage',
    createdAt: new Date().toISOString(),
  };

  subscribers.push(subscriber);
  writeSubscribers(subscribers);

  return {
    ok: true,
    duplicate: false,
    subscriber,
  };
};

module.exports = {
  subscribeToNewsletter,
};
