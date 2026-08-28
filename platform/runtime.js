const { createChatCompletion } = require('../chat-service');
const { loadPlatformConfig } = require('./config');
const { createFieldCrypto } = require('./field-crypto');
const { MemoryOperationsRepository } = require('./memory-repository');
const { PostgresOperationsRepository } = require('./postgres-repository');
const { RollingWindowRateLimiter } = require('./rate-limiter');
const { OperationsService } = require('./service');

const createPlatformRuntime = (options = {}) => {
  const config = options.config || loadPlatformConfig(options.environment || process.env);
  let repository = options.repository;
  if (!repository) {
    if (config.repository === 'memory') {
      repository = new MemoryOperationsRepository(options.memoryOptions);
    } else {
      repository = new PostgresOperationsRepository({
        connectionString: config.databaseUrl,
        ssl: config.databaseSsl,
        demoMode: config.demoMode,
        fieldCrypto: createFieldCrypto(
          config.encryptionKey || (config.demoMode ? Buffer.alloc(32, 7).toString('base64') : null)
        ),
      });
    }
  }
  const service = options.service || new OperationsService({
    repository,
    config,
    clock: options.clock,
    chatCompletion: options.chatCompletion || createChatCompletion,
  });
  return {
    config,
    repository,
    service,
    limiter: options.limiter || new RollingWindowRateLimiter(),
  };
};

module.exports = {
  createPlatformRuntime,
};
