import type { ServiceHealth } from '@voyager/shared-schemas';
import { cn } from '@/lib/cn';

const COLORS: Record<ServiceHealth, string> = {
  healthy: 'bg-success-500',
  degraded: 'bg-warning-500',
  down: 'bg-danger-500',
  unknown: 'bg-neutral-400',
};

const LABELS: Record<ServiceHealth, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
};

export interface StatusDotProps {
  status: ServiceHealth;
  pulse?: boolean;
  showLabel?: boolean;
  className?: string;
}

export function StatusDot({ status, pulse, showLabel, className }: StatusDotProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        {pulse ? (
          <span
            aria-hidden
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
              COLORS[status],
            )}
          />
        ) : null}
        <span
          aria-hidden
          className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', COLORS[status])}
        />
      </span>
      <span className={showLabel ? 'text-body-sm text-fg-muted' : 'sr-only'}>{LABELS[status]}</span>
    </span>
  );
}
