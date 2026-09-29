/**
 * Structured JSON logging against the shared schema (05-FUNCTIONALITY.md § 12).
 *
 * One schema in four languages is what makes the log-correlation demo work,
 * so the field names here are not negotiable. `dd.trace_id` injection is
 * wired in Phase 8 once the tracer exists.
 *
 * Rule 2 of the schema matters most: `message` is a constant string per log
 * site. All variability goes into structured fields. Interpolated messages
 * destroy log aggregation and Error Tracking grouping.
 */

import pino from 'pino';

import { config } from './config';

const LEVEL_TO_STATUS: Record<string, string> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'critical',
};

export function createLogger(service: string, env: string, version: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service, env, version },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    messageKey: 'message',
    formatters: {
      level(label) {
        // Datadog's canonical levels, not pino's numeric ones.
        return { status: LEVEL_TO_STATUS[label] ?? label };
      },
      bindings(bindings) {
        return {
          service: bindings.service,
          env: bindings.env,
          version: bindings.version,
        };
      },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * The one logger this service uses.
 *
 * A singleton rather than a per-module instance so that `service`, `env` and
 * `version` are identical on every line -- those three are the correlation
 * keys, and a single module binding a different value is the kind of gap that
 * only shows up when you are already debugging something else.
 */
export const log: Logger = createLogger(config.service, config.env, config.version);
