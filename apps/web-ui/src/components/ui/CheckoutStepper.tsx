import { Check } from 'lucide-react';
import { cn } from '@/lib/cn';

export const CHECKOUT_STEPS = ['Review', 'Passengers', 'Payment', 'Confirmation'] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

export interface CheckoutStepperProps {
  /** Zero-based index into CHECKOUT_STEPS. */
  current: number;
  /** Completed steps are clickable so a traveller can go back and change something. */
  onNavigate?: (index: number) => void;
  className?: string;
}

/**
 * Horizontal on `md`+, "Step 2 of 4" on `sm` (04-STYLING.md § 4.5). Rendered as
 * an ordered list so the sequence is conveyed without the visuals.
 */
export function CheckoutStepper({ current, onNavigate, className }: CheckoutStepperProps) {
  return (
    <nav aria-label="Checkout progress" className={className} data-testid="checkout-stepper">
      <p className="text-body-sm font-medium text-fg-muted md:hidden">
        Step {current + 1} of {CHECKOUT_STEPS.length} — {CHECKOUT_STEPS[current]}
      </p>

      <ol className="hidden items-center gap-2 md:flex">
        {CHECKOUT_STEPS.map((step, index) => {
          const complete = index < current;
          const active = index === current;
          const clickable = complete && Boolean(onNavigate);

          return (
            <li key={step} className="flex items-center gap-2">
              <button
                type="button"
                disabled={!clickable}
                aria-current={active ? 'step' : undefined}
                data-testid={`checkout-step-${step.toLowerCase()}`}
                onClick={clickable ? () => onNavigate?.(index) : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-full px-1 py-0.5 text-body-sm',
                  clickable ? 'cursor-pointer hover:underline' : 'cursor-default',
                  active ? 'font-semibold text-fg' : 'text-fg-muted',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'tabular flex h-6 w-6 items-center justify-center rounded-full text-caption font-semibold',
                    complete && 'bg-brand-600 text-white',
                    active && 'bg-bg-elevated text-brand-700 ring-2 ring-brand-600',
                    !complete && !active && 'bg-bg-sunken text-fg-muted',
                  )}
                >
                  {complete ? <Check className="h-3.5 w-3.5" /> : index + 1}
                </span>
                {step}
              </button>

              {index < CHECKOUT_STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className={cn('h-px w-8 lg:w-12', complete ? 'bg-brand-600' : 'bg-border')}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
