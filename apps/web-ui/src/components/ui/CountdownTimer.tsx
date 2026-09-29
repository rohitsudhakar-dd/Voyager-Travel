import { Clock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { useTimeRemaining } from '@/lib/hooks';

export interface CountdownTimerProps {
  /** ISO timestamp. */
  deadline: string;
  label?: string;
  onExpire?: () => void;
  className?: string;
  testId?: string;
}

const WARNING_MS = 5 * 60_000;
const DANGER_MS = 60_000;

function mmss(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The hold timer. One of the most effective demo props in the app: during
 * scenario S2 the audience watches this run down while the payment retries.
 */
export function CountdownTimer({
  deadline,
  label = 'Your fare is held for',
  onExpire,
  className,
  testId = 'hold-countdown',
}: CountdownTimerProps) {
  const remaining = useTimeRemaining(deadline);
  const fired = useRef(false);

  useEffect(() => {
    if (remaining === null || remaining > 0 || fired.current) return;
    fired.current = true;
    onExpire?.();
  }, [remaining, onExpire]);

  if (remaining === null) return null;

  const intent =
    remaining <= DANGER_MS ? 'danger' : remaining <= WARNING_MS ? 'warning' : 'neutral';

  return (
    <p
      data-testid={testId}
      // Only announce as the deadline approaches; a per-second live region is
      // unusable with a screen reader.
      aria-live={intent === 'neutral' ? 'off' : 'polite'}
      className={cn(
        'inline-flex items-center gap-1.5 text-body-sm font-medium',
        intent === 'danger' && 'text-danger-500',
        intent === 'warning' && 'text-warning-500',
        intent === 'neutral' && 'text-fg-muted',
        className,
      )}
    >
      <Clock aria-hidden className="h-4 w-4" />
      {remaining <= 0 ? (
        'Your fare hold has expired'
      ) : (
        <>
          {label} <span className="tabular font-semibold">{mmss(remaining)}</span>
        </>
      )}
    </p>
  );
}
