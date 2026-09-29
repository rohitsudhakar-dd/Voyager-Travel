import type { Booking } from '@voyager/shared-schemas';
import { ChevronUp, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Card, CardBody, PriceTag, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

const ANCILLARY_LABELS: Record<string, string> = {
  seat: 'Seat selection',
  baggage: 'Extra baggage',
  upgrade: 'Room upgrade',
  insurance: 'Travel insurance',
};

export interface PriceSummaryProps {
  booking: Booking;
  pointsPreview?: number;
  /** True while a re-price is in flight, so a line shimmers instead of jumping. */
  repricing?: boolean;
  className?: string;
}

interface Line {
  id: string;
  label: string;
  cents: number;
}

function ancillaryLines(booking: Booking): Line[] {
  const grouped = new Map<string, number>();
  for (const item of booking.items) {
    if (item.itemType === 'flight_segment' || item.itemType === 'room_night') continue;
    grouped.set(item.itemType, (grouped.get(item.itemType) ?? 0) + item.totalPriceCents);
  }
  return Array.from(grouped, ([itemType, cents]) => ({
    id: itemType,
    label: ANCILLARY_LABELS[itemType] ?? itemType,
    cents,
  }));
}

function Lines({ booking, repricing }: { booking: Booking; repricing?: boolean }) {
  const lines: Line[] = [
    {
      id: 'base',
      label: booking.productType === 'flight' ? 'Base fare' : 'Room rate',
      cents: booking.subtotalCents,
    },
    { id: 'taxes', label: 'Taxes and fees', cents: booking.taxesCents },
    ...ancillaryLines(booking),
  ];

  return (
    <dl className="space-y-2">
      {lines.map((line) => (
        <div key={line.id} className="flex items-baseline justify-between gap-4">
          <dt className="text-body-md text-fg-muted">{line.label}</dt>
          <dd className="tabular text-body-md text-fg">
            {repricing && line.id !== 'base' ? (
              <Skeleton width={64} height={16} className="inline-block align-middle" />
            ) : (
              formatMoney(line.cents, booking.currency)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Sticky sidebar on `lg`+, a collapsible sticky bottom bar below that
 * (04-STYLING.md § 4.6). Loading line items shimmer in place rather than
 * shifting the layout.
 */
export function PriceSummary({ booking, pointsPreview, repricing, className }: PriceSummaryProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <Card
        variant="elevated"
        data-testid="price-summary"
        className={cn('hidden lg:sticky lg:top-20 lg:block lg:self-start', className)}
      >
        <CardBody className="space-y-4">
          <h2 className="text-heading-sm">Price summary</h2>
          <Lines booking={booking} repricing={repricing} />

          <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
            <span className="text-heading-sm">Total</span>
            <PriceTag
              cents={booking.totalCents}
              currency={booking.currency}
              size="lg"
              testId="price-summary-total"
            />
          </div>

          {pointsPreview ? (
            <p className="inline-flex items-center gap-1.5 text-body-sm text-accent-700">
              <Sparkles aria-hidden className="h-4 w-4" />
              Earn {pointsPreview.toLocaleString('en-GB')} Voyager points
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg-elevated shadow-lg lg:hidden">
        {expanded ? (
          <div className="border-b border-border px-4 py-3">
            <Lines booking={booking} repricing={repricing} />
          </div>
        ) : null}
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="price-summary-toggle"
          onClick={() => setExpanded((current) => !current)}
          className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
        >
          <span>
            <span className="block text-caption text-fg-muted">Total</span>
            <PriceTag cents={booking.totalCents} currency={booking.currency} />
          </span>
          <span className="inline-flex items-center gap-1 text-body-sm font-medium text-brand-600">
            {expanded ? 'Hide' : 'Show'} breakdown
            <ChevronUp
              aria-hidden
              className={cn('h-4 w-4 transition-transform duration-fast', expanded && 'rotate-180')}
            />
          </span>
        </button>
      </div>
    </>
  );
}
