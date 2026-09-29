import { cn } from '@/lib/cn';

export type SkeletonShape = 'text' | 'circle' | 'rect';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  shape?: SkeletonShape;
  width?: string | number;
  height?: string | number;
}

/**
 * During chaos demos the audience stares at these, so they have to look
 * intentional -- and they must occupy exactly the space the real content will,
 * or the swap costs us CLS.
 */
export function Skeleton({
  shape = 'text',
  width,
  height,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={cn(
        'v-skeleton',
        shape === 'text' && 'h-4 rounded-sm',
        shape === 'circle' && 'rounded-full',
        shape === 'rect' && 'rounded-md',
        className,
      )}
      style={{ width, height, ...style }}
      {...rest}
    />
  );
}

/** Matches FlightResultRow's box model exactly. */
export function ResultRowSkeleton() {
  return (
    <div
      data-testid="flight-result-skeleton"
      className="flex items-center gap-4 rounded-lg border border-border bg-bg-elevated px-4 py-4"
    >
      <Skeleton shape="rect" width={40} height={40} />
      <div className="flex-1 space-y-2">
        <Skeleton width="55%" />
        <Skeleton width="35%" height={12} />
      </div>
      <div className="hidden w-24 space-y-2 sm:block">
        <Skeleton width="100%" height={12} />
      </div>
      <div className="w-28 space-y-2">
        <Skeleton width="80%" height={20} className="ml-auto" />
        <Skeleton width="100%" height={32} shape="rect" />
      </div>
    </div>
  );
}

/** Matches HotelResultCard's box model exactly. */
export function HotelCardSkeleton() {
  return (
    <div
      data-testid="hotel-result-skeleton"
      className="flex flex-col gap-4 overflow-hidden rounded-lg border border-border bg-bg-elevated sm:flex-row"
    >
      <Skeleton shape="rect" className="h-[180px] w-full shrink-0 rounded-none sm:w-[240px]" />
      <div className="flex-1 space-y-3 p-4">
        <Skeleton width="45%" height={20} />
        <Skeleton width="30%" height={12} />
        <Skeleton width="60%" height={12} />
      </div>
      <div className="w-full space-y-2 p-4 sm:w-40">
        <Skeleton width="70%" height={24} className="sm:ml-auto" />
        <Skeleton width="100%" height={36} shape="rect" />
      </div>
    </div>
  );
}
