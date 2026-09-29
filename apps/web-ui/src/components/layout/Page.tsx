import { cn } from '@/lib/cn';

/** 1200 px max width, 24 px gutters at `lg`+ (04-STYLING.md § 3). */
export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn('mx-auto max-w-content px-4 lg:px-6', className)}>{children}</div>;
}

export function PageHeading({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-display-sm">{title}</h1>
        {description ? <p className="mt-2 text-body-lg text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Shown while a lazily-loaded route chunk is in flight. */
export function RouteFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading"
      className="mx-auto max-w-content px-4 py-16 lg:px-6"
    >
      <div className="v-skeleton h-8 w-64 rounded-sm" />
      <div className="mt-6 space-y-3">
        <div className="v-skeleton h-24 rounded-md" />
        <div className="v-skeleton h-24 rounded-md" />
        <div className="v-skeleton h-24 rounded-md" />
      </div>
    </div>
  );
}
