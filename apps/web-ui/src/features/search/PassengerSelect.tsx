import type { PassengerCounts } from '@voyager/shared-schemas';
import { ChevronDown, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import { QuantityStepper } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useOnClickOutside } from '@/lib/hooks';
import { pluralise } from '@/lib/format';

export interface PassengerSelectProps {
  value: PassengerCounts;
  onChange: (value: PassengerCounts) => void;
  error?: string;
}

/** 1-9 travellers, infants never outnumber adults (05-FUNCTIONALITY.md § 15). */
export function PassengerSelect({ value, onChange, error }: PassengerSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useOnClickOutside(containerRef, () => setOpen(false), open);

  const total = value.adults + value.children + value.infants;
  const remaining = 9 - total;

  return (
    <div ref={containerRef} className="relative flex flex-col gap-1.5">
      <span className="text-caption font-medium text-fg">Travellers</span>
      <button
        type="button"
        data-testid="search-passengers"
        aria-expanded={open}
        aria-invalid={error ? true : undefined}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex h-10 items-center gap-2 rounded-md border bg-bg-elevated px-3 text-left text-body-md',
          error ? 'border-danger-500' : 'border-border-strong',
        )}
      >
        <Users aria-hidden className="h-4 w-4 shrink-0 text-fg-muted" />
        <span className="truncate">{pluralise(total, 'traveller')}</span>
        <ChevronDown aria-hidden className="ml-auto h-4 w-4 shrink-0 text-fg-muted" />
      </button>

      {error ? (
        <p role="alert" className="text-caption text-danger-700">
          {error}
        </p>
      ) : null}

      {open ? (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 space-y-4 rounded-md border border-border bg-bg-elevated p-4 shadow-lg">
          <QuantityStepper
            label="Adults"
            hint="12 and over"
            testId="passengers-adults"
            value={value.adults}
            min={1}
            max={Math.min(9, value.adults + remaining)}
            onChange={(adults) =>
              onChange({ ...value, adults, infants: Math.min(value.infants, adults) })
            }
          />
          <QuantityStepper
            label="Children"
            hint="2 to 11"
            testId="passengers-children"
            value={value.children}
            min={0}
            max={Math.min(8, value.children + remaining)}
            onChange={(children) => onChange({ ...value, children })}
          />
          <QuantityStepper
            label="Infants"
            hint="Under 2, on an adult's lap"
            testId="passengers-infants"
            value={value.infants}
            min={0}
            max={Math.min(value.adults, value.infants + remaining)}
            onChange={(infants) => onChange({ ...value, infants })}
          />
          <p className="text-caption text-fg-muted">
            Up to 9 travellers per booking. Every infant travels with an adult.
          </p>
        </div>
      ) : null}
    </div>
  );
}
