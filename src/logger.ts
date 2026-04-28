/**
 * Centralised logger. Pino + a child logger for HTTP requests.
 * Logs to stderr by default (so stdio transport stays clean).
 */

import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  // Pretty in dev, JSON in prod.
  ...(process.env.NODE_ENV !== 'production'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 2 }, // stderr
        },
      }
    : {}),
});
