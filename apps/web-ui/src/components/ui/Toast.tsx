import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';
import { cn } from '@/lib/cn';
import { type Toast as ToastModel, type ToastIntent, useToastStore } from '@/store/toasts';
import { IconButton } from './IconButton';

const INTENTS: Record<ToastIntent, { className: string; icon: React.ReactNode }> = {
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

/** One region per app, announced politely so a screen reader hears every toast. */
export function ToastRegion() {
  const toasts = useToastStore((state) => state.toasts);

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((item) => (
        <ToastItem key={item.id} toast={item} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: ToastModel }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const { className, icon } = INTENTS[toast.intent];

  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const timer = window.setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div
      data-testid="toast"
      className={cn(
        'pointer-events-auto flex items-start gap-3 rounded-md border p-3 shadow-md animate-slide-up',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-body-md font-semibold">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-body-sm">{toast.description}</p> : null}
      </div>
      <IconButton
        aria-label="Dismiss notification"
        size="sm"
        data-testid="toast-dismiss"
        onClick={() => dismiss(toast.id)}
        className="shrink-0 text-current hover:bg-black/5"
      >
        <X aria-hidden className="h-4 w-4" />
      </IconButton>
    </div>
  );
}
