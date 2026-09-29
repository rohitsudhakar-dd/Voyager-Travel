import { cn } from '@/lib/cn';

/**
 * Voyager's wordmark: a compass rose reduced to two crossed chevrons, drawn
 * from the brand token. Invented, like everything else in this app.
 */
export function Logo({ className, mono }: { className?: string; mono?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 28 28" aria-hidden className="h-7 w-7 shrink-0">
        <rect width="28" height="28" rx="8" fill={mono ? 'currentColor' : 'var(--v-brand-600)'} />
        <path
          d="M8 10.5 14 20l6-9.5-6 3-6-3Z"
          fill={mono ? 'var(--v-bg-elevated)' : '#ffffff'}
          fillOpacity="0.95"
        />
      </svg>
      <span className="text-heading-md font-bold tracking-tight">Voyager</span>
    </span>
  );
}
