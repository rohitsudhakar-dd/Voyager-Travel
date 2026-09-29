/** Identifier helpers. `crypto.randomUUID` needs a secure context. */

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One key per payment attempt, held for the lifetime of that attempt so a
 * retry of the *same* attempt replays rather than double-charging
 * (05-FUNCTIONALITY.md § 15).
 */
export function idempotencyKey(bookingId: string): string {
  return `pay_${bookingId}_${uuid().slice(0, 12)}`;
}
