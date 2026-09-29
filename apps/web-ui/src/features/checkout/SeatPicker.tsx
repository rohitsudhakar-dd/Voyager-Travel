import { useMemo } from 'react';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatMoney, priceBand } from '@/lib/format';

const ROWS = [10, 11, 12, 13, 14, 15, 16, 17];
const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const EXTRA_LEGROOM_ROW = 10;

export interface Seat {
  id: string;
  row: number;
  column: string;
  available: boolean;
  priceCents: number;
}

/**
 * A representative cabin section rather than a real aircraft layout -- enough
 * to make `Select seat` a real interaction with a real re-price. Availability
 * is derived from the booking id so the same booking always shows the same map.
 */
export function buildSeatMap(seed: string, currencyBase = 800): Seat[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const seats: Seat[] = [];
  for (const row of ROWS) {
    for (const column of COLUMNS) {
      hash = Math.imul(hash ^ (row * 31 + column.charCodeAt(0)), 16777619);
      const roll = (hash >>> 8) % 100;
      const window = column === 'A' || column === 'F';
      const aisle = column === 'C' || column === 'D';
      const legroom = row === EXTRA_LEGROOM_ROW;
      seats.push({
        id: `${row}${column}`,
        row,
        column,
        available: roll > 34,
        priceCents: currencyBase + (legroom ? 1_400 : 0) + (window ? 400 : 0) + (aisle ? 200 : 0),
      });
    }
  }
  return seats;
}

export interface SeatPickerProps {
  seed: string;
  currency: string;
  /** One entry per traveller; `null` means no seat chosen yet. */
  selections: (string | null)[];
  activeTraveller: number;
  onSelect: (seatId: string, priceCents: number) => void;
}

export function SeatPicker({
  seed,
  currency,
  selections,
  activeTraveller,
  onSelect,
}: SeatPickerProps) {
  const seats = useMemo(() => buildSeatMap(seed), [seed]);
  const taken = new Set(selections.filter((seat): seat is string => Boolean(seat)));

  return (
    <div data-testid="seat-picker">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-caption text-fg-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-3 rounded-sm border border-border bg-bg-elevated" />
          Available
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-3 rounded-sm bg-brand-600" />
          Your seat
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-3 rounded-sm bg-bg-sunken" />
          Taken
        </span>
        <Badge intent="neutral" size="sm">
          Row {EXTRA_LEGROOM_ROW} has extra legroom
        </Badge>
      </div>

      <div className="space-y-1.5">
        {ROWS.map((row) => (
          <div key={row} className="flex items-center gap-1.5">
            <span className="tabular w-6 text-right text-caption text-fg-muted">{row}</span>
            {COLUMNS.map((column, index) => {
              const seat = seats.find((candidate) => candidate.id === `${row}${column}`)!;
              const mine = taken.has(seat.id);
              const isActive = selections[activeTraveller] === seat.id;
              const disabled = !seat.available || (mine && !isActive);

              return (
                <div key={column} className="flex items-center">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Seat ${seat.id}, ${
                      seat.available ? formatMoney(seat.priceCents, currency) : 'unavailable'
                    }`}
                    aria-pressed={isActive}
                    data-dd-action-name="Select seat"
                    data-price-band={priceBand(seat.priceCents)}
                    onClick={() => onSelect(seat.id, seat.priceCents)}
                    className={cn(
                      'h-8 w-8 rounded-sm border text-caption font-medium transition-colors duration-fast',
                      isActive && 'border-brand-700 bg-brand-600 text-white',
                      !isActive &&
                        seat.available &&
                        'border-border bg-bg-elevated hover:border-brand-500',
                      !seat.available &&
                        'cursor-not-allowed border-transparent bg-bg-sunken text-fg-subtle',
                      mine && !isActive && 'border-brand-200 bg-brand-100 text-brand-700',
                    )}
                  >
                    {column}
                  </button>
                  {index === 2 ? <span aria-hidden className="w-5" /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
