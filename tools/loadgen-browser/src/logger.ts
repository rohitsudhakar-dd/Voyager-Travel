/**
 * Structured JSON logging against the shared schema (05-FUNCTIONALITY.md
 * § 12), the same as every other Node process in the repository.
 *
 * These lines are deliberately excluded from Datadog log collection by the
 * container label in docker-compose.loadgen.yml -- a generator's own chatter
 * is not worth indexing. They still follow the schema, because the operator
 * reading `docker compose logs loadgen-browser` at 9pm before a demo should
 * not have to learn a second log format.
 *
 * Rule 2 of the schema matters most here: `message` is a constant per log
 * site, and everything variable goes into structured fields.
 */

import pino from 'pino';

const LEVEL_TO_STATUS: Record<string, string> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'critical',
};

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.DD_SERVICE ?? 'voyager-loadgen-browser',
    env: process.env.DD_ENV ?? 'demo',
    version: process.env.DD_VERSION ?? 'dev',
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  formatters: {
    level(label) {
      // Datadog's canonical levels, not pino's numeric ones.
      return { status: LEVEL_TO_STATUS[label] ?? label };
    },
    bindings(bindings) {
      return { service: bindings.service, env: bindings.env, version: bindings.version };
    },
  },
});
