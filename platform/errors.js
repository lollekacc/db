class PlatformError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const assertPlatform = (condition, code, message, statusCode = 400, details = null) => {
  if (!condition) throw new PlatformError(code, message, statusCode, details);
};

module.exports = {
  PlatformError,
  assertPlatform,
};
