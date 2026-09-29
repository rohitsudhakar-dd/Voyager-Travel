import type { ChaosFlag, ChaosValue, Scenario } from '@voyager/shared-schemas';

/**
 * The catalogue exactly as 05-FUNCTIONALITY.md § 11 defines it, and the ten
 * scenarios from 01-PRD.md. The Ops console renders whatever this returns, so
 * the fixture has to be faithful rather than representative -- it is the only
 * way to see the real panel before Phase 6 exists.
 */

type FlagSeed = Omit<ChaosFlag, 'value'>;

const FLAG_SEEDS: FlagSeed[] = [
  // Third parties
  {
    name: 'gds_latency_ms',
    group: 'Third parties',
    type: 'int',
    default: 0,
    min: 0,
    max: 10_000,
    step: 100,
    unit: 'ms',
    description: 'Adds latency to all mock-GDS responses, on top of the baseline distribution.',
    scenarios: ['S1', 'S4'],
  },
  {
    name: 'gds_latency_mode',
    group: 'Third parties',
    type: 'enum',
    default: 'jitter',
    enumValues: ['fixed', 'jitter', 'p99_tail'],
    description: 'How the added GDS delay is applied.',
    scenarios: ['S1'],
  },
  {
    name: 'gds_error_rate',
    group: 'Third parties',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of GDS calls that answer 503.',
    scenarios: ['S1', 'S4'],
  },
  {
    name: 'gds_provider_down',
    group: 'Third parties',
    type: 'string',
    default: '',
    description: 'One provider code always times out, producing partial results.',
    scenarios: ['S1'],
  },
  {
    name: 'gds_rate_limit_aggressive',
    group: 'Third parties',
    type: 'bool',
    default: false,
    description: 'Drops the per-provider rate limit to 10 requests a minute.',
    scenarios: ['S4'],
  },
  {
    name: 'payment_latency_ms',
    group: 'Third parties',
    type: 'int',
    default: 0,
    min: 0,
    max: 15_000,
    step: 250,
    unit: 'ms',
    description: 'Delay inside mock-payments before it answers.',
    scenarios: ['S2'],
  },
  {
    name: 'payment_error_rate',
    group: 'Third parties',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of authorisations that fail with a provider error, not a decline.',
    scenarios: ['S2'],
  },
  {
    name: 'payment_decline_rate',
    group: 'Third parties',
    type: 'float',
    default: 0.02,
    min: 0,
    max: 1,
    step: 0.01,
    description:
      'Proportion of authorisations declined. A decline is a business outcome, not an error.',
    scenarios: ['S2'],
  },
  {
    name: 'payment_decline_mix',
    group: 'Third parties',
    type: 'enum',
    default: 'mixed',
    enumValues: [
      'mixed',
      'card_declined',
      'insufficient_funds',
      'expired_card',
      'do_not_honor',
      'fraud_suspected',
    ],
    description: 'Which decline code dominates the mix.',
    scenarios: ['S2'],
  },
  {
    name: 'payment_webhook_delay_ms',
    group: 'Third parties',
    type: 'int',
    default: 2_000,
    min: 0,
    max: 60_000,
    step: 500,
    unit: 'ms',
    description: 'How long the provider waits before calling the payment webhook.',
    scenarios: ['S2'],
  },
  {
    name: 'email_failure_rate',
    group: 'Third parties',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of emails mock-email rejects with a 422, generating DLQ traffic.',
    scenarios: ['S5'],
  },

  // Database
  {
    name: 'db_n_plus_one',
    group: 'Database',
    type: 'bool',
    default: false,
    description: 'The booking-list query loops per row instead of joining.',
    scenarios: ['S3'],
  },
  {
    name: 'db_drop_index',
    group: 'Database',
    type: 'bool',
    default: false,
    description: 'Drops idx_bookings_user_id_created_at. Reset recreates it.',
    scenarios: ['S3'],
  },
  {
    name: 'db_lock_storm',
    group: 'Database',
    type: 'bool',
    default: false,
    description: 'A background task holds a row lock on inventory_holds, five seconds at a time.',
    scenarios: ['S10'],
  },
  {
    name: 'db_pool_starvation',
    group: 'Database',
    type: 'bool',
    default: false,
    description: 'Shrinks the connection pool to two connections.',
    scenarios: ['S10'],
  },
  {
    name: 'db_slow_query_ms',
    group: 'Database',
    type: 'int',
    default: 0,
    min: 0,
    max: 10_000,
    step: 250,
    unit: 'ms',
    description:
      'Adds pg_sleep() to one reporting query, emulating a genuinely expensive analytical query.',
    scenarios: [],
  },

  // Cache
  {
    name: 'redis_disabled',
    group: 'Cache',
    type: 'bool',
    default: false,
    description: 'Every cache read misses and writes are skipped.',
    scenarios: ['S4'],
  },
  {
    name: 'redis_latency_ms',
    group: 'Cache',
    type: 'int',
    default: 0,
    min: 0,
    max: 2_000,
    step: 25,
    unit: 'ms',
    description: 'Delay before every Redis operation.',
    scenarios: ['S4'],
  },
  {
    name: 'cache_ttl_seconds',
    group: 'Cache',
    type: 'int',
    default: 120,
    min: 1,
    max: 600,
    step: 1,
    unit: 's',
    description: 'Search-result cache TTL. Set to 1 for near-constant misses.',
    scenarios: ['S4'],
  },

  // Queue
  {
    name: 'kafka_consumer_pause',
    group: 'Queue',
    type: 'string',
    default: '',
    description: 'Pauses the named consumer group, producing real and growing lag.',
    scenarios: ['S5'],
  },
  {
    name: 'kafka_slow_consumer_ms',
    group: 'Queue',
    type: 'int',
    default: 0,
    min: 0,
    max: 10_000,
    step: 250,
    unit: 'ms',
    description: 'Per-message processing delay in the consumer.',
    scenarios: ['S5'],
  },
  {
    name: 'kafka_producer_error_rate',
    group: 'Queue',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of producer sends that fail.',
    scenarios: [],
  },
  {
    name: 'kafka_poison_rate',
    group: 'Queue',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of messages emitted malformed, which land in the DLQ.',
    scenarios: ['S5'],
  },

  // Compute
  {
    name: 'pricing_hot_path',
    group: 'Compute',
    type: 'bool',
    default: false,
    description: 'Bypasses the fare-rule index, so pricing walks every rule.',
    scenarios: ['S6'],
  },
  {
    name: 'booking_memory_leak',
    group: 'Compute',
    type: 'bool',
    default: false,
    description: 'A module-level dict retains itinerary objects and never evicts them.',
    scenarios: ['S7'],
  },
  {
    name: 'hold_lock_contention',
    group: 'Compute',
    type: 'bool',
    default: false,
    description: 'Widens the advisory-lock critical section around seat holds.',
    scenarios: ['S10'],
  },
  {
    name: 'service_error_rate',
    group: 'Compute',
    type: 'map',
    default: {},
    description: 'Per-service synthetic 500s, keyed by service name.',
    scenarios: [],
  },
  {
    name: 'service_latency_ms',
    group: 'Compute',
    type: 'map',
    default: {},
    description: 'Per-service added latency, keyed by service name.',
    scenarios: [],
  },

  // Frontend
  {
    name: 'frontend_heavy_assets',
    group: 'Frontend',
    type: 'bool',
    default: false,
    description: 'Serves large images everywhere and disables lazy loading, collapsing LCP.',
    scenarios: ['S8'],
  },
  {
    name: 'frontend_blocking_js',
    group: 'Frontend',
    type: 'bool',
    default: false,
    description: 'Runs a synchronous 400 ms main-thread task on results render, collapsing INP.',
    scenarios: ['S8'],
  },
  {
    name: 'frontend_js_error_rate',
    group: 'Frontend',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of results renders that throw a client-side exception.',
    scenarios: ['S8'],
  },
  {
    name: 'frontend_layout_shift',
    group: 'Frontend',
    type: 'bool',
    default: false,
    description: 'Inserts a banner after first paint with no space reserved, regressing CLS.',
    scenarios: ['S8'],
  },

  // LLM
  {
    name: 'llm_latency_ms',
    group: 'LLM',
    type: 'int',
    default: 0,
    min: 0,
    max: 15_000,
    step: 250,
    unit: 'ms',
    description: 'Added time to first token.',
    scenarios: ['S9'],
  },
  {
    name: 'llm_degrade_tools',
    group: 'LLM',
    type: 'bool',
    default: false,
    description: 'The model answers in prose instead of calling tools.',
    scenarios: ['S9'],
  },
  {
    name: 'llm_hallucinate',
    group: 'LLM',
    type: 'bool',
    default: false,
    description:
      'The model invents a plausible but wrong reference and itinerary. Never touches the booking record.',
    scenarios: ['S9'],
  },
  {
    name: 'llm_error_rate',
    group: 'LLM',
    type: 'float',
    default: 0,
    min: 0,
    max: 1,
    step: 0.01,
    description: 'Proportion of completions that fail with a 500.',
    scenarios: ['S9'],
  },
  {
    name: 'llm_token_bloat',
    group: 'LLM',
    type: 'bool',
    default: false,
    description: 'Verbose responses, for a visible token and cost spike.',
    scenarios: ['S9'],
  },

  // Meta
  {
    name: 'version_override',
    group: 'Meta',
    type: 'string',
    default: '',
    description: 'Overrides the reported DD_VERSION to fake a deploy.',
    scenarios: ['S6'],
  },
];

export const SCENARIO_SEEDS: Omit<Scenario, 'active'>[] = [
  {
    id: 'S1',
    title: 'Third-party degradation',
    story: 'Search gets slow, but only sometimes, and the trace shows the time is not ours.',
    flags: {
      gds_latency_ms: 1_500,
      gds_latency_mode: 'p99_tail',
      gds_error_rate: 0.05,
      gds_provider_down: 'TRVP',
    },
    blastRadius: 'Search latency tail and partial results. Booking and payment unaffected.',
  },
  {
    id: 'S2',
    title: 'Payment provider brownout',
    story:
      'Bookings stall at PENDING_PAYMENT while the provider takes three seconds and declines a quarter of attempts.',
    flags: {
      payment_latency_ms: 3_000,
      payment_error_rate: 0.3,
      payment_decline_rate: 0.25,
      payment_decline_mix: 'insufficient_funds',
      payment_webhook_delay_ms: 15_000,
    },
    blastRadius: 'Checkout conversion and revenue. Search is healthy throughout.',
  },
  {
    id: 'S3',
    title: 'The missing index',
    story: 'The account page times out because one index is gone and the query started looping.',
    flags: { db_drop_index: true, db_n_plus_one: true },
    blastRadius: 'GET /bookings/mine and the account page. Postgres CPU.',
  },
  {
    id: 'S4',
    title: 'Cache stampede to cascade',
    story:
      'A cold cache drives twenty times the GDS fan-out, the providers rate-limit, and holds start expiring.',
    flags: {
      redis_disabled: true,
      cache_ttl_seconds: 1,
      gds_rate_limit_aggressive: true,
      gds_latency_ms: 800,
      gds_error_rate: 0.1,
    },
    blastRadius: 'Everything downstream of search. Run load at 2x for the full narrative.',
  },
  {
    id: 'S5',
    title: 'Slow consumer',
    story: 'Bookings confirm, but the confirmation emails never arrive.',
    flags: {
      kafka_consumer_pause: 'voyager-notifications-v1',
      kafka_slow_consumer_ms: 2_000,
      kafka_poison_rate: 0.05,
      email_failure_rate: 0.1,
    },
    blastRadius: 'Notification pipeline and the DLQ. Booking state is correct throughout.',
  },
  {
    id: 'S6',
    title: 'The hot deploy',
    story: 'p95 regresses right at a deployment marker, and the flame graph finds the loop.',
    flags: { version_override: 'v2-bad', pricing_hot_path: true },
    blastRadius: 'Pricing latency on every search and every re-price.',
  },
  {
    id: 'S7',
    title: 'Memory leak',
    story: 'Resident memory climbs for twenty minutes, then the service restarts.',
    flags: { booking_memory_leak: true },
    blastRadius: 'booking-service only, and it gets worse the longer you leave it.',
    requiresRestartToRevert: true,
  },
  {
    id: 'S8',
    title: 'Frontend-only regression',
    story: 'The backend is perfectly healthy and users complain anyway.',
    flags: {
      frontend_heavy_assets: true,
      frontend_blocking_js: true,
      frontend_layout_shift: true,
      frontend_js_error_rate: 0.03,
    },
    blastRadius: 'Core Web Vitals and client-side errors. No server-side signal at all.',
  },
  {
    id: 'S9',
    title: 'AI support goes off the rails',
    story: 'Support stops calling the booking tool and starts making things up.',
    flags: {
      llm_degrade_tools: true,
      llm_latency_ms: 4_000,
      llm_hallucinate: true,
      llm_token_bloat: true,
      llm_error_rate: 0.05,
    },
    blastRadius: 'Support chat answer quality, token spend and latency.',
  },
  {
    id: 'S10',
    title: 'Lock contention',
    story: 'Seat holds serialise behind one advisory lock and the pool runs dry.',
    flags: { hold_lock_contention: true, db_lock_storm: true, db_pool_starvation: true },
    blastRadius: 'Hold creation across both products. Run load at 2x.',
  },
];

export function defaultValues(): Record<string, ChaosValue> {
  return Object.fromEntries(FLAG_SEEDS.map((flag) => [flag.name, flag.default]));
}

export function buildFlags(values: Record<string, ChaosValue>): ChaosFlag[] {
  return FLAG_SEEDS.map((flag) => ({ ...flag, value: values[flag.name] ?? flag.default }));
}

/** A flag is "active" when it differs from its default, exactly as the panel shows it. */
export function activeFlagNames(values: Record<string, ChaosValue>): string[] {
  return FLAG_SEEDS.filter(
    (flag) => JSON.stringify(values[flag.name] ?? flag.default) !== JSON.stringify(flag.default),
  ).map((flag) => flag.name);
}
