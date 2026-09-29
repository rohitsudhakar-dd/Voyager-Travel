/**
 * In-memory charge ledger and idempotency store.
 *
 * A real PSP would persist this; the mock does not need to survive a restart,
 * and keeping it in memory means `make down && make up` is a clean slate for
 * the next demo. `payment-service` holds the durable record either way.
 */

import { config } from './config';
import type { DeclineCode } from './cards';

export type ChargeStatus =
  | 'requires_3ds'
  | 'authorized'
  | 'declined'
  | 'captured'
  | 'refunded'
  | 'partially_refunded'
  | 'failed';

export interface Charge {
  id: string;
  status: ChargeStatus;
  amount: number;
  currency: string;
  capturedAmount: number;
  refundedAmount: number;
  /** Never the full number -- only ever the last four digits and the brand. */
  card: { last4: string; brand: string; expMonth: number; expYear: number };
  declineCode: DeclineCode | null;
  failureMessage: string | null;
  metadata: Record<string, unknown>;
  threeDsToken: string | null;
  createdAt: string;
  updatedAt: string;
}

const charges = new Map<string, Charge>();

export function putCharge(charge: Charge): void {
  charges.set(charge.id, charge);
}

export function getCharge(id: string): Charge | undefined {
  return charges.get(id);
}

export function updateCharge(id: string, patch: Partial<Charge>): Charge | undefined {
  const existing = charges.get(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  charges.set(id, updated);
  return updated;
}

// ---------------------------------------------------------- idempotency --

interface IdempotencyRecord {
  requestHash: string;
  statusCode: number;
  body: unknown;
  storedAt: number;
}

const idempotency = new Map<string, IdempotencyRecord>();

export type IdempotencyLookup =
  | { kind: 'miss' }
  | { kind: 'replay'; statusCode: number; body: unknown }
  | { kind: 'conflict' };

export function lookupIdempotency(key: string, requestHash: string): IdempotencyLookup {
  const record = idempotency.get(key);
  if (!record) return { kind: 'miss' };
  if (Date.now() - record.storedAt > config.idempotencyTtlMs) {
    idempotency.delete(key);
    return { kind: 'miss' };
  }
  // Same key, different request: the caller has a bug, and telling them so is
  // more useful than silently returning someone else's charge.
  if (record.requestHash !== requestHash) return { kind: 'conflict' };
  return { kind: 'replay', statusCode: record.statusCode, body: record.body };
}

export function rememberIdempotency(
  key: string,
  requestHash: string,
  statusCode: number,
  body: unknown,
): void {
  idempotency.set(key, { requestHash, statusCode, body, storedAt: Date.now() });
}

/** Sweep expired keys so a long-running demo does not grow without bound. */
export function sweepIdempotency(): number {
  const cutoff = Date.now() - config.idempotencyTtlMs;
  let removed = 0;
  for (const [key, record] of idempotency) {
    if (record.storedAt < cutoff) {
      idempotency.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function stats(): { charges: number; idempotencyKeys: number } {
  return { charges: charges.size, idempotencyKeys: idempotency.size };
}
