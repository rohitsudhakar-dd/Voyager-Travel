import { useId } from 'react';
import { cn } from '@/lib/cn';

interface SliderBase {
  label: string;
  min: number;
  max: number;
  step?: number;
  /** Renders the current value(s) above the track. */
  formatValue?: (value: number) => string;
  disabled?: boolean;
  testId?: string;
  className?: string;
}

export interface SingleSliderProps extends SliderBase {
  value: number;
  onChange: (value: number) => void;
  /** Fires once per gesture, so a drag produces one request rather than many. */
  onCommit?: (value: number) => void;
  labelHidden?: boolean;
}

export interface RangeSliderProps extends SliderBase {
  value: [number, number];
  onChange: (value: [number, number]) => void;
}

const TRACK = 'h-1.5 w-full rounded-full bg-bg-sunken';

const THUMB = cn(
  'pointer-events-none absolute inset-x-0 h-1.5 w-full appearance-none bg-transparent',
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4',
  '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
  '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand-600',
  '[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-xs',
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4',
  '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2',
  '[&::-moz-range-thumb]:border-brand-600 [&::-moz-range-thumb]:bg-white',
);

export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  formatValue,
  disabled,
  onChange,
  onCommit,
  labelHidden,
  testId,
  className,
}: SingleSliderProps) {
  const id = useId();
  const percent = ((value - min) / (max - min)) * 100;

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className={cn('flex items-baseline justify-between gap-2', labelHidden && 'sr-only')}>
        <label htmlFor={id} className="text-caption font-medium text-fg">
          {label}
        </label>
        <span className="tabular text-caption text-fg-muted">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>

      <div className="relative flex h-4 items-center">
        <div className={TRACK}>
          <div
            aria-hidden
            className="h-1.5 rounded-full bg-brand-600"
            style={{ width: `${percent}%` }}
          />
        </div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          data-testid={testId}
          aria-valuetext={formatValue ? formatValue(value) : undefined}
          onChange={(event) => onChange(Number(event.target.value))}
          onPointerUp={
            onCommit ? (event) => onCommit(Number(event.currentTarget.value)) : undefined
          }
          onKeyUp={onCommit ? (event) => onCommit(Number(event.currentTarget.value)) : undefined}
          className={THUMB}
        />
      </div>
    </div>
  );
}

/**
 * Two overlaid native range inputs. Less pretty than a custom drag
 * implementation and considerably more accessible.
 */
export function RangeSlider({
  label,
  min,
  max,
  step = 1,
  value,
  formatValue,
  disabled,
  onChange,
  testId = 'range-slider',
  className,
}: RangeSliderProps) {
  const id = useId();
  const [low, high] = value;
  const leftPercent = ((low - min) / (max - min)) * 100;
  const rightPercent = ((high - min) / (max - min)) * 100;
  const display = formatValue ?? ((v: number) => String(v));

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-caption font-medium text-fg">{label}</span>
        <span className="tabular text-caption text-fg-muted">
          {display(low)} – {display(high)}
        </span>
      </div>

      <div className="relative flex h-4 items-center">
        <div className={TRACK}>
          <div
            aria-hidden
            className="h-1.5 rounded-full bg-brand-600"
            style={{
              marginLeft: `${leftPercent}%`,
              width: `${Math.max(rightPercent - leftPercent, 0)}%`,
            }}
          />
        </div>

        <input
          id={`${id}-low`}
          type="range"
          aria-label={`${label}, minimum`}
          min={min}
          max={max}
          step={step}
          value={low}
          disabled={disabled}
          data-testid={`${testId}-min`}
          aria-valuetext={display(low)}
          onChange={(event) => onChange([Math.min(Number(event.target.value), high), high])}
          className={THUMB}
        />
        <input
          id={`${id}-high`}
          type="range"
          aria-label={`${label}, maximum`}
          min={min}
          max={max}
          step={step}
          value={high}
          disabled={disabled}
          data-testid={`${testId}-max`}
          aria-valuetext={display(high)}
          onChange={(event) => onChange([low, Math.max(Number(event.target.value), low)])}
          className={THUMB}
        />
      </div>
    </div>
  );
}
