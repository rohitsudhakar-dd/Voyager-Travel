import { Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useDebouncedValue, useOnClickOutside } from '@/lib/hooks';

export interface ComboboxProps<T> {
  label: string;
  /** Text shown when nothing is being typed -- the current selection. */
  displayValue: string;
  placeholder?: string;
  items: T[];
  loading?: boolean;
  error?: string;
  hint?: string;
  disabled?: boolean;
  /** 250 ms, per 04-STYLING.md § 4.1. */
  debounceMs?: number;
  minQueryLength?: number;
  getKey: (item: T) => string;
  renderItem: (item: T) => React.ReactNode;
  onQueryChange: (query: string) => void;
  onSelect: (item: T) => void;
  /** `data-*` is included explicitly; an object literal does not get JSX's leniency. */
  inputProps?: React.InputHTMLAttributes<HTMLInputElement> & Record<`data-${string}`, string>;
  leadingIcon?: React.ReactNode;
  containerClassName?: string;
}

/**
 * Async autocomplete for airports and cities. The debounce lives here so every
 * consumer gets the same request cadence -- which also keeps the gateway trace
 * volume predictable.
 */
export function Combobox<T>({
  label,
  displayValue,
  placeholder,
  items,
  loading = false,
  error,
  hint,
  disabled,
  debounceMs = 250,
  minQueryLength = 2,
  getKey,
  renderItem,
  onQueryChange,
  onSelect,
  inputProps,
  leadingIcon,
  containerClassName,
}: ComboboxProps<T>) {
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const errorId = `${baseId}-error`;
  const hintId = `${baseId}-hint`;

  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebouncedValue(query, debounceMs);

  useEffect(() => {
    if (typing && debouncedQuery.trim().length >= minQueryLength) onQueryChange(debouncedQuery);
  }, [debouncedQuery, typing, minQueryLength, onQueryChange]);

  useOnClickOutside(containerRef, () => setOpen(false), open);

  const close = () => {
    setOpen(false);
    setTyping(false);
    setQuery('');
    setActiveIndex(-1);
  };

  const choose = (item: T) => {
    onSelect(item);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        if (items.length === 0) return -1;
        const next = current + delta;
        if (next < 0) return items.length - 1;
        if (next >= items.length) return 0;
        return next;
      });
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && items[activeIndex]) {
        event.preventDefault();
        choose(items[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      close();
    } else if (event.key === 'Home' && open) {
      setActiveIndex(0);
    } else if (event.key === 'End' && open) {
      setActiveIndex(items.length - 1);
    }
  };

  const showList = open && (loading || items.length > 0 || query.trim().length >= minQueryLength);

  return (
    <div ref={containerRef} className={cn('relative flex flex-col gap-1.5', containerClassName)}>
      <label htmlFor={baseId} className="text-caption font-medium text-fg">
        {label}
      </label>

      <div
        className={cn(
          'flex items-center gap-2 rounded-md border bg-bg-elevated px-3',
          'focus-within:ring-2 focus-within:ring-brand-500/30',
          error ? 'border-danger-500' : 'border-border-strong',
          disabled && 'opacity-60',
        )}
      >
        {leadingIcon ? (
          <span aria-hidden className="shrink-0 text-fg-muted">
            {leadingIcon}
          </span>
        ) : null}
        <input
          id={baseId}
          role="combobox"
          autoComplete="off"
          disabled={disabled}
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
          }
          placeholder={placeholder}
          value={typing ? query : displayValue}
          onChange={(event) => {
            setTyping(true);
            setOpen(true);
            setActiveIndex(-1);
            setQuery(event.target.value);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-10 w-full min-w-0 border-0 bg-transparent p-0 text-body-md text-fg placeholder:text-fg-muted focus:ring-0"
          {...inputProps}
        />
        {loading ? (
          <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-fg-muted" />
        ) : null}
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

      {showList ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          aria-busy={loading || undefined}
          className={cn(
            'absolute top-full z-30 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border',
            'bg-bg-elevated py-1 shadow-lg',
          )}
        >
          {items.length === 0 ? (
            <li className="px-3 py-2 text-body-sm text-fg-muted">
              {loading ? 'Searching…' : 'No matches'}
            </li>
          ) : (
            items.map((item, index) => (
              <li
                key={getKey(item)}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-testid="combobox-option"
                data-dd-action-name="Select airport suggestion"
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-body-md',
                  index === activeIndex ? 'bg-brand-50 text-brand-800' : 'text-fg',
                )}
              >
                {renderItem(item)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
