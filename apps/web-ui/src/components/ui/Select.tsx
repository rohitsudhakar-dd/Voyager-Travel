import { ChevronDown } from 'lucide-react';
import { forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: SelectOption[];
  hint?: string;
  error?: string;
  labelHidden?: boolean;
  containerClassName?: string;
}

/** Native-backed, for reliability. The custom listbox variant is `Combobox`. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, hint, error, labelHidden, className, containerClassName, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      <label
        htmlFor={selectId}
        className={cn('text-caption font-medium text-fg', labelHidden && 'sr-only')}
      >
        {label}
      </label>

      <div className="relative">
        <select
          ref={ref}
          id={selectId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-10 w-full appearance-none rounded-md border bg-bg-elevated pl-3 pr-9',
            'text-body-md text-fg focus:border-brand-500 focus:ring-2 focus:ring-brand-500/30',
            error ? 'border-danger-500' : 'border-border-strong',
            className,
          )}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
        />
      </div>

      {hint && !error ? (
        <p id={hintId} className="text-caption text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" aria-live="polite" className="text-caption text-danger-700">
          {error}
        </p>
      ) : null}
    </div>
  );
});
