import { Ban } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBookingDetail, useCancelBooking } from '@/api/hooks/booking';
import { errorMessage } from '@/api/errors';
import { PageContainer } from '@/components/layout/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CopyChip,
  Modal,
  PriceTag,
  Select,
  Skeleton,
} from '@/components/ui';
import { formatDateLong, formatMoney } from '@/lib/format';
import { toast } from '@/store/toasts';

const CANCELLABLE = new Set(['CONFIRMED', 'HELD', 'PENDING_PAYMENT']);

const STATE_INTENT: Record<string, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  CONFIRMED: 'success',
  HELD: 'warning',
  PENDING_PAYMENT: 'warning',
  DRAFT: 'neutral',
  FAILED: 'danger',
  CANCELLED: 'danger',
  EXPIRED: 'neutral',
  REFUNDED: 'info',
};

const REASONS = [
  { value: 'change_of_plans', label: 'My plans changed' },
  { value: 'found_better_price', label: 'I found a better price' },
  { value: 'booked_by_mistake', label: 'I booked this by mistake' },
  { value: 'trip_no_longer_needed', label: 'The trip is no longer happening' },
];

/** `/manage/:pnr` -- booking detail and cancellation (06-USER-FLOWS.md § 4). */
export default function ManageBookingPage() {
  const { pnr = '' } = useParams<{ pnr: string }>();
  const navigate = useNavigate();
  const detail = useBookingDetail(pnr);
  const [confirming, setConfirming] = useState(false);

  if (detail.isPending) {
    return (
      <PageContainer className="space-y-4 py-10">
        <Skeleton width={240} height={28} />
        <Skeleton shape="rect" className="h-64" />
      </PageContainer>
    );
  }

  if (!detail.data) {
    return (
      <PageContainer className="py-10">
        <Alert intent="warning" title="We could not find that booking">
          {errorMessage(detail.error)}
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={() => navigate('/manage')}>
          Try another reference
        </Button>
      </PageContainer>
    );
  }

  const { booking, payment, cancellationPolicy, loyalty } = detail.data;
  const cancellable = CANCELLABLE.has(booking.state);

  return (
    <PageContainer className="py-10">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-display-sm">Your booking</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {booking.pnr ? (
                <CopyChip value={booking.pnr} actionName="Copy PNR" testId="manage-pnr" />
              ) : null}
              <Badge
                intent={STATE_INTENT[booking.state] ?? 'neutral'}
                dot
                data-testid="booking-state"
              >
                {booking.state.replace(/_/g, ' ').toLowerCase()}
              </Badge>
            </div>
          </div>
          <PriceTag cents={booking.totalCents} currency={booking.currency} size="lg" />
        </header>

        {booking.state === 'CANCELLED' ? (
          <Alert intent="info" title="This booking is cancelled">
            {booking.cancellationReason ? `Reason: ${booking.cancellationReason}. ` : ''}
            {cancellationPolicy.refundCents > 0
              ? `A refund of ${formatMoney(cancellationPolicy.refundCents, booking.currency)} is on its way to your card.`
              : 'This fare was non-refundable, so no refund is due.'}
          </Alert>
        ) : null}

        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Itinerary</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="divide-y divide-border">
              {booking.items.map((item) => (
                <li key={item.id} className="flex items-baseline justify-between gap-4 py-2">
                  <span className="text-body-md">{item.description}</span>
                  <span className="tabular text-body-sm text-fg-muted">
                    ×{item.quantity} · {formatMoney(item.totalPriceCents, booking.currency)}
                  </span>
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
            <CardTitle>Payment and policy</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2">
            {payment ? (
              <p className="text-body-sm text-fg-muted">
                {payment.cardBrand} ending {payment.cardLast4} ·{' '}
                {formatMoney(payment.amountCents, payment.currency)} · {payment.state.toLowerCase()}
              </p>
            ) : null}
            <p className="text-body-md">{cancellationPolicy.summary}</p>
            {loyalty ? (
              <p className="text-body-sm text-fg-muted">
                {loyalty.pointsEarned.toLocaleString('en-GB')} points{' '}
                {loyalty.accrued ? 'earned' : 'pending'}
              </p>
            ) : null}
          </CardBody>
        </Card>

        {cancellable ? (
          <div className="flex justify-end">
            <Button
              variant="danger"
              leadingIcon={<Ban className="h-4 w-4" />}
              data-testid="cancel-booking"
              data-dd-action-name="Cancel booking"
              data-refundable={cancellationPolicy.refundable}
              onClick={() => setConfirming(true)}
            >
              Cancel this booking
            </Button>
          </div>
        ) : null}
      </div>

      {confirming ? (
        <CancelModal
          bookingId={booking.id}
          currency={booking.currency}
          refundCents={cancellationPolicy.refundCents}
          penaltyCents={cancellationPolicy.penaltyCents}
          refundable={cancellationPolicy.refundable}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </PageContainer>
  );
}

function CancelModal({
  bookingId,
  currency,
  refundCents,
  penaltyCents,
  refundable,
  onClose,
}: {
  bookingId: string;
  currency: string;
  refundCents: number;
  penaltyCents: number;
  refundable: boolean;
  onClose: () => void;
}) {
  const cancel = useCancelBooking(bookingId);
  const [reason, setReason] = useState(REASONS[0].value);

  const confirm = async () => {
    try {
      const result = await cancel.mutateAsync(reason);
      onClose();
      toast.success(
        'Booking cancelled',
        result.refundCents > 0
          ? `${formatMoney(result.refundCents, currency)} will be refunded to your card.`
          : 'This fare was non-refundable, so no refund is due.',
      );
    } catch (error) {
      toast.danger('We could not cancel that booking', errorMessage(error));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={false}
      title="Cancel this booking?"
      description="This releases your seats immediately and cannot be undone."
      testId="cancel-modal"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep my booking
          </Button>
          <Button
            variant="danger"
            loading={cancel.isPending}
            data-testid="confirm-cancellation"
            data-dd-action-name="Confirm cancellation"
            data-refundable={refundable}
            onClick={confirm}
          >
            Cancel booking
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Alert intent={refundable ? 'info' : 'warning'}>
          {refundable
            ? `You'll be refunded ${formatMoney(refundCents, currency)}${
                penaltyCents > 0
                  ? `, after a ${formatMoney(penaltyCents, currency)} cancellation fee`
                  : ''
              }.`
            : 'This fare is non-refundable. Cancelling will not return any money.'}
        </Alert>

        <Select
          label="Why are you cancelling?"
          options={REASONS}
          value={reason}
          data-testid="cancel-reason"
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Modal>
  );
}
