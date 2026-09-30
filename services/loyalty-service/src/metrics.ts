/**
 * DogStatsD business metrics for loyalty-service (05-FUNCTIONALITY.md § 14).
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
 * Nothing here takes a user id or a booking id. Each distinct tag value is a
 * billable time series, so an identifier in a metric tag is a cost incident;
 * `tier` and `product` are short fixed lists. The identifiers are already on
 * the span and in the log line, which is where a single accrual is looked up.
 */

import { StatsD } from 'hot-shots';

import { config } from './config';
import type { Logger } from './logger';

export const POINTS_ACCRUED = 'voyager.loyalty.points_accrued';
export const TIER_UPGRADES = 'voyager.loyalty.tier_upgrades';

let log: Logger | null = null;

const statsd = new StatsD({
  host: config.dogstatsd.host,
  port: config.dogstatsd.port,
  // Without a handler hot-shots rethrows socket errors from inside whatever
  // was running at the time, so an unreachable Agent would fail accruals.
  // Metrics are the least important thing this process does.
  errorHandler: (error) => {
    log?.warn(
      { error: { kind: error.name, message: error.message } },
      'DogStatsD send failed',
    );
  },
});

export function initMetrics(logger: Logger): void {
  log = logger;
}

/**
 * Points credited to an account.
 *
 * A count rather than a distribution: the question the business asks is "how
 * many points did we give away this week", which is a sum, and § 14 defines it
 * that way. The spread of individual accruals is `booking.revenue_cents`'
 * problem.
 */
export function pointsAccrued(points: number, tags: { tier: string; product: string }): void {
  statsd.increment(POINTS_ACCRUED, points, {
    tier: tags.tier,
    product: tags.product,
  });
}

/** A member crossing a tier threshold. */
export function tierUpgraded(tags: { fromTier: string; toTier: string }): void {
  statsd.increment(TIER_UPGRADES, {
    from_tier: tags.fromTier,
    to_tier: tags.toTier,
  });
}

export function closeMetrics(): void {
  statsd.close(() => {});
}
