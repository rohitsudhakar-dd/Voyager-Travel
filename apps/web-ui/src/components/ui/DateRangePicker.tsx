import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { useMediaQuery, useOnClickOutside } from '@/lib/hooks';
import { IconButton } from './IconButton';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export interface DateRangePickerProps {
  /** `range` for return trips and hotel stays, `single` for one-ways. */
  mode: 'single' | 'range';
  startLabel: string;
  endLabel?: string;
  /** ISO `YYYY-MM-DD`. */
  start: string;
  end?: string;
  minDate: string;
  maxDate: string;
  error?: string;
  onChange: (next: { start: string; end?: string }) => void;
  testId?: string;
}

const toIso = (date: Date) => format(date, 'yyyy-MM-dd');

function monthGrid(month: Date) {
  return eachDayOfInterval({
    start: startOfWeek(startOfMonth(month), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(month), { weekStartsOn: 1 }),
  });
}

export function DateRangePicker({
  mode,
  startLabel,
  endLabel,
  start,
  end,
  minDate,
  maxDate,
  error,
  onChange,
  testId = 'date-range-picker',
}: DateRangePickerProps) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(parseISO(start || minDate)));
  const [picking, setPicking] = useState<'start' | 'end'>('start');
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = useMediaQuery('(max-width: 767px)');

  useOnClickOutside(containerRef, () => setOpen(false), open && !isMobile);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const min = parseISO(minDate);
  const max = parseISO(maxDate);
  const startDate = start ? parseISO(start) : null;
  const endDate = end ? parseISO(end) : null;

  const disabledDay = (day: Date) => isBefore(day, min) || isAfter(day, max);

  const select = (day: Date) => {
    const iso = toIso(day);
    if (mode === 'single') {
      onChange({ start: iso });
      setOpen(false);
      return;
    }

    if (picking === 'start' || !startDate || isBefore(day, startDate)) {
      onChange({ start: iso, end: undefined });
      setPicking('end');
      return;
    }

    onChange({ start, end: iso });
    setPicking('start');
    setOpen(false);
  };

  const inRange = (day: Date) =>
    Boolean(startDate && endDate && isAfter(day, startDate) && isBefore(day, endDate));

  const months = isMobile ? [month] : [month, addMonths(month, 1)];

  const calendar = (
    <div
      role="dialog"
      aria-modal={isMobile}
      aria-label={mode === 'range' ? 'Choose dates' : 'Choose a date'}
      className={cn(
        'bg-bg-elevated p-4',
        isMobile
          ? 'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-auto rounded-t-xl shadow-xl animate-slide-in-bottom'
          : 'absolute left-0 top-full z-30 mt-1 rounded-lg border border-border shadow-lg',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <IconButton
          aria-label="Previous month"
          data-testid="date-prev-month"
          size="sm"
          onClick={() => setMonth((current) => subMonths(current, 1))}
          disabled={isSameMonth(month, min) || isBefore(month, min)}
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </IconButton>
        <p aria-live="polite" className="text-heading-sm">
          {months.map((m) => format(m, 'MMMM yyyy')).join(' – ')}
        </p>
        <IconButton
          aria-label="Next month"
          data-testid="date-next-month"
          size="sm"
          onClick={() => setMonth((current) => addMonths(current, 1))}
          disabled={isAfter(addMonths(month, 1), max)}
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </IconButton>
      </div>

      <div className={cn('grid gap-6', months.length > 1 && 'grid-cols-2')}>
        {months.map((current) => (
          <div key={current.toISOString()}>
            <div className="mb-1 grid grid-cols-7 gap-1">
              {WEEKDAYS.map((day) => (
                <span key={day} className="text-center text-caption text-fg-muted">
                  {day}
                </span>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {monthGrid(current).map((day) => {
                const outside = !isSameMonth(day, current);
                const disabled = disabledDay(day);
                const selected =
                  (startDate && isSameDay(day, startDate)) || (endDate && isSameDay(day, endDate));
                return (
                  <button
                    key={day.toISOString()}
                    type="button"
                    disabled={disabled || outside}
                    aria-label={format(day, 'EEEE d MMMM yyyy')}
                    aria-pressed={Boolean(selected)}
                    data-testid="date-cell"
                    onClick={() => select(day)}
                    className={cn(
                      'tabular h-9 rounded-sm text-body-sm transition-colors duration-fast',
                      outside && 'invisible',
                      disabled && 'cursor-not-allowed text-fg-muted opacity-40',
                      !disabled && !selected && 'hover:bg-bg-sunken',
                      inRange(day) && 'bg-brand-50 text-brand-800',
                      selected && 'bg-brand-600 font-semibold text-white',
                    )}
                  >
                    {format(day, 'd')}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {isMobile ? (
        <button
          type="button"
          onClick={() => setOpen(false)}
          data-testid="date-picker-done"
          className="mt-4 h-11 w-full rounded-md bg-brand-600 text-body-md font-semibold text-white"
        >
          Done
        </button>
      ) : null}
    </div>
  );

  return (
    <div ref={containerRef} className="relative">
      <div className={cn('grid gap-3', mode === 'range' && 'grid-cols-2')}>
        <FieldButton
          id={`${baseId}-start`}
          label={startLabel}
          value={start}
          invalid={Boolean(error)}
          testId={`${testId}-start`}
          onClick={() => {
            setPicking('start');
            setOpen(true);
          }}
        />
        {mode === 'range' ? (
          <FieldButton
            id={`${baseId}-end`}
            label={endLabel ?? 'To'}
            value={end}
            invalid={Boolean(error)}
            testId={`${testId}-end`}
            onClick={() => {
              setPicking('end');
              setOpen(true);
            }}
          />
        ) : null}
      </div>

      {error ? (
        <p role="alert" aria-live="polite" className="mt-1.5 text-caption text-danger-700">
          {error}
        </p>
      ) : null}

      {open ? calendar : null}
      {open && isMobile ? (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-neutral-900/50"
          onClick={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function FieldButton({
  id,
  label,
  value,
  invalid,
  testId,
  onClick,
}: {
  id: string;
  label: string;
  value?: string;
  invalid: boolean;
  testId: string;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-caption font-medium text-fg">
        {label}
      </label>
      <button
        id={id}
        type="button"
        onClick={onClick}
        data-testid={testId}
        aria-invalid={invalid || undefined}
        className={cn(
          'flex h-10 items-center gap-2 rounded-md border bg-bg-elevated px-3 text-left',
          'text-body-md text-fg',
          invalid ? 'border-danger-500' : 'border-border-strong',
        )}
      >
        <Calendar aria-hidden className="h-4 w-4 shrink-0 text-fg-muted" />
        <span className={cn('tabular truncate', !value && 'text-fg-muted')}>
          {value ? format(parseISO(value), 'EEE d MMM') : 'Select a date'}
        </span>
      </button>
    </div>
  );
}
