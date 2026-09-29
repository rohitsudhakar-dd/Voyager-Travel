import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

export interface PriceTagProps {
  cents: number;
  currency?: string;
  size?: 'md' | 'lg';
  /** The pre-discount price, struck through. */
  wasCents?: number;
  /** "from £412" -- used on deal cards where the price is indicative. */
  from?: boolean;
  suffix?: string;
  className?: string;
  testId?: string;
}

/**
 * Prices are always tabular so digits do not jitter, and are marked
 * `data-dd-privacy="allow"` because a session replay with the price redacted
 * tells you nothing.
 */
export function PriceTag({
  cents,
  currency = 'GBP',
  size = 'md',
  wasCents,
  from,
  suffix,
  className,
  testId = 'price-tag',
}: PriceTagProps) {
  return (
    <span
      data-testid={testId}
      data-dd-privacy="allow"
      className={cn('inline-flex items-baseline gap-1.5', className)}
    >
      {from ? <span className="text-caption text-fg-muted">from</span> : null}
      {wasCents !== undefined && wasCents > cents ? (
        <span className="tabular text-body-sm text-fg-muted line-through">
          {formatMoney(wasCents, currency)}
        </span>
      ) : null}
      <span className={cn('tabular text-fg', size === 'lg' ? 'text-price-lg' : 'text-price-md')}>
        {formatMoney(cents, currency)}
      </span>
      {suffix ? <span className="text-body-sm text-fg-muted">{suffix}</span> : null}
    </span>
  );
}
