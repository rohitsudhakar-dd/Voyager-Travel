import { CalendarX2, Loader2, RefreshCw, SearchX, TimerOff } from 'lucide-react';
import { Alert, Button, EmptyState, HotelCardSkeleton, ResultRowSkeleton } from '@/components/ui';
import { errorMessage, errorRequestId } from '@/api/errors';
import { formatDateWithDay } from '@/lib/format';

/**
 * Every state on this screen is designed, because during a chaos demo the
 * broken states *are* the demo (04-STYLING.md § 4.10).
 */

const SLOW_MS = 3_000;
const VERY_SLOW_MS = 8_000;

export function ResultsSkeletonList({ product }: { product: 'flights' | 'hotels' }) {
  const Row = product === 'flights' ? ResultRowSkeleton : HotelCardSkeleton;
  return (
    <div aria-hidden className="space-y-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Row key={index} />
      ))}
    </div>
  );
}

/** Never a bare spinner: the copy escalates at 3 s and again at 8 s. */
export function SearchProgress({ elapsedMs }: { elapsedMs: number }) {
  const message =
    elapsedMs >= VERY_SLOW_MS
      ? 'Our partners are responding slowly'
      : elapsedMs >= SLOW_MS
        ? 'Still searching…'
        : 'Searching our partners';

  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="search-progress"
      className="inline-flex items-center gap-2 text-body-md text-fg-muted"
    >
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
      {message}
    </p>
  );
}

/** Maps directly onto a partial GDS fan-out in the trace. */
export function PartialResultsBanner({
  responded,
  queried,
}: {
  responded: number;
  queried: number;
}) {
  return (
    <Alert intent="info" testId="partial-results-banner">
      Showing {responded} of {queried} providers — some partners didn&apos;t respond in time.
    </Alert>
  );
}

export function SearchFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const requestId = errorRequestId(error);

  return (
    <div
      role="alert"
      data-testid="search-failed"
      className="flex flex-col items-start gap-3 rounded-lg border border-danger-500/30 bg-danger-50 p-5"
    >
      <h2 className="text-heading-md text-danger-700">
        We couldn&apos;t reach our flight partners
      </h2>
      <p className="text-body-md text-danger-700">{errorMessage(error)}</p>
      <Button
        variant="danger"
        leadingIcon={<RefreshCw className="h-4 w-4" />}
        data-testid="search-retry"
        data-dd-action-name="Retry search"
        onClick={onRetry}
      >
        Try again
      </Button>
      {requestId ? (
        <p className="font-mono text-mono-sm text-danger-700">
          requestId <span data-dd-privacy="allow">{requestId}</span>
        </p>
      ) : null}
    </div>
  );
}

export function NoResults({
  summary,
  alternativeDates,
  onPickDate,
}: {
  summary: string;
  alternativeDates: string[];
  onPickDate: (date: string) => void;
}) {
  return (
    <EmptyState
      icon={<SearchX className="h-5 w-5" />}
      title="No fares matched that search"
      testId="no-results"
      description={
        <>
          <p>{summary}</p>
          {alternativeDates.length > 0 ? (
            <div className="mt-4">
              <p className="mb-2 text-body-sm font-medium text-fg">Try a nearby date</p>
              <div className="flex flex-wrap justify-center gap-2">
                {alternativeDates.map((date) => (
                  <Button
                    key={date}
                    size="sm"
                    variant="secondary"
                    data-testid="alternative-date"
                    onClick={() => onPickDate(date)}
                  >
                    {formatDateWithDay(date)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      }
    />
  );
}

/** A 410 from the cached result set. A full interstitial, not a toast. */
export function ResultsExpired({ onSearchAgain }: { onSearchAgain: () => void }) {
  return (
    <EmptyState
      icon={<TimerOff className="h-5 w-5" />}
      title="These results have expired"
      testId="results-expired"
      description="Fares move quickly. Run the search again to see current prices."
      action={
        <Button
          data-testid="results-expired-retry"
          data-dd-action-name="Retry search"
          onClick={onSearchAgain}
        >
          Search again
        </Button>
      }
    />
  );
}

/**
 * The `frontend_layout_shift` banner. Inserted after first paint with no space
 * reserved, which is the textbook CLS regression.
 */
export function LayoutShiftBanner() {
  return (
    <div
      data-testid="chaos-layout-shift-banner"
      className="flex items-center gap-2 rounded-md border border-accent-300 bg-accent-50 px-4 py-3 text-body-md text-accent-700"
    >
      <CalendarX2 aria-hidden className="h-5 w-5 shrink-0" />
      Prices for these dates change frequently. Book soon to keep this fare.
    </div>
  );
}
