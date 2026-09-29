import type { BookingDetailResponse } from '@voyager/shared-schemas';
import { CalendarPlus, CheckCircle2, Mail, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useBookingDetail } from '@/api/hooks/booking';
import { PageContainer } from '@/components/layout/Page';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyChip,
  PriceTag,
  Skeleton,
} from '@/components/ui';
import { formatDateLong, formatMoney, priceBand } from '@/lib/format';
import { useElapsed } from '@/lib/hooks';
import { toast } from '@/store/toasts';

/**
 * `/confirmation/:bookingId` (06-USER-FLOWS.md § 2 step 10). Payment authorises
 * before the booking is confirmed, so this page arrives in PENDING_PAYMENT and
 * polls until the state settles -- the poll interval and 30 s ceiling live in
 * `useBookingDetail`.
 */
export default function ConfirmationPage() {
  const { bookingId = '' } = useParams<{ bookingId: string }>();
  const detail = useBookingDetail(bookingId, { pollForConfirmation: true });

  if (detail.isPending) {
    return (
      <PageContainer className="space-y-4 py-12">
        <Skeleton width={280} height={32} />
        <Skeleton shape="rect" className="h-64" />
      </PageContainer>
    );
  }

  if (!detail.data) {
    return (
      <PageContainer className="py-12">
        <Alert intent="danger" title="We could not load your booking">
          Your payment may still have succeeded. Look it up under Manage booking before trying
          again.
        </Alert>
      </PageContainer>
    );
  }

  const { booking } = detail.data;

  if (booking.state === 'PENDING_PAYMENT' || booking.state === 'HELD') {
    return <ConfirmationPending />;
  }

  if (booking.state === 'FAILED' || booking.state === 'CANCELLED' || booking.state === 'EXPIRED') {
    return (
      <PageContainer className="py-12">
        <Alert intent="danger" title="This booking did not complete">
          {booking.cancellationReason ??
            'Your payment was not taken. Nothing has been charged and the seats have been released.'}
        </Alert>
        <Button className="mt-4" onClick={() => window.location.assign('/')}>
          Start a new search
        </Button>
      </PageContainer>
    );
  }

  return <Confirmed detail={detail.data} />;
}

const STALLED_AFTER_MS = 10_000;

function ConfirmationPending() {
  const [mountedAt] = useState(() => Date.now());
  const stalled = useElapsed(mountedAt) > STALLED_AFTER_MS;

  return (
    <PageContainer className="py-16">
      <Card
        variant="elevated"
        className="mx-auto max-w-lg text-center"
        data-testid="confirmation-pending"
      >
        <CardBody className="space-y-4 py-10">
          <span
            aria-hidden
            className="mx-auto block h-10 w-10 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600"
          />
          <h1 className="text-heading-lg">Confirming your booking</h1>
          <p role="status" aria-live="polite" className="text-body-md text-fg-muted">
            Your payment went through. We're waiting for the airline to issue your ticket — this
            usually takes a few seconds.
          </p>
          {stalled ? (
            <Alert intent="warning">
              This is taking longer than usual. You can safely close this page; we'll email your
              itinerary as soon as it's issued.
            </Alert>
          ) : null}
        </CardBody>
      </Card>
    </PageContainer>
  );
}

function Confirmed({ detail }: { detail: BookingDetailResponse }) {
  const { booking, payment, loyalty, emailSent } = detail;
  const announced = useRef(false);

  useEffect(() => {
    if (announced.current) return;
    announced.current = true;
    toast.success('Booking confirmed', booking.pnr ? `Reference ${booking.pnr}` : undefined);
  }, [booking.pnr]);

  return (
    <PageContainer className="py-10">
      <div
        className="flex flex-col items-center text-center"
        data-testid="confirmation"
        data-dd-action-name="Booking confirmed"
        data-product-type={booking.productType}
        data-price-band={priceBand(booking.totalCents)}
        data-points-earned={loyalty?.pointsEarned ?? 0}
      >
        <CheckCircle2 aria-hidden className="h-14 w-14 text-success-500" />
        <h1 className="mt-3 text-display-sm">You're booked</h1>
        <p className="mt-1 text-body-lg text-fg-muted">
          We've sent the details to {booking.contactEmail ?? 'your email address'}.
        </p>
        {booking.pnr ? (
          <div className="mt-5">
            <p className="text-caption text-fg-muted">Booking reference</p>
            <CopyChip
              value={booking.pnr}
              actionName="Copy PNR"
              testId="confirmation-pnr"
              className="mt-1"
            />
          </div>
        ) : null}
      </div>

      {!emailSent ? (
        <Alert
          intent="warning"
          title="Your confirmation email is on its way"
          testId="email-pending"
          className="mx-auto mt-6 max-w-2xl"
        >
          Your booking is confirmed and your reference above is valid. The itinerary email is still
          queued behind other messages.
        </Alert>
      ) : null}

      <div className="mx-auto mt-8 grid max-w-3xl gap-4">
        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Your itinerary</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="divide-y divide-border">
              {booking.items
                .filter(
                  (item) => item.itemType === 'flight_segment' || item.itemType === 'room_night',
                )
                .map((item) => (
                  <li key={item.id} className="flex items-baseline justify-between gap-4 py-2">
                    <span className="text-body-md">{item.description}</span>
                    <span className="tabular text-body-sm text-fg-muted">×{item.quantity}</span>
                  </li>
                ))}
            </ul>
            {booking.confirmedAt ? (
              <p className="mt-3 text-body-sm text-fg-muted">
                Confirmed {formatDateLong(booking.confirmedAt)}
              </p>
            ) : null}
          </CardBody>
        </Card>

        {booking.passengers.length > 0 ? (
          <Card variant="elevated">
            <CardHeader>
              <CardTitle>Travellers</CardTitle>
            </CardHeader>
            <CardBody>
              <ul className="space-y-1">
                {booking.passengers.map((passenger) => (
                  <li key={passenger.id} className="flex items-baseline justify-between gap-4">
                    <span className="text-body-md">
                      {passenger.title} {passenger.firstName} {passenger.lastName}
                    </span>
                    {passenger.seatAssignment ? (
                      <span className="font-mono text-mono-sm text-fg-muted">
                        Seat {passenger.seatAssignment}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-body-md text-fg-muted">Total paid</span>
              <PriceTag cents={booking.totalCents} currency={booking.currency} size="lg" />
            </div>
            {payment ? (
              <p className="text-body-sm text-fg-muted">
                {payment.cardBrand} ending {payment.cardLast4} ·{' '}
                {formatMoney(payment.amountCents, payment.currency)}
              </p>
            ) : null}
            {loyalty ? (
              <p className="inline-flex items-center gap-1.5 text-body-sm text-accent-700">
                <Sparkles aria-hidden className="h-4 w-4" />
                {loyalty.pointsEarned.toLocaleString('en-GB')} Voyager points
                {loyalty.accrued ? ' added to your account' : ' will appear within 24 hours'}
              </p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <div className="mx-auto mt-6 flex max-w-3xl flex-wrap gap-2">
        <Button
          variant="secondary"
          leadingIcon={<CalendarPlus className="h-4 w-4" />}
          data-testid="add-to-calendar"
          onClick={() => downloadCalendarInvite(detail)}
        >
          Add to calendar
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<Mail className="h-4 w-4" />}
          data-testid="email-itinerary"
          onClick={() =>
            toast.info(
              'Itinerary email queued',
              'It will arrive at ' + (booking.contactEmail ?? 'your email address') + '.',
            )
          }
        >
          Email itinerary
        </Button>
        {booking.pnr ? (
          <Link
            to={`/manage/${booking.pnr}`}
            className="inline-flex h-10 items-center text-body-md font-semibold text-brand-600 hover:underline"
          >
            Manage this booking
          </Link>
        ) : null}
      </div>
    </PageContainer>
  );
}

/**
 * Built in the browser rather than asked of the gateway: there is no documented
 * endpoint for an .ics file, and an invite is derivable from what we already have.
 */
function downloadCalendarInvite({ booking }: BookingDetailResponse) {
  const stamp = (value: string) => value.replace(/[-:]/g, '').replace(/\.\d+Z?$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Voyager//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${booking.id}@voyager`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `SUMMARY:Voyager booking ${booking.pnr ?? ''}`.trim(),
    `DESCRIPTION:${booking.items.map((item) => item.description).join(', ')}`,
    `DTSTART:${stamp(booking.confirmedAt ?? booking.createdAt)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `voyager-${booking.pnr ?? booking.id}.ics`;
  anchor.click();
  URL.revokeObjectURL(url);
}
