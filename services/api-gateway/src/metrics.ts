/**
 * DogStatsD business metrics for api-gateway (05-FUNCTIONALITY.md § 14).
 *
 * One file, like the tracer and the logger, so the whole DogStatsD integration
 * is readable in one sitting. Every metric name and tag key in the service is
 * spelled once, here: a name spelled two ways is two metrics in Datadog and
 * neither of them is complete.
 *
 * `hot-shots` rather than the client bundled with `dd-trace`
 * (02-TECH-STACK.md § 4.1). The bundled one works, but it ships custom metrics
 * over HTTP to the trace agent's `/dogstatsd/v2/proxy` whenever a trace agent
 * URL is configured -- which is always, here -- so it would put two of the
 * eight services on a different transport from the other six, and DogStatsD's
 * own failure modes (a full UDP buffer, a dead dogstatsd listener behind a live
 * trace receiver) would then not apply to them uniformly.
 *
 * `env`, `service` and `version` are appended to every metric by hot-shots
 * itself, from DD_ENV, DD_SERVICE and DD_VERSION, so no call site passes them;
 * doing so would send each one twice.
 *
 * Nothing here takes a booking id, a user id or an email address. Each distinct
 * tag value is a billable time series, so an identifier in a metric tag is a
 * cost incident; `step` is one of three values and `product` one of two. The
 * identifiers are already on the span and in the log line.
 */

import { StatsD } from 'hot-shots';

import { config } from './config';
import { log } from './logger';

export const CART_ABANDONED = 'voyager.cart.abandoned';
export const CHAOS_FLAGS_ACTIVE = 'voyager.chaos.flags_active';

/** How often the chaos gauge is re-reported. */
const CHAOS_GAUGE_INTERVAL_MS = 10_000;

const statsd = new StatsD({
  host: config.dogstatsd.host,
  port: config.dogstatsd.port,
  // Without a handler hot-shots rethrows socket errors from inside whatever
  // was running at the time, so an unreachable Agent would fail requests.
  // Metrics are the least important thing this process does.
  errorHandler: (error) => {
    log.warn({ error: { kind: error.name, message: error.message } }, 'DogStatsD send failed');
  },
});

/** A cart that reached `step` and went no further. */
export function cartAbandoned(tags: { step: string; product: string }): void {
  statsd.increment(CART_ABANDONED, { step: tags.step, product: tags.product });
}

/**
 * Report how many chaos flags are away from their default, every ten seconds.
 *
 * A gauge has to be re-sent to stay alive -- Datadog reports the last value it
 * received in an interval and nothing at all for an interval with no points, so
 * a gauge written only when a flag changes would read as a gap on every
 * dashboard between toggles. Ten seconds is the Agent's own flush interval, so
 * every interval gets exactly one point.
 *
 * This is the metric that makes every other graph interpretable during a demo:
 * without it, "the p99 jumped at 14:32" and "somebody turned on
 * gds_latency_ms at 14:32" are two facts nobody connects.
 */
export function startChaosFlagsGauge(activeFlags: () => Promise<string[]>): NodeJS.Timeout {
  const report = async (): Promise<void> => {
    try {
      statsd.gauge(CHAOS_FLAGS_ACTIVE, (await activeFlags()).length);
    } catch (error) {
      // Chaos state lives in Redis, which is allowed to be down. A gap in this
      // gauge is not worth a log line per ten seconds, so it is debug.
      log.debug(
        { error: { kind: (error as Error).name, message: (error as Error).message } },
        'Chaos flag gauge skipped',
      );
    }
  };
  void report();
  return setInterval(() => void report(), CHAOS_GAUGE_INTERVAL_MS);
}

export function closeMetrics(): void {
  statsd.close(() => {});
}
