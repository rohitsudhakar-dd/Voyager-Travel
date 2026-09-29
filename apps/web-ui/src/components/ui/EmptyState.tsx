import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
  className?: string;
}

/** No illustrations. A transactional product does not need a cartoon. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  testId = 'empty-state',
  className,
}: EmptyStateProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-border bg-bg-elevated px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          className="flex h-11 w-11 items-center justify-center rounded-full bg-bg-sunken text-fg-muted"
        >
          {icon}
        </span>
      ) : null}
      <h2 className="text-heading-sm">{title}</h2>
      {description ? (
        <div className="max-w-md text-body-md text-fg-muted">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
