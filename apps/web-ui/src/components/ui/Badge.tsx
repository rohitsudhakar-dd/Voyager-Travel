import { cn } from '@/lib/cn';

export type BadgeIntent = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

const INTENTS: Record<BadgeIntent, string> = {
  neutral: 'bg-bg-sunken text-fg-muted border-border',
  brand: 'bg-brand-50 text-brand-700 border-brand-100',
  success: 'bg-success-50 text-success-700 border-success-500/20',
  warning: 'bg-warning-50 text-warning-700 border-warning-500/20',
  danger: 'bg-danger-50 text-danger-700 border-danger-500/20',
  info: 'bg-info-50 text-info-700 border-info-500/20',
};

const DOTS: Record<BadgeIntent, string> = {
  neutral: 'bg-neutral-400',
  brand: 'bg-brand-600',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger: 'bg-danger-500',
  info: 'bg-info-500',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  intent?: BadgeIntent;
  size?: BadgeSize;
  dot?: boolean;
}

export function Badge({
  intent = 'neutral',
  size = 'md',
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-caption' : 'px-2.5 py-1 text-caption',
        INTENTS[intent],
        className,
      )}
      {...rest}
    >
      {dot ? <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', DOTS[intent])} /> : null}
      {children}
    </span>
  );
}
