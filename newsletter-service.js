const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, 'data', 'newsletter-subscribers.json');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const readSubscribers = () => {
  if (!fs.existsSync(DATA_FILE)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
};

const writeSubscribers = (subscribers) => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, `${JSON.stringify(subscribers, null, 2)}\n`);
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
