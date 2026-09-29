import { forwardRef, useId } from 'react';
import { cn } from '@/lib/cn';

// `prefix` is a (legacy) HTML attribute typed as a string; ours is a node.
export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  label: string;
  hint?: string;
  error?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
  /** Renders a `n / max` counter; requires `maxLength`. */
  showCounter?: boolean;
  labelHidden?: boolean;
  containerClassName?: string;
}

/**
 * Every input has a real `<label>`, and its error is linked with
 * `aria-describedby` and announced politely (04-STYLING.md § 7).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    prefix,
    suffix,
    showCounter,
    labelHidden,
    className,
    containerClassName,
    id,
    maxLength,
    value,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  const length = typeof value === 'string' ? value.length : 0;

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor={inputId}
          className={cn('text-caption font-medium text-fg', labelHidden && 'sr-only')}
        >
          {label}
        </label>
        {showCounter && maxLength ? (
          <span className="tabular text-caption text-fg-muted">
            {length} / {maxLength}
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          'flex items-center gap-2 rounded-md border bg-bg-elevated px-3',
          'focus-within:ring-2 focus-within:ring-brand-500/30',
          error ? 'border-danger-500' : 'border-border-strong',
        )}
      >
        {prefix ? <span className="shrink-0 text-fg-muted">{prefix}</span> : null}
        <input
          ref={ref}
          id={inputId}
          maxLength={maxLength}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            'h-10 w-full min-w-0 border-0 bg-transparent p-0 text-body-md text-fg',
            'placeholder:text-fg-muted focus:ring-0',
            className,
          )}
          {...rest}
        />
        {suffix ? <span className="shrink-0 text-fg-muted">{suffix}</span> : null}
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
