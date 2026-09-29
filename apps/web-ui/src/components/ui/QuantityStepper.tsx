import { Minus, Plus } from 'lucide-react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

export interface QuantityStepperProps {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  testId?: string;
  /** Applied to the increment button, which is the action worth naming. */
  actionName?: string;
  className?: string;
}

/** Passengers, guests and rooms. Named apart from `CheckoutStepper` on purpose. */
export function QuantityStepper({
  label,
  hint,
  value,
  min = 0,
  max = 9,
  onChange,
  testId = 'quantity-stepper',
  actionName,
  className,
}: QuantityStepperProps) {
  const id = useId();
  const clamp = (next: number) => Math.min(Math.max(next, min), max);

  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-body-md font-medium text-fg">
          {label}
        </label>
        {hint ? <p className="text-caption text-fg-muted">{hint}</p> : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <IconButton
          aria-label={`Fewer ${label.toLowerCase()}`}
          variant="secondary"
          size="sm"
          data-testid={`${testId}-decrement`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1))}
        >
          <Minus aria-hidden className="h-4 w-4" />
        </IconButton>

        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          data-testid={testId}
          onChange={(event) => onChange(clamp(Number(event.target.value) || min))}
          className="tabular h-8 w-12 rounded-sm border border-border-strong bg-bg-elevated text-center text-body-md text-fg focus:border-brand-500"
        />

        <IconButton
          aria-label={`More ${label.toLowerCase()}`}
          variant="secondary"
          size="sm"
          data-testid={`${testId}-increment`}
          data-dd-action-name={actionName}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1))}
        >
          <Plus aria-hidden className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}
