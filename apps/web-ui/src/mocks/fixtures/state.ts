import type {
  AdminStatus,
  Booking,
  BookingItem,
  ChaosValue,
  Conversation,
  LoadgenState,
  LoyaltyAccount,
  Passenger,
  Payment,
  SearchResult,
  User,
} from '@voyager/shared-schemas';
import { uuid } from '@/lib/ids';
import { SCENARIO_SEEDS, defaultValues } from './chaos';
import { rngFrom } from './rng';

/**
 * In-memory state for the fixture layer. Mutable on purpose: a demo of the UI
 * has to be able to create a booking, pay for it, watch it confirm and then
 * cancel it, which needs somewhere for that to live.
 */

const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const HOLD_MINUTES = 10;

export interface SearchRecord {
  id: string;
  productType: 'flight' | 'hotel';
  results: SearchResult[];
  cacheHit: boolean;
  providersQueried: number;
  providersResponded: number;
  createdAt: number;
}

export const state = {
  searches: new Map<string, SearchRecord>(),
  bookings: new Map<string, Booking>(),
  payments: new Map<string, Payment>(),
  conversations: new Map<string, Conversation>(),
  chaos: defaultValues(),
  activeScenarioId: null as string | null,
  loadgen: {
    api: { enabled: false, intensity: 'off', vus: 0 },
    browser: { enabled: false, concurrency: 0 },
  } as LoadgenState,
  versionOverride: null as string | null,
  sequence: 1,
};

export function nextId(prefix: string): string {
  state.sequence += 1;
  return `${prefix}_${state.sequence.toString(36).padStart(4, '0')}${Date.now().toString(36)}`;
}

export { uuid };

export function pnr(seed: string): string {
  const rng = rngFrom(seed);
  return Array.from({ length: 6 }, () => PNR_ALPHABET[rng.int(0, PNR_ALPHABET.length - 1)]).join(
    '',
  );
}

export const DEMO_USER: User = {
  id: '3f1a2b44-7c0d-4e21-9a55-6b8c1d2e3f40',
  email: 'ada@voyager.test',
  firstName: 'Ada',
  lastName: 'Okonkwo',
  tier: 'gold',
  loyaltyPoints: 48_250,
  signupCohort: '2023-Q2',
};

export const DEMO_PASSWORD = 'voyager-demo';

export const loyalty: LoyaltyAccount = {
  pointsBalance: 48_250,
  lifetimePoints: 126_400,
  tier: 'gold',
  nextTier: 'platinum',
  pointsToNextTier: 23_600,
  transactions: [
    {
      id: 1,
      transactionType: 'accrual',
      points: 3_200,
      balanceAfter: 48_250,
      description: 'Flight LHR–JFK',
      bookingId: null,
      createdAt: daysAgo(4),
    },
    {
      id: 2,
      transactionType: 'redemption',
      points: -8_000,
      balanceAfter: 45_050,
      description: 'Seat upgrade',
      bookingId: null,
      createdAt: daysAgo(19),
    },
    {
      id: 3,
      transactionType: 'accrual',
      points: 1_450,
      balanceAfter: 53_050,
      description: 'Hotel, Lisbon',
      bookingId: null,
      createdAt: daysAgo(33),
    },
    {
      id: 4,
      transactionType: 'adjustment',
      points: 500,
      balanceAfter: 51_600,
      description: 'Service recovery',
      bookingId: null,
      createdAt: daysAgo(51),
    },
    {
      id: 5,
      transactionType: 'accrual',
      points: 2_780,
      balanceAfter: 51_100,
      description: 'Flight MAN–BCN',
      bookingId: null,
      createdAt: daysAgo(68),
    },
  ],
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function itemsForResult(result: SearchResult, travellers: number): BookingItem[] {
  if (result.productType === 'flight') {
    return [
      {
        id: 1,
        itemType: 'flight_segment',
        description: `${result.segments[0].origin} to ${result.segments[result.segments.length - 1].destination}, ${result.airline.name}`,
        quantity: travellers,
        unitPriceCents: Math.round(result.fare.baseCents / travellers),
        totalPriceCents: result.fare.baseCents,
      },
    ];
  }

  return [
    {
      id: 1,
      itemType: 'room_night',
      description: `${result.name}, ${result.roomName}`,
      quantity: result.nights,
      unitPriceCents: result.nightlyPriceCents,
      totalPriceCents: result.nightlyPriceCents * result.nights,
    },
  ];
}

export function recalculate(booking: Booking): Booking {
  const isCore = (item: BookingItem) =>
    item.itemType === 'flight_segment' || item.itemType === 'room_night';
  const subtotalCents = booking.items
    .filter(isCore)
    .reduce((sum, item) => sum + item.totalPriceCents, 0);
  const ancillariesCents = booking.items
    .filter((item) => !isCore(item))
    .reduce((sum, item) => sum + item.totalPriceCents, 0);
  const taxesCents = Math.round(subtotalCents * 0.19);

  return {
    ...booking,
    subtotalCents,
    ancillariesCents,
    taxesCents,
    totalCents: subtotalCents + taxesCents + ancillariesCents,
  };
}

export function seedPassengers(count: number): Passenger[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    passengerType: 'adult' as const,
    title: 'Ms',
    firstName: index === 0 ? DEMO_USER.firstName : 'Guest',
    lastName: index === 0 ? DEMO_USER.lastName : `Traveller ${index + 1}`,
    dateOfBirth: '1989-04-17',
    nationality: 'GB',
    passportNumber: '',
    frequentFlyerNumber: '',
    seatAssignment: null,
  }));
}

/**
 * Two bookings that already exist, so the account page, the manage flow and the
 * home page's upcoming trips have something to show on a cold start.
 */
export function seedBookings(): void {
  if (state.bookings.size > 0) return;

  const confirmed: Booking = recalculate({
    id: uuid(),
    pnr: pnr('seed-flight'),
    productType: 'flight',
    state: 'CONFIRMED',
    currency: 'GBP',
    subtotalCents: 0,
    taxesCents: 0,
    ancillariesCents: 0,
    totalCents: 0,
    searchId: null,
    resultId: null,
    contactEmail: DEMO_USER.email,
    contactPhone: '+44 7700 900123',
    holdExpiresAt: null,
    confirmedAt: daysAgo(6),
    cancelledAt: null,
    cancellationReason: null,
    items: [
      {
        id: 1,
        itemType: 'flight_segment',
        description: 'LHR to JFK, Northwind Airways',
        quantity: 1,
        unitPriceCents: 48_900,
        totalPriceCents: 48_900,
      },
      {
        id: 2,
        itemType: 'seat',
        description: 'Seat 12A',
        quantity: 1,
        unitPriceCents: 1_200,
        totalPriceCents: 1_200,
      },
    ],
    passengers: seedPassengers(1),
    createdAt: daysAgo(6),
  });

  const upcoming: Booking = recalculate({
    ...confirmed,
    id: uuid(),
    pnr: pnr('seed-hotel'),
    productType: 'hotel',
    confirmedAt: daysAgo(2),
    items: [
      {
        id: 1,
        itemType: 'room_night',
        description: 'Harbourstone House, Deluxe double',
        quantity: 3,
        unitPriceCents: 18_400,
        totalPriceCents: 55_200,
      },
    ],
    createdAt: daysAgo(2),
  });

  state.bookings.set(confirmed.id, confirmed);
  state.bookings.set(upcoming.id, upcoming);

  state.payments.set(confirmed.id, {
    id: uuid(),
    bookingId: confirmed.id,
    provider: 'mock-payments',
    state: 'CAPTURED',
    amountCents: confirmed.totalCents,
    currency: 'GBP',
    cardLast4: '4242',
    cardBrand: 'Solaris',
    declineCode: null,
    failureMessage: null,
    requires3ds: false,
    authorizedAt: daysAgo(6),
    createdAt: daysAgo(6),
  });
}

export function bookingByIdOrPnr(idOrPnr: string): Booking | undefined {
  const direct = state.bookings.get(idOrPnr);
  if (direct) return direct;
  const upper = idOrPnr.toUpperCase();
  return [...state.bookings.values()].find((booking) => booking.pnr === upper);
}

export function chaosNumber(name: string): number {
  const value = state.chaos[name];
  return typeof value === 'number' ? value : 0;
}

export function chaosBool(name: string): boolean {
  return state.chaos[name] === true;
}

export function chaosString(name: string): string {
  const value = state.chaos[name];
  return typeof value === 'string' ? value : '';
}

export function setChaos(update: Record<string, ChaosValue>): void {
  Object.assign(state.chaos, update);
  state.activeScenarioId =
    SCENARIO_SEEDS.find((scenario) =>
      Object.entries(scenario.flags).every(
        ([name, value]) => JSON.stringify(state.chaos[name]) === JSON.stringify(value),
      ),
    )?.id ?? null;
}

export function resetChaos(): void {
  state.chaos = defaultValues();
  state.activeScenarioId = null;
  state.versionOverride = null;
}

const SERVICE_NAMES = [
  'api-gateway',
  'search-service',
  'booking-service',
  'payment-service',
  'pricing-service',
  'loyalty-service',
  'support-service',
  'notification-worker',
  'inventory-service',
];

/** Health is derived from the flags that are on, so the panel reacts honestly. */
export function buildStatus(): AdminStatus {
  const gdsLatency = chaosNumber('gds_latency_ms');
  const paymentLatency = chaosNumber('payment_latency_ms');
  const paymentErrors = chaosNumber('payment_error_rate');
  const dbBroken = chaosBool('db_drop_index') || chaosBool('db_n_plus_one');
  const poolStarved = chaosBool('db_pool_starvation');
  const cachePressure = chaosBool('redis_disabled');
  const consumerPaused = chaosString('kafka_consumer_pause') !== '';
  const rng = rngFrom(`status:${Math.floor(Date.now() / 5_000)}`);
  const loadFactor = state.loadgen.api.enabled
    ? { off: 1, '1x': 1, '2x': 2, '5x': 5 }[state.loadgen.api.intensity]
    : 0.4;

  const services = SERVICE_NAMES.map((name) => {
    let p95 = 40 + rng.int(0, 60);
    let errorRate = rng.next() * 0.004;

    if (name === 'search-service' || name === 'api-gateway') p95 += gdsLatency * 0.9;
    if (name === 'payment-service') {
      p95 += paymentLatency;
      errorRate += paymentErrors;
    }
    if (name === 'booking-service' && dbBroken) p95 += 2_400;
    if (name === 'booking-service' && poolStarved) errorRate += 0.06;
    if (name === 'search-service' && cachePressure) p95 += 350;
    if (name === 'notification-worker' && consumerPaused) errorRate += 0.02;

    const health =
      errorRate > 0.05 || p95 > 2_500
        ? 'down'
        : errorRate > 0.01 || p95 > 900
          ? 'degraded'
          : 'healthy';

    return {
      name,
      health: health as AdminStatus['services'][number]['health'],
      p95Ms: Math.round(p95),
      errorRate: Number(errorRate.toFixed(4)),
      requestRate: Number((loadFactor * (6 + rng.next() * 5)).toFixed(1)),
      version: state.versionOverride ?? '1.0.0',
    };
  });

  return {
    env: 'local',
    version: state.versionOverride ?? '1.0.0',
    services,
    postgres: {
      connections: poolStarved ? 2 : 14 + rng.int(0, 12),
      maxConnections: poolStarved ? 2 : 100,
      health: poolStarved || dbBroken ? 'degraded' : 'healthy',
    },
    redis: {
      hitRatio: cachePressure ? 0 : 0.86 + rng.next() * 0.1,
      usedMemoryBytes: 92 * 1024 * 1024 + rng.int(0, 18) * 1024 * 1024,
      maxMemoryBytes: 512 * 1024 * 1024,
      evictedKeys: cachePressure ? rng.int(4_000, 22_000) : 0,
      health: cachePressure ? 'down' : 'healthy',
    },
    kafka: {
      consumerGroups: [
        {
          group: 'voyager-notifications-v1',
          lag: consumerPaused ? rng.int(2_400, 18_000) : rng.int(0, 40),
        },
        { group: 'voyager-loyalty-v1', lag: rng.int(0, 25) },
        { group: 'voyager-analytics-v1', lag: rng.int(0, 60) },
      ],
      health: consumerPaused ? 'degraded' : 'healthy',
    },
    loadgen: state.loadgen,
    activeFlagCount: Object.keys(state.chaos).filter((name) => {
      const defaults = defaultValues();
      return JSON.stringify(state.chaos[name]) !== JSON.stringify(defaults[name]);
    }).length,
    requestId: nextId('req'),
  };
}
