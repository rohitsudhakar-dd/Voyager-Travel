import type { Airline, FlightFilters, HotelFilters } from '@voyager/shared-schemas';
import { Star } from 'lucide-react';
import { Badge, Button, RangeSlider, Slider } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatDuration, formatMoney } from '@/lib/format';
import { activeFilterCount } from './searchParams';

/**
 * The filter sidebar from 04-STYLING.md § 4.4. Every change re-queries the
 * gateway, which is deliberate: the searches are cache hits, so they cost
 * almost nothing and give the demo a healthy p50 to sit beside a fat p99.
 */

const DEPART_WINDOWS: Array<{ id: string; label: string; window: [string, string] }> = [
  { id: 'early', label: 'Before 06:00', window: ['00:00', '06:00'] },
  { id: 'morning', label: '06:00 – 12:00', window: ['06:00', '12:00'] },
  { id: 'afternoon', label: '12:00 – 18:00', window: ['12:00', '18:00'] },
  { id: 'evening', label: 'After 18:00', window: ['18:00', '23:59'] },
];

const HOTEL_AMENITIES = ['wifi', 'pool', 'gym', 'parking', 'breakfast', 'restaurant'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-4 last:border-b-0">
      <h3 className="mb-3 text-heading-sm">{title}</h3>
      {children}
    </section>
  );
}

function CheckboxRow({
  label,
  checked,
  onChange,
  testId,
  actionName,
  suffix,
}: {
  label: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
  actionName: string;
  suffix?: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 py-1 text-body-md">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
        data-dd-action-name={actionName}
        className="rounded-sm border-border-strong text-brand-600 focus:ring-brand-500"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {suffix}
    </label>
  );
}

export interface FlightFilterPanelProps {
  filters: FlightFilters;
  onChange: (filters: FlightFilters) => void;
  airlines: Airline[];
  priceBounds: [number, number];
  durationBounds: [number, number];
  currency: string;
  className?: string;
}

export function FlightFilterPanel({
  filters,
  onChange,
  airlines,
  priceBounds,
  durationBounds,
  currency,
  className,
}: FlightFilterPanelProps) {
  const count = activeFilterCount(filters);
  const selectedAirlines = filters.airlines ?? [];

  const toggleAirline = (code: string, checked: boolean) => {
    const next = checked
      ? [...selectedAirlines, code]
      : selectedAirlines.filter((item) => item !== code);
    onChange({ ...filters, airlines: next.length ? next : undefined });
  };

  return (
    <div className={cn('rounded-lg border border-border bg-bg-elevated', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-heading-sm">
          Filters
          {count > 0 ? (
            <Badge intent="brand" size="sm" data-testid="filter-count">
              {count}
            </Badge>
          ) : null}
        </h2>
        <Button
          variant="link"
          size="sm"
          data-testid="filters-clear"
          disabled={count === 0}
          onClick={() => onChange({})}
        >
          Clear all
        </Button>
      </div>

      <Section title="Price">
        <RangeSlider
          label="Total price"
          min={priceBounds[0]}
          max={priceBounds[1]}
          step={1000}
          testId="filter-price"
          value={[filters.minPriceCents ?? priceBounds[0], filters.maxPriceCents ?? priceBounds[1]]}
          formatValue={(cents) => formatMoney(cents, currency)}
          onChange={([min, max]) =>
            onChange({
              ...filters,
              minPriceCents: min > priceBounds[0] ? min : undefined,
              maxPriceCents: max < priceBounds[1] ? max : undefined,
            })
          }
        />
      </Section>

      <Section title="Stops">
        {[
          { value: 0, label: 'Nonstop only' },
          { value: 1, label: 'Up to 1 stop' },
          { value: 2, label: 'Up to 2 stops' },
        ].map((option) => (
          <CheckboxRow
            key={option.value}
            label={option.label}
            checked={filters.maxStops === option.value}
            testId={`filter-stops-${option.value}`}
            actionName="Filter by stops"
            onChange={(checked) =>
              onChange({ ...filters, maxStops: checked ? option.value : undefined })
            }
          />
        ))}
      </Section>

      <Section title="Departure time">
        {DEPART_WINDOWS.map((option) => (
          <CheckboxRow
            key={option.id}
            label={option.label}
            checked={filters.departWindow?.[0] === option.window[0]}
            testId={`filter-depart-${option.id}`}
            actionName="Filter by time"
            onChange={(checked) =>
              onChange({ ...filters, departWindow: checked ? option.window : undefined })
            }
          />
        ))}
      </Section>

      <Section title="Duration">
        <Slider
          label="Maximum journey time"
          min={durationBounds[0]}
          max={durationBounds[1]}
          step={30}
          testId="filter-duration"
          value={filters.maxDurationMinutes ?? durationBounds[1]}
          formatValue={formatDuration}
          onChange={(minutes) =>
            onChange({
              ...filters,
              maxDurationMinutes: minutes < durationBounds[1] ? minutes : undefined,
            })
          }
        />
      </Section>

      {airlines.length > 0 ? (
        <Section title="Airlines">
          <div className="max-h-56 overflow-auto pr-1">
            {airlines.map((airline) => (
              <CheckboxRow
                key={airline.iataCode}
                label={airline.name}
                checked={selectedAirlines.includes(airline.iataCode)}
                testId={`filter-airline-${airline.iataCode}`}
                actionName="Filter by airline"
                onChange={(checked) => toggleAirline(airline.iataCode, checked)}
                suffix={
                  <span className="shrink-0 font-mono text-mono-sm text-fg-muted">
                    {airline.iataCode}
                  </span>
                }
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

export interface HotelFilterPanelProps {
  filters: HotelFilters;
  onChange: (filters: HotelFilters) => void;
  priceBounds: [number, number];
  neighborhoods: string[];
  currency: string;
  className?: string;
}

export function HotelFilterPanel({
  filters,
  onChange,
  priceBounds,
  neighborhoods,
  currency,
  className,
}: HotelFilterPanelProps) {
  const count = activeFilterCount(filters);
  const stars = filters.starRating ?? [];
  const amenities = filters.amenities ?? [];
  const areas = filters.neighborhoods ?? [];

  const toggle = <T,>(list: T[], item: T, checked: boolean) =>
    checked ? [...list, item] : list.filter((value) => value !== item);

  return (
    <div className={cn('rounded-lg border border-border bg-bg-elevated', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-heading-sm">
          Filters
          {count > 0 ? (
            <Badge intent="brand" size="sm" data-testid="filter-count">
              {count}
            </Badge>
          ) : null}
        </h2>
        <Button
          variant="link"
          size="sm"
          data-testid="filters-clear"
          disabled={count === 0}
          onClick={() => onChange({})}
        >
          Clear all
        </Button>
      </div>

      <Section title="Price per night">
        <RangeSlider
          label="Nightly price"
          min={priceBounds[0]}
          max={priceBounds[1]}
          step={500}
          testId="filter-price"
          value={[filters.minPriceCents ?? priceBounds[0], filters.maxPriceCents ?? priceBounds[1]]}
          formatValue={(cents) => formatMoney(cents, currency)}
          onChange={([min, max]) =>
            onChange({
              ...filters,
              minPriceCents: min > priceBounds[0] ? min : undefined,
              maxPriceCents: max < priceBounds[1] ? max : undefined,
            })
          }
        />
      </Section>

      <Section title="Star rating">
        {[5, 4, 3].map((rating) => (
          <CheckboxRow
            key={rating}
            label={
              <span className="flex items-center gap-0.5 text-accent-500">
                {Array.from({ length: rating }, (_, index) => (
                  <Star key={index} aria-hidden className="h-3.5 w-3.5 fill-current" />
                ))}
                <span className="sr-only">{rating} star</span>
              </span>
            }
            checked={stars.includes(rating)}
            testId={`filter-stars-${rating}`}
            actionName="Filter by stops"
            onChange={(checked) => {
              const next = toggle(stars, rating, checked);
              onChange({ ...filters, starRating: next.length ? next : undefined });
            }}
          />
        ))}
      </Section>

      <Section title="Review score">
        <Slider
          label="Minimum score"
          min={0}
          max={10}
          step={0.5}
          testId="filter-review-score"
          value={filters.minReviewScore ?? 0}
          formatValue={(value) => value.toFixed(1)}
          onChange={(value) =>
            onChange({ ...filters, minReviewScore: value > 0 ? value : undefined })
          }
        />
      </Section>

      <Section title="Amenities">
        {HOTEL_AMENITIES.map((amenity) => (
          <CheckboxRow
            key={amenity}
            label={<span className="capitalize">{amenity.replace(/_/g, ' ')}</span>}
            checked={amenities.includes(amenity)}
            testId={`filter-amenity-${amenity}`}
            actionName="Filter by airline"
            onChange={(checked) => {
              const next = toggle(amenities, amenity, checked);
              onChange({ ...filters, amenities: next.length ? next : undefined });
            }}
          />
        ))}
      </Section>

      {neighborhoods.length > 0 ? (
        <Section title="Neighbourhood">
          <div className="max-h-48 overflow-auto pr-1">
            {neighborhoods.map((area) => (
              <CheckboxRow
                key={area}
                label={area}
                checked={areas.includes(area)}
                testId={`filter-area-${area}`}
                actionName="Filter by airline"
                onChange={(checked) => {
                  const next = toggle(areas, area, checked);
                  onChange({ ...filters, neighborhoods: next.length ? next : undefined });
                }}
              />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
