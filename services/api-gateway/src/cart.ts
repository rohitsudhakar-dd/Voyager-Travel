/**
 * Checkout-funnel tracking behind `voyager.cart.abandoned` (§ 14).
 *
 * The metric is the gateway's rather than the browser's on purpose: it is the
 * one abandonment number an ad blocker cannot delete, which is what makes it
 * worth comparing against the RUM funnel
 * (datadog/dashboards/d1-business-health.json).
 *
 * The gateway sees every step of a checkout, so it can tell how far a cart got
 * without asking booking-service anything. Two Redis keys do it:
 *
 *   voyager:carts             sorted set, member = booking id, score = the hold
 *                             expiry in epoch ms. This is the schedule.
 *   voyager:cart:<booking id> hash of `step` and `product`, the furthest rung
 *                             reached. Expires an hour after the hold, so a
 *                             gateway that dies mid-sweep leaks nothing.
 *
 * A cart is *removed* the moment payment is authorized, and *swept* when its
 * hold expires with the entry still present. So a still-present entry means the
 * traveller never authorized, which is the definition of abandonment, and no
 * confirmed booking can be miscounted.
 *
 * The step names are the RUM view names from 06-USER-FLOWS.md § 2 -- `review`,
 * `passengers`, `payment` -- because the dashboard puts the two side by side
 * and a different vocabulary would make that comparison unreadable.
 */

import type Redis from 'ioredis';

import type { Deps } from './deps';
import { log } from './logger';
import * as metrics from './metrics';

const SCHEDULE_KEY = 'voyager:carts';
const CART_PREFIX = 'voyager:cart:';

/** How often expired carts are swept. */
const SWEEP_INTERVAL_MS = 15_000;
/** How many carts one sweep may claim. A slow sweep is better than a stall. */
const SWEEP_BATCH = 100;
/** How long after the hold a cart hash survives, as a leak guard. */
const CART_TTL_SECONDS = 3_600;

export type CheckoutStep = 'review' | 'passengers' | 'payment';

function cartKey(bookingId: string): string {
  return `${CART_PREFIX}${bookingId}`;
}

/**
 * Record that a cart has reached `review`. Only this rung knows the hold
 * expiry, so only this rung can schedule the sweep.
 */
export async function openCart(
  deps: Deps,
  bookingId: string,
  product: string,
  holdExpiresAt: string | null,
): Promise<void> {
  const expiresAt = holdExpiresAt ? Date.parse(holdExpiresAt) : NaN;
  if (!Number.isFinite(expiresAt)) return;

  try {
    await deps.redis
      .multi()
      .zadd(SCHEDULE_KEY, expiresAt, bookingId)
      .hset(cartKey(bookingId), { step: 'review', product })
      .expire(cartKey(bookingId), Math.ceil((expiresAt - Date.now()) / 1000) + CART_TTL_SECONDS)
      .exec();
  } catch (error) {
    warn(error, 'Cart not tracked');
  }
}

/**
 * Record that a tracked cart has reached a later rung.
 *
 * A cart that was never opened is not created here: without the hold expiry
 * there is nothing to schedule the sweep against, and inventing a TTL would
 * make the metric a measure of this module's guess rather than of the funnel.
 * Every checkout in the product starts at `POST /bff/checkout/init`, so the
 * only carts this skips are hand-made ones.
 */
export async function advanceCart(
  deps: Deps,
  bookingId: string,
  step: CheckoutStep,
): Promise<void> {
  try {
    const exists = await deps.redis.exists(cartKey(bookingId));
    if (!exists) return;
    await deps.redis.hset(cartKey(bookingId), 'step', step);
  } catch (error) {
    warn(error, 'Cart step not recorded');
  }
}

/** The traveller paid. Not an abandonment, so the cart stops being tracked. */
export async function closeCart(deps: Deps, bookingId: string): Promise<void> {
  try {
    await deps.redis.multi().zrem(SCHEDULE_KEY, bookingId).del(cartKey(bookingId)).exec();
  } catch (error) {
    warn(error, 'Cart not closed');
  }
}

export function startCartSweeper(deps: Deps): NodeJS.Timeout {
  return setInterval(() => void sweepCarts(deps), SWEEP_INTERVAL_MS);
}

export async function sweepCarts(deps: Deps): Promise<number> {
  let swept = 0;
  try {
    const due = await deps.redis.zrangebyscore(
      SCHEDULE_KEY,
      0,
      Date.now(),
      'LIMIT',
      0,
      SWEEP_BATCH,
    );

    for (const bookingId of due) {
      // The ZREM is the claim. Emitting first and removing second would
      // double-count every cart if the gateway were ever run with more than one
      // replica, and this is the kind of bug that only appears in production.
      if ((await deps.redis.zrem(SCHEDULE_KEY, bookingId)) !== 1) continue;

      const cart = await readCart(deps.redis, bookingId);
      await deps.redis.del(cartKey(bookingId));
      if (!cart) continue;

      metrics.cartAbandoned(cart);
      swept += 1;
    }
  } catch (error) {
    warn(error, 'Cart sweep failed');
  }
  return swept;
}

async function readCart(
  redis: Redis,
  bookingId: string,
): Promise<{ step: string; product: string } | null> {
  const fields = await redis.hgetall(cartKey(bookingId));
  if (!fields.step || !fields.product) return null;
  return { step: fields.step, product: fields.product };
}

function warn(error: unknown, message: string): void {
  log.warn(
    { error: { kind: (error as Error).name, message: (error as Error).message } },
    message,
  );
}
