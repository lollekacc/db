const crypto = require('node:crypto');

const createFieldCrypto = (base64Key) => {
  const key = Buffer.from(String(base64Key || ''), 'base64');
  if (key.length !== 32) throw new Error('A 32-byte data encryption key is required');

  const encrypt = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', nonce.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
  };

  const decrypt = (value) => {
    if (!value) return null;
    const [version, nonceValue, tagValue, encryptedValue] = String(value).split('.');
    if (version !== 'v1' || !nonceValue || !tagValue || !encryptedValue) throw new Error('Encrypted field has an unsupported format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonceValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  };

  return Object.freeze({ encrypt, decrypt });
};

module.exports = {
  createFieldCrypto,
};
