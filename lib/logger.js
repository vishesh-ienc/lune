'use strict';

const isDebug = process.env.LUNE_DEBUG === '1' || process.env.DEBUG === '1';

const logger = {
  debug: (...args) => {
    if (isDebug) {
      console.log('[DEBUG]', ...args);
    }
  },
  info: (...args) => {
    if (isDebug) {
      console.log('[INFO]', ...args);
    }
  },
  warn: (...args) => {
    console.warn('[WARN]', ...args);
  },
  error: (...args) => {
    console.error('[ERROR]', ...args);
  },
  isDebug: () => isDebug,
};

module.exports = logger;
