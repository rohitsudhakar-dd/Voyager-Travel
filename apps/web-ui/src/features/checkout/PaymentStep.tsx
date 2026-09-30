import { zodResolver } from '@hookform/resolvers/zod';
import type { AuthorizeRequest, DeclineCode } from '@voyager/shared-schemas';
import { passesLuhn } from '@voyager/shared-schemas';
import { Lock } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { useAuthorizePayment, useBookingDetail, useComplete3ds } from '@/api/hooks/booking';
import { errorRequestId, hasErrorType, isApiError } from '@/api/errors';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Modal,
  Select,
} from '@/components/ui';
import { startTiming, stopTiming } from '@/datadog/rum';
import { formatMoney } from '@/lib/format';
import { idempotencyKey } from '@/lib/ids';
import { CheckoutShell, CheckoutSkeleton, HoldExpired } from './CheckoutShell';
import { detectBrand, formatCardNumber } from './cardBrand';

/** The five codes `mock-payments` can produce (05-FUNCTIONALITY.md § 5.2). */
const DECLINE_COPY: Record<DeclineCode, string> = {
  card_declined: 'Your card was declined. Try another card, or ask your bank why.',
  insufficient_funds: "There aren't enough funds on that card for this booking.",
  expired_card: 'That card has expired. Check the expiry date, or use another card.',
  do_not_honor: 'Your bank declined this payment without giving a reason.',
  fraud_suspected: 'Your bank has flagged this payment for review. Try another card.',
};

const COUNTRIES = [
  { value: 'GB', label: 'United Kingdom' },
  { value: 'IE', label: 'Ireland' },
  { value: 'FR', label: 'France' },
  { value: 'DE', label: 'Germany' },
  { value: 'ES', label: 'Spain' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'US', label: 'United States' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'SG', label: 'Singapore' },
];

const formSchema = z.object({
  holderName: z.string().trim().min(2, 'Name as printed on the card').max(60),
  number: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .refine((value) => /^\d{13,19}$/.test(value), 'Enter a 13 to 19 digit card number')
    .refine(passesLuhn, 'Check that number and try again'),
  expiry: z
    .string()
    .regex(/^(0[1-9]|1[0-2])\s*\/\s*\d{2}$/, 'Use MM / YY')
    .refine((value) => {
      const [month, year] = value.split('/').map((part) => Number(part.trim()));
      const end = new Date(2000 + year, month, 1);
      return end > new Date();
    }, 'That date is in the past'),
  cvc: z.string().regex(/^\d{3,4}$/, 'Three or four digits'),
  billingCountry: z.string().length(2),
});

type PaymentForm = z.input<typeof formSchema>;

type Outcome =
  | { kind: 'declined'; declineCode: DeclineCode | null; message: string }
  | { kind: 'error'; message: string; requestId: string | null };

export default function PaymentStep() {
  const { bookingId = '' } = useParams<{ bookingId: string }>();
  const navigate = useNavigate();
  const detail = useBookingDetail(bookingId);
  const authorize = useAuthorizePayment();

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [expired, setExpired] = useState(false);
  const [challenge, setChallenge] = useState<{ paymentId: string; prompt: string } | null>(null);

  /**
   * One key per *attempt*. A network-level retry of the same attempt replays the
   * original charge; pressing "Try another card" mints a new key, because that
   * is genuinely a new charge (05-FUNCTIONALITY.md § 2.6).
   */
  const attemptKey = useRef(idempotencyKey(bookingId));
  const newAttempt = () => {
    attemptKey.current = idempotencyKey(bookingId);
    setOutcome(null);
  };

  const form = useForm<PaymentForm>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      holderName: '',
      number: '',
      expiry: '',
      cvc: '',
      billingCountry: 'GB',
    },
  });

  const rawNumber = form.watch('number');
  const brand = useMemo(() => detectBrand(rawNumber ?? ''), [rawNumber]);

  if (detail.isPending || !detail.data) return <CheckoutSkeleton />;
  const { booking } = detail.data;
  if (expired) return <HoldExpired booking={booking} />;

  const submit = form.handleSubmit(async (values) => {
    const parsed = formSchema.parse(values);
    const [month, year] = parsed.expiry.split('/').map((part) => Number(part.trim()));
    const body: AuthorizeRequest = {
      bookingId: booking.id,
      amount: booking.totalCents,
      currency: booking.currency,
      idempotencyKey: attemptKey.current,
      card: {
        number: parsed.number,
        expiryMonth: month,
        expiryYear: 2000 + year,
        cvc: parsed.cvc,
        holderName: parsed.holderName,
        billingCountry: parsed.billingCountry,
      },
    };

    setOutcome(null);
    stopTiming('checkout_step_duration');
    // Confirmation is asynchronous (§ 3 step 9), so this clock crosses two
    // views and is stopped by the confirmation page.
    startTiming('time_to_confirmation');

    try {
      const result = await authorize.mutateAsync(body);

      if (result.threeDsChallenge) {
        setChallenge({ paymentId: result.payment.id, prompt: result.threeDsChallenge.prompt });
        return;
      }
      if (result.payment.state === 'DECLINED') {
        setOutcome({
          kind: 'declined',
          declineCode: result.payment.declineCode,
          message: result.payment.declineCode
            ? DECLINE_COPY[result.payment.declineCode]
            : 'Your card was declined.',
        });
        return;
      }
      navigate(`/confirmation/${booking.id}`, { replace: true });
    } catch (error) {
      if (hasErrorType(error, 'PaymentDeclinedError')) {
        const declineCode = (isApiError(error) ? error.declineCode : null) as DeclineCode | null;
        setOutcome({
          kind: 'declined',
          declineCode,
          message: declineCode ? DECLINE_COPY[declineCode] : 'Your card was declined.',
        });
        return;
      }
      if (hasErrorType(error, 'HoldExpiredError')) {
        setExpired(true);
        return;
      }
      if (hasErrorType(error, 'PriceChangedError')) {
        await detail.refetch();
        setOutcome({
          kind: 'error',
          message:
            'The price changed before we could take payment. Nothing has been charged — check the new total and try again.',
          requestId: errorRequestId(error) ?? null,
        });
        return;
      }
      // Infrastructure, not a business decision: the same attempt can be
      // retried with the same key, so nothing is charged twice.
      setOutcome({
        kind: 'error',
        message:
          "We couldn't reach our payment provider. Nothing has been charged. Your fare is still held.",
        requestId: errorRequestId(error) ?? null,
      });
    }
  });

  return (
    <CheckoutShell booking={booking} step={2} pointsPreview={detail.data.loyalty?.pointsEarned}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {outcome?.kind === 'declined' ? (
          <Alert intent="danger" title="Your payment was declined" testId="payment-declined">
            <p>{outcome.message}</p>
            {/* Rotates the idempotency key: the declined attempt would
                otherwise replay rather than re-authorise. */}
            <Button
              variant="secondary"
              size="sm"
              className="mt-3"
              data-testid="payment-retry"
              onClick={newAttempt}
            >
              Try another card
            </Button>
          </Alert>
        ) : null}

        {outcome?.kind === 'error' ? (
          <Alert intent="danger" title="We could not take your payment" testId="payment-error">
            <p>{outcome.message}</p>
            {outcome.requestId ? (
              <p className="mt-2 font-mono text-mono-sm text-fg-muted">
                requestId <span data-dd-privacy="allow">{outcome.requestId}</span>
              </p>
            ) : null}
          </Alert>
        ) : null}

        <Card variant="elevated">
          <CardHeader>
            <CardTitle>Pay {formatMoney(booking.totalCents, booking.currency)}</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Name on card"
              autoComplete="cc-name"
              containerClassName="sm:col-span-2"
              data-testid="card-holder"
              error={form.formState.errors.holderName?.message}
              {...form.register('holderName')}
            />

            <Input
              label="Card number"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="0000 0000 0000 0000"
              containerClassName="sm:col-span-2"
              data-testid="card-number"
              data-dd-privacy="mask"
              suffix={
                <span className="text-caption font-medium text-fg-muted" data-testid="card-brand">
                  {brand.name}
                </span>
              }
              error={form.formState.errors.number?.message}
              {...form.register('number', {
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  event.target.value = formatCardNumber(event.target.value);
                },
              })}
            />

            <Input
              label="Expiry"
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="MM / YY"
              maxLength={7}
              data-testid="card-expiry"
              data-dd-privacy="mask"
              error={form.formState.errors.expiry?.message}
              {...form.register('expiry')}
            />

            <Input
              label="Security code"
              inputMode="numeric"
              autoComplete="cc-csc"
              maxLength={brand.cvcLength}
              hint={`${brand.cvcLength} digits on the ${brand.cvcLength === 4 ? 'front' : 'back'}`}
              data-testid="card-cvc"
              data-dd-privacy="mask"
              error={form.formState.errors.cvc?.message}
              {...form.register('cvc')}
            />

            <Select
              label="Billing country"
              options={COUNTRIES}
              containerClassName="sm:col-span-2"
              data-testid="billing-country"
              error={form.formState.errors.billingCountry?.message}
              {...form.register('billingCountry')}
            />
          </CardBody>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="inline-flex items-center gap-1.5 text-body-sm text-fg-muted">
            <Lock aria-hidden className="h-4 w-4" />
            Card details are encrypted in transit and never stored by Voyager.
          </p>
          <Button
            type="submit"
            size="lg"
            loading={authorize.isPending}
            data-testid="payment-submit"
            data-dd-action-name="Submit payment"
            data-card-brand={brand.name}
          >
            Pay {formatMoney(booking.totalCents, booking.currency)}
          </Button>
        </div>
      </form>

      {challenge ? (
        <ThreeDsModal
          paymentId={challenge.paymentId}
          prompt={challenge.prompt}
          onClose={() => setChallenge(null)}
          onAuthorized={() => navigate(`/confirmation/${booking.id}`, { replace: true })}
          onDeclined={(declineCode) => {
            setChallenge(null);
            setOutcome({
              kind: 'declined',
              declineCode,
              message: declineCode ? DECLINE_COPY[declineCode] : 'Your card was declined.',
            });
          }}
        />
      ) : null}
    </CheckoutShell>
  );
}

function ThreeDsModal({
  paymentId,
  prompt,
  onClose,
  onAuthorized,
  onDeclined,
}: {
  paymentId: string;
  prompt: string;
  onClose: () => void;
  onAuthorized: () => void;
  onDeclined: (declineCode: DeclineCode | null) => void;
}) {
  const complete = useComplete3ds(paymentId);
  const [code, setCode] = useState('');
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setFailed(false);
    try {
      const result = await complete.mutateAsync(code);
      if (result.payment.state === 'DECLINED') {
        onDeclined(result.payment.declineCode);
        return;
      }
      onAuthorized();
    } catch (error) {
      if (hasErrorType(error, 'PaymentDeclinedError')) {
        onDeclined((isApiError(error) ? error.declineCode : null) as DeclineCode | null);
        return;
      }
      setFailed(true);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Your bank needs to check it's you"
      testId="three-ds-modal"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={complete.isPending}
            disabled={code.trim().length === 0}
            data-testid="three-ds-submit"
            data-dd-action-name="Complete 3DS challenge"
            onClick={confirm}
          >
            Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-body-md text-fg-muted">{prompt}</p>
        {failed ? (
          <Alert intent="danger">
            That check didn't complete. Try again, or cancel and use another card.
          </Alert>
        ) : null}
        <Input
          label="Confirmation code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          data-testid="three-ds-code"
          data-dd-privacy="mask"
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
    </Modal>
  );
}
