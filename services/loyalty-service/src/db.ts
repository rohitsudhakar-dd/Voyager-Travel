/**
 * Postgres access.
 *
 * loyalty-service owns `loyalty_accounts` and `loyalty_transactions` and is
 * the only writer of either (05-FUNCTIONALITY.md § 1). It reads `fare_classes`
 * because that is seeded reference data, and it never touches `bookings` --
 * everything it needs about a booking arrives on the event.
 */

import { Pool, PoolClient } from 'pg';

import { config } from './config';
import { isTier, Tier, tierFor } from './points';

export const pool = new Pool(config.postgres);

/** Postgres foreign-key violation: the event referenced an unknown user. */
const FK_VIOLATION = '23503';

export class UnknownUserError extends Error {}

/**
 * The event referenced a booking that is not in `bookings`. booking-service
 * commits the booking before it emits `booking.confirmed`, so this only happens
 * for a hand-produced or replayed-after-deletion event -- but without its own
 * branch the foreign key would look transient and redeliver forever.
 */
export class UnknownBookingError extends Error {}

export interface AccountRow {
  user_id: string;
  points_balance: number;
  lifetime_points: number;
  tier: string;
  tier_qualified_at: Date | null;
  updated_at: Date;
}

export interface TransactionRow {
  id: string;
  booking_id: string | null;
  transaction_type: string;
  points: number;
  balance_after: number;
  description: string | null;
  created_at: Date;
}

export async function ping(): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * `fare_classes.points_multiplier` for one fare class. Unknown or absent fare
 * classes earn at the base rate rather than earning nothing -- a pricing
 * catalogue gap must not silently cost a customer their points.
 */
export async function findFareMultiplier(code: string | null): Promise<number> {
  if (!code) return 1;
  const { rows } = await pool.query<{ points_multiplier: string }>(
    `SELECT points_multiplier
       FROM voyager.fare_classes
      WHERE code = $1`,
    [code],
  );
  const multiplier = Number(rows[0]?.points_multiplier);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

export async function findAccount(userId: string): Promise<AccountRow | null> {
  const { rows } = await pool.query<AccountRow>(
    `SELECT user_id::text, points_balance, lifetime_points, tier,
            tier_qualified_at, updated_at
       FROM voyager.loyalty_accounts
      WHERE user_id = $1::uuid`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function findRecentTransactions(
  userId: string,
  limit: number,
): Promise<TransactionRow[]> {
  const { rows } = await pool.query<TransactionRow>(
    `SELECT id::text, booking_id::text, transaction_type, points,
            balance_after, description, created_at
       FROM voyager.loyalty_transactions
      WHERE user_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function findAccrualForBooking(
  userId: string,
  bookingId: string,
): Promise<TransactionRow | null> {
  const { rows } = await pool.query<TransactionRow>(
    `SELECT id::text, booking_id::text, transaction_type, points,
            balance_after, description, created_at
       FROM voyager.loyalty_transactions
      WHERE user_id = $1::uuid AND booking_id = $2::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId, bookingId],
  );
  return rows[0] ?? null;
}

export interface AccrualResult {
  /** True when this booking had already been accrued and nothing was written. */
  duplicate: boolean;
  transactionId: string | null;
  points: number;
  balanceAfter: number;
  lifetimePoints: number;
  tierBefore: Tier;
  tierAfter: Tier;
}

interface AccrualRequest {
  userId: string;
  bookingId: string;
  description: string;
  /** Called with the tier held now; returns the points to award. */
  points: (tier: Tier) => number;
}

/**
 * Accrue points for one booking, exactly once.
 *
 * Kafka is at-least-once, so `booking.confirmed` will be redelivered sooner or
 * later. The guard is the existing accrual row for the same booking rather
 * than a unique constraint, because booking-service owns every migration and
 * the schema in § 3.2 has no such constraint. `FOR UPDATE` on the account row
 * serialises concurrent accruals for the same user, which is what makes the
 * check-then-insert safe.
 */
export async function accrue(request: AccrualRequest): Promise<AccrualResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const account = await lockAccount(client, request.userId);

    const existing = await client.query(
      `SELECT id::text, points, balance_after
         FROM voyager.loyalty_transactions
        WHERE user_id = $1::uuid
          AND booking_id = $2::uuid
          AND transaction_type = 'accrual'
        LIMIT 1`,
      [request.userId, request.bookingId],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query('COMMIT');
      const tier = isTier(account.tier) ? account.tier : 'standard';
      return {
        duplicate: true,
        transactionId: existing.rows[0].id,
        points: Number(existing.rows[0].points),
        balanceAfter: Number(existing.rows[0].balance_after),
        lifetimePoints: account.lifetime_points,
        tierBefore: tier,
        tierAfter: tier,
      };
    }

    const tierBefore = isTier(account.tier) ? account.tier : 'standard';
    const points = request.points(tierBefore);
    const balanceAfter = account.points_balance + points;
    const lifetimePoints = account.lifetime_points + points;
    const tierAfter = tierFor(lifetimePoints);

    let inserted;
    try {
      inserted = await client.query<{ id: string }>(
        `INSERT INTO voyager.loyalty_transactions
           (user_id, booking_id, transaction_type, points, balance_after, description)
         VALUES ($1::uuid, $2::uuid, 'accrual', $3, $4, $5)
         RETURNING id::text`,
        [request.userId, request.bookingId, points, balanceAfter, request.description],
      );
    } catch (error) {
      if ((error as { code?: string }).code === FK_VIOLATION) {
        throw new UnknownBookingError(request.bookingId);
      }
      throw error;
    }

    await client.query(
      `UPDATE voyager.loyalty_accounts
          SET points_balance = $2,
              lifetime_points = $3,
              tier = $4,
              tier_qualified_at = CASE WHEN tier <> $4 THEN now() ELSE tier_qualified_at END,
              updated_at = now()
        WHERE user_id = $1::uuid`,
      [request.userId, balanceAfter, lifetimePoints, tierAfter],
    );

    await client.query('COMMIT');

    return {
      duplicate: false,
      transactionId: inserted.rows[0].id,
      points,
      balanceAfter,
      lifetimePoints,
      tierBefore,
      tierAfter,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function lockAccount(client: PoolClient, userId: string): Promise<AccountRow> {
  try {
    await client.query(
      `INSERT INTO voyager.loyalty_accounts (user_id)
       VALUES ($1::uuid)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === FK_VIOLATION) {
      throw new UnknownUserError(userId);
    }
    throw error;
  }

  const { rows } = await client.query<AccountRow>(
    `SELECT user_id::text, points_balance, lifetime_points, tier,
            tier_qualified_at, updated_at
       FROM voyager.loyalty_accounts
      WHERE user_id = $1::uuid
        FOR UPDATE`,
    [userId],
  );
  if (!rows[0]) throw new UnknownUserError(userId);
  return rows[0];
}
