import type { Booking } from '@voyager/shared-schemas';
import { TimerOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageContainer } from '@/components/layout/Page';
import { Button, Card, CardBody, CheckoutStepper, CountdownTimer, Skeleton } from '@/components/ui';
import { useCheckoutStepTiming } from '@/datadog/hooks';
import { useTimeRemaining } from '@/lib/hooks';
import { PriceSummary } from './PriceSummary';

const STEP_PATHS = ['review', 'passengers', 'payment'] as const;

export interface CheckoutShellProps {
  booking: Booking;
  step: number;
  pointsPreview?: number;
  repricing?: boolean;
  children: ReactNode;
}

/**
 * Shared chrome for the three pre-payment steps. The hold deadline is enforced
 * here rather than in each step, so an expired hold cannot be paid for from any
 * of them (06-USER-FLOWS.md § 4).
 */
export function CheckoutShell({
  booking,
  step,
  pointsPreview,
  repricing,
  children,
}: CheckoutShellProps) {
  const navigate = useNavigate();
  const remaining = useTimeRemaining(booking.holdExpiresAt);
  const expired = booking.state === 'EXPIRED' || (remaining !== null && remaining <= 0);

  // The clock lives here, where every step already passes through, so each step
  // only has to say when it was submitted.
  useCheckoutStepTiming(step);

  if (expired) return <HoldExpired booking={booking} />;

  return (
    <PageContainer className="py-6 pb-28 lg:pb-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <CheckoutStepper
          current={step}
          onNavigate={(index) => navigate(`/checkout/${booking.id}/${STEP_PATHS[index]}`)}
        />
        {/* The timer appears from Passengers onward (04-STYLING.md § 4.5). */}
        {booking.holdExpiresAt && step >= 1 ? (
          <CountdownTimer deadline={booking.holdExpiresAt} />
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">{children}</div>
        <PriceSummary booking={booking} pointsPreview={pointsPreview} repricing={repricing} />
      </div>
    </PageContainer>
  );
}

/** Full-page, not a toast: the fare is gone and the only way on is a new search. */
export function HoldExpired({ booking }: { booking: Booking }) {
  const navigate = useNavigate();

  return (
    <PageContainer className="py-16">
      <Card variant="elevated" className="mx-auto max-w-lg text-center" data-testid="hold-expired">
        <CardBody className="space-y-4 py-10">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning-100 text-warning-600">
            <TimerOff aria-hidden className="h-6 w-6" />
          </span>
          <h1 className="text-heading-lg">Your fare hold has expired</h1>
          <p className="text-body-md text-fg-muted">
            We held this price for ten minutes. Prices move, so we need to check it again before you
            pay. Nothing has been charged.
          </p>
          <Button
            size="lg"
            data-testid="hold-expired-search-again"
            onClick={() =>
              navigate(booking.productType === 'flight' ? '/search/flights' : '/search/hotels')
            }
          >
            Search again
          </Button>
        </CardBody>
      </Card>
    </PageContainer>
  );
}

export function CheckoutSkeleton() {
  return (
    <PageContainer className="space-y-6 py-6">
      <Skeleton width={320} height={24} />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Skeleton shape="rect" className="h-80" />
        <Skeleton shape="rect" className="h-64" />
      </div>
    </PageContainer>
  );
}
