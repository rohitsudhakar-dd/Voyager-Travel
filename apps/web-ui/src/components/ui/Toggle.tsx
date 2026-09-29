import { useId } from 'react';
import { cn } from '@/lib/cn';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: React.ReactNode;
  disabled?: boolean;
  labelHidden?: boolean;
  testId?: string;
  actionName?: string;
  className?: string;
}

/** The chaos panel's workhorse. A real checkbox underneath, styled as a switch. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  labelHidden,
  testId,
  actionName,
  className,
}: ToggleProps) {
  const id = useId();

  return (
    <div className={cn('flex items-start gap-3', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={labelHidden ? label : undefined}
        aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled}
        data-testid={testId}
        data-dd-action-name={actionName}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-fast',
          checked ? 'bg-brand-600' : 'bg-neutral-300',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-xs transition-transform duration-fast',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
          )}
        />
      </button>

      {labelHidden ? null : (
        <div className="min-w-0">
          <label htmlFor={id} className="block cursor-pointer text-body-md font-medium text-fg">
            {label}
          </label>
          {description ? (
            <div id={`${id}-description`} className="text-body-sm text-fg-muted">
              {description}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
