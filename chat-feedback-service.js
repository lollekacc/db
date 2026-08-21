const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataFilePath } = require('./data-storage');

const allowedFeedbackThumbs = new Set(['up', 'down']);
const allowedEventTypes = new Set(['feedback', 'offer_click']);

const getFeedbackFilePath = () => (
  process.env.CHAT_FEEDBACK_FILE || getDataFilePath('chat-feedback', 'chat-feedback.jsonl')
);

const trimText = (value, maxLength) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const normalizeBoolean = (value) => value === true;

const createFeedbackError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const normalizeChatFeedback = (payload = {}) => {
  const eventType = trimText(payload.eventType, 40) || 'feedback';
  if (!allowedEventTypes.has(eventType)) {
    throw createFeedbackError('Invalid feedback event type');
  }

  const thumb = trimText(payload.thumb, 20);
  if (eventType === 'feedback' && !allowedFeedbackThumbs.has(thumb)) {
    throw createFeedbackError('Feedback thumb must be up or down');
  }
  if (thumb && !allowedFeedbackThumbs.has(thumb)) {
    throw createFeedbackError('Invalid feedback thumb');
  }

  const sessionId = trimText(payload.sessionId || payload.transcriptId, 140);
  const transcriptId = trimText(payload.transcriptId || payload.sessionId, 140);
  if (!sessionId && eventType === 'feedback') {
    throw createFeedbackError('Feedback sessionId is required');
  }

  return {
    id: crypto.randomUUID(),
    eventType,
    timestamp: new Date().toISOString(),
    sessionId,
    transcriptId,
    thumb: thumb || null,
    feedbackText: trimText(payload.feedbackText, 1000),
    lastDetectedIntent: trimText(payload.lastDetectedIntent || payload.intent, 100),
    lastDetectedStyle: trimText(payload.lastDetectedStyle || payload.style, 100),
    offerShown: normalizeBoolean(payload.offerShown),
    offerClicked: normalizeBoolean(payload.offerClicked) || eventType === 'offer_click',
    finalBotRecommendation: trimText(payload.finalBotRecommendation, 1400),
    clickedOfferId: trimText(payload.clickedOfferId, 120),
    pagePath: trimText(payload.pagePath || payload.page?.path, 240),
    pageTitle: trimText(payload.pageTitle || payload.page?.title, 240),
    source: 'dealett-chat',
  };
};

const appendChatFeedback = (payload) => {
  const record = normalizeChatFeedback(payload);
  const feedbackFile = getFeedbackFilePath();

  fs.mkdirSync(path.dirname(feedbackFile), { recursive: true });
  fs.appendFileSync(feedbackFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });

  return {
    ok: true,
    id: record.id,
    timestamp: record.timestamp,
  };
};

module.exports = {
  appendChatFeedback,
  getFeedbackFilePath,
  normalizeChatFeedback,
};
