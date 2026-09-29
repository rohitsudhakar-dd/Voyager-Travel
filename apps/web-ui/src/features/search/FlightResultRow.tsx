import type { FlightResult } from '@voyager/shared-schemas';
import { ChevronDown, Luggage, Plane } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, PriceTag } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDuration, formatTime, priceBand, stopsLabel } from '@/lib/format';
import { AirlineLogo } from './AirlineLogo';

const CABIN_LABELS: Record<string, string> = {
  economy: 'Economy',
  economy_plus: 'Premium economy',
  business: 'Business',
  first: 'First',
};

export interface FlightResultRowProps {
  result: FlightResult;
  /** Zero-based; goes into the RUM action attributes in Phase 9. */
  position: number;
  onSelect: (result: FlightResult) => void;
  onViewDetails: (result: FlightResult) => void;
  selecting?: boolean;
}

/**
 * A row, not a card -- this is how real OTAs display flights, and it reads as
 * considerably more credible (04-STYLING.md § 4.2).
 */
export function FlightResultRow({
  result,
  position,
  onSelect,
  onViewDetails,
  selecting,
}: FlightResultRowProps) {
  const [expanded, setExpanded] = useState(false);
  const first = result.segments[0];
  const last = result.segments[result.segments.length - 1];

  return (
    <li
      data-testid="flight-result-row"
      data-position={position}
      data-price-band={priceBand(result.fare.totalCents)}
      data-stops={result.stops}
      className="v-deferred-row rounded-lg border border-border bg-bg-elevated shadow-xs transition-[border-color,box-shadow] duration-fast hover:border-border-strong hover:shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-4 p-4 sm:flex-nowrap">
        <AirlineLogo code={result.airline.iataCode} name={result.airline.name} />

        <div className="flex min-w-0 flex-1 items-center gap-3">
          <p className="shrink-0 text-left">
            <span className="tabular block text-heading-md">{formatTime(first.departAt)}</span>
            <span className="block text-body-sm text-fg-muted">{first.origin}</span>
          </p>

          <div className="min-w-0 flex-1 text-center">
            <p className="tabular text-body-sm text-fg-muted">
              {formatDuration(result.durationMinutes)}
            </p>
            <div aria-hidden className="my-1 flex items-center gap-1">
              <span className="h-px flex-1 bg-border-strong" />
              <Plane className="h-3.5 w-3.5 rotate-90 text-fg-muted" />
              <span className="h-px flex-1 bg-border-strong" />
            </div>
            <p className="text-body-sm text-fg-muted">{stopsLabel(result.stops)}</p>
          </div>

          <p className="shrink-0 text-right">
            <span className="tabular block text-heading-md">{formatTime(last.arriveAt)}</span>
            <span className="block text-body-sm text-fg-muted">{last.destination}</span>
          </p>
        </div>

        <div className="hidden shrink-0 flex-col items-start gap-1 lg:flex">
          <Badge intent="neutral" size="sm">
            {CABIN_LABELS[result.fare.cabin] ?? result.fare.cabin}
          </Badge>
          {result.fare.refundable ? (
            <Badge intent="success" size="sm">
              Refundable
            </Badge>
          ) : null}
        </div>

        <div className="flex w-full shrink-0 items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end">
          <PriceTag cents={result.fare.totalCents} currency={result.fare.currency} />
          <Button
            size="sm"
            loading={selecting}
            data-testid="flight-result-select"
            data-dd-action-name="Select flight result"
            onClick={() => onSelect(result)}
          >
            Select
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="flight-result-expand"
          data-dd-action-name="View fare details"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex items-center gap-1.5 text-body-sm font-medium text-brand-600 hover:underline"
        >
          Flight details
          <ChevronDown
            aria-hidden
            className={cn('h-4 w-4 transition-transform duration-fast', expanded && 'rotate-180')}
          />
        </button>

        <button
          type="button"
          data-testid="flight-result-fare-rules"
          data-dd-action-name="View fare details"
          onClick={() => onViewDetails(result)}
          className="text-body-sm font-medium text-brand-600 hover:underline"
        >
          Fare rules and seats
        </button>

        <p className="ml-auto inline-flex items-center gap-1.5 text-body-sm text-fg-muted">
          <Luggage aria-hidden className="h-4 w-4" />
          {result.fare.baggageIncluded > 0
            ? `${result.fare.baggageIncluded} bag included`
            : 'Cabin bag only'}
        </p>
      </div>

      {expanded ? (
        <dl className="space-y-3 border-t border-border bg-bg-sunken px-4 py-3">
          {result.segments.map((segment) => (
            <div
              key={`${segment.flightNumber}-${segment.departAt}`}
              className="flex flex-wrap gap-x-6 gap-y-1"
            >
              <dt className="sr-only">Segment</dt>
              <dd className="font-mono text-mono-sm text-fg">
                {segment.airlineCode}
                {segment.flightNumber}
              </dd>
              <dd className="tabular text-body-sm text-fg">
                {formatTime(segment.departAt)} {segment.origin} → {formatTime(segment.arriveAt)}{' '}
                {segment.destination}
              </dd>
              <dd className="text-body-sm text-fg-muted">
                {segment.aircraftType ?? 'Aircraft TBC'}
              </dd>
              <dd className="tabular text-body-sm text-fg-muted">
                {formatDuration(segment.durationMinutes)}
              </dd>
            </div>
          ))}
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3">
            <dt className="text-body-sm text-fg-muted">Fare basis</dt>
            <dd className="font-mono text-mono-sm text-fg">{result.fare.fareClassCode}</dd>
            <dt className="text-body-sm text-fg-muted">Changes</dt>
            <dd className="text-body-sm text-fg">
              {result.fare.changeable ? 'Permitted, fee may apply' : 'Not permitted'}
            </dd>
            <dt className="text-body-sm text-fg-muted">Seats left</dt>
            <dd className="tabular text-body-sm text-fg">{result.fare.seatsRemaining}</dd>
          </div>
        </dl>
      ) : null}
    </li>
  );
}
