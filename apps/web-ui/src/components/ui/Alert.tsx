import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

export type AlertIntent = 'success' | 'info' | 'warning' | 'danger';

const INTENTS: Record<AlertIntent, { className: string; icon: React.ReactNode }> = {
  success: {
    className: 'border-success-500/30 bg-success-50 text-success-700',
    icon: <CheckCircle2 aria-hidden className="h-5 w-5" />,
  },
  info: {
    className: 'border-info-500/30 bg-info-50 text-info-700',
    icon: <Info aria-hidden className="h-5 w-5" />,
  },
  warning: {
    className: 'border-warning-500/30 bg-warning-50 text-warning-700',
    icon: <AlertTriangle aria-hidden className="h-5 w-5" />,
  },
  danger: {
    className: 'border-danger-500/30 bg-danger-50 text-danger-700',
    icon: <XCircle aria-hidden className="h-5 w-5" />,
  },
};

export interface AlertProps {
  intent: AlertIntent;
  title?: string;
  onDismiss?: () => void;
  testId?: string;
  className?: string;
  children?: React.ReactNode;
}

export function Alert({
  intent,
  title,
  onDismiss,
  testId = 'alert',
  className,
  children,
}: AlertProps) {
  const { className: intentClass, icon } = INTENTS[intent];

  return (
    <div
      role={intent === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      className={cn('flex items-start gap-3 rounded-md border p-3', intentClass, className)}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="text-body-md font-semibold">{title}</p> : null}
        {children ? <div className={cn('text-body-sm', title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {onDismiss ? (
        <IconButton
          aria-label="Dismiss"
          size="sm"
          data-testid={`${testId}-dismiss`}
          onClick={onDismiss}
          className="shrink-0 text-current hover:bg-black/5"
        >
          <X aria-hidden className="h-4 w-4" />
        </IconButton>
      ) : null}
    </div>
  );
}
