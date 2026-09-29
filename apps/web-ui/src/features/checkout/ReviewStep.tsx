import type { AncillariesRequest, Booking } from '@voyager/shared-schemas';
import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useBookingDetail, useSaveAncillaries } from '@/api/hooks/booking';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  QuantityStepper,
  Toggle,
} from '@/components/ui';
import { formatMoney, priceBand } from '@/lib/format';
import { toast } from '@/store/toasts';
import { CheckoutShell, CheckoutSkeleton } from './CheckoutShell';
import { readHandoff } from './handoff';
import { SeatPicker } from './SeatPicker';

const BAG_PRICE_CENTS = 3_500;
const INSURANCE_PRICE_CENTS = 1_990;
const BREAKFAST_PRICE_CENTS = 1_500;

const ROOM_UPGRADES = [
  { id: 'higher_floor', label: 'Higher floor, same room type', priceCents: 1_200 },
  { id: 'city_view', label: 'City view', priceCents: 3_400 },
  { id: 'suite', label: 'One-bedroom suite', priceCents: 12_500 },
];

function travellerCount(booking: Booking): number {
  const segment = booking.items.find((item) => item.itemType === 'flight_segment');
  return Math.max(1, segment?.quantity ?? booking.passengers.length ?? 1);
}

export default function ReviewStep() {
  const { bookingId = '' } = useParams<{ bookingId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const detail = useBookingDetail(bookingId);
  const save = useSaveAncillaries(bookingId);
  const handoff = readHandoff(location);

  const [seats, setSeats] = useState<(string | null)[]>([]);
  const [seatPrices, setSeatPrices] = useState<number[]>([]);
  const [bags, setBags] = useState<number[]>([]);
  const [insurance, setInsurance] = useState(false);
  const [breakfast, setBreakfast] = useState(false);
  const [roomUpgrade, setRoomUpgrade] = useState<string | null>(null);
  const [activeTraveller, setActiveTraveller] = useState(0);

  if (detail.isPending) return <CheckoutSkeleton />;
  if (!detail.data) {
    return (
      <Alert intent="danger" title="We could not load your booking" className="m-6">
        Start again from your search results. Nothing has been charged.
      </Alert>
    );
  }

  const { booking } = detail.data;
  const travellers = travellerCount(booking);
  const isFlight = booking.productType === 'flight';

  /** Every selection re-prices server-side (06-USER-FLOWS.md § 2 step 6). */
  const reprice = (overrides: Partial<AncillariesRequest>) => {
    const next: AncillariesRequest = {
      seats: seats.flatMap((seat, index) =>
        seat ? [{ passengerIndex: index, seat, priceCents: seatPrices[index] ?? 0 }] : [],
      ),
      baggage: bags.flatMap((extraBags, index) =>
        extraBags > 0
          ? [{ passengerIndex: index, extraBags, priceCents: extraBags * BAG_PRICE_CENTS }]
          : [],
      ),
      roomUpgrade,
      insurance,
      breakfast,
      ...overrides,
    };
    save.mutate(next, {
      onError: () => toast.danger('We could not update your extras', 'Your price is unchanged.'),
    });
  };

  const onSelectSeat = (seatId: string, priceCents: number) => {
    const nextSeats = [...seats];
    const nextPrices = [...seatPrices];
    nextSeats[activeTraveller] = nextSeats[activeTraveller] === seatId ? null : seatId;
    nextPrices[activeTraveller] = priceCents;
    setSeats(nextSeats);
    setSeatPrices(nextPrices);
    setActiveTraveller((current) => Math.min(travellers - 1, current + 1));
    reprice({
      seats: nextSeats.flatMap((seat, index) =>
        seat ? [{ passengerIndex: index, seat, priceCents: nextPrices[index] ?? 0 }] : [],
      ),
    });
  };

  return (
    <CheckoutShell
      booking={booking}
      step={0}
      pointsPreview={handoff?.pointsPreview ?? detail.data.loyalty?.pointsEarned}
      repricing={save.isPending}
    >
      {handoff?.priceChanged ? (
        <Alert
          intent="warning"
          title="The price changed while you were choosing"
          testId="price-changed"
        >
          This fare is now {formatMoney(booking.totalCents, booking.currency)}
          {handoff.previousTotalCents
            ? `, was ${formatMoney(handoff.previousTotalCents, booking.currency)}`
            : ''}
          . Nothing has been charged yet.
        </Alert>
      ) : null}

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>What you're booking</CardTitle>
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
                  <span className="tabular text-body-md text-fg-muted">
                    ×{item.quantity} · {formatMoney(item.totalPriceCents, booking.currency)}
                  </span>
                </li>
              ))}
          </ul>
          <p className="mt-3 text-body-sm text-fg-muted">
            {detail.data.cancellationPolicy.summary}
          </p>
        </CardBody>
      </Card>

      <Card variant="elevated">
        <CardHeader>
          <CardTitle>Optional extras</CardTitle>
        </CardHeader>
        <CardBody className="space-y-6">
          {isFlight ? (
            <>
              <section>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-heading-sm">Choose your seats</h3>
                  {travellers > 1 ? (
                    <div role="tablist" aria-label="Traveller" className="flex gap-1">
                      {Array.from({ length: travellers }, (_, index) => (
                        <button
                          key={index}
                          role="tab"
                          type="button"
                          aria-selected={activeTraveller === index}
                          onClick={() => setActiveTraveller(index)}
                          className={
                            activeTraveller === index
                              ? 'rounded-md bg-brand-600 px-2.5 py-1 text-body-sm font-medium text-white'
                              : 'rounded-md px-2.5 py-1 text-body-sm text-fg-muted hover:bg-bg-sunken'
                          }
                        >
                          Traveller {index + 1}
                          {seats[index] ? ` · ${seats[index]}` : ''}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <SeatPicker
                  seed={booking.id}
                  currency={booking.currency}
                  selections={seats.length ? seats : Array.from({ length: travellers }, () => null)}
                  activeTraveller={activeTraveller}
                  onSelect={onSelectSeat}
                />
              </section>

              <section>
                <h3 className="text-heading-sm">Extra baggage</h3>
                <p className="mb-2 text-body-sm text-fg-muted">
                  {formatMoney(BAG_PRICE_CENTS, booking.currency)} per bag, up to 23 kg each.
                </p>
                <ul className="space-y-2">
                  {Array.from({ length: travellers }, (_, index) => (
                    <li key={index}>
                      <QuantityStepper
                        label={`Traveller ${index + 1}`}
                        min={0}
                        max={3}
                        value={bags[index] ?? 0}
                        actionName="Add baggage"
                        testId={`baggage-${index}`}
                        className="w-full"
                        onChange={(value) => {
                          const next = [...bags];
                          next[index] = value;
                          setBags(next);
                          reprice({
                            baggage: next.flatMap((extraBags, bagIndex) =>
                              extraBags > 0
                                ? [
                                    {
                                      passengerIndex: bagIndex,
                                      extraBags,
                                      priceCents: extraBags * BAG_PRICE_CENTS,
                                    },
                                  ]
                                : [],
                            ),
                          });
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <>
              <section>
                <h3 className="text-heading-sm">Room upgrades</h3>
                <ul className="mt-2 space-y-2">
                  {ROOM_UPGRADES.map((upgrade) => (
                    <li key={upgrade.id}>
                      <label className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-border p-3 hover:border-brand-500">
                        <span className="flex items-center gap-3">
                          <input
                            type="radio"
                            name="room-upgrade"
                            checked={roomUpgrade === upgrade.id}
                            data-dd-action-name="Upgrade room"
                            data-price-band={priceBand(upgrade.priceCents)}
                            onChange={() => {
                              setRoomUpgrade(upgrade.id);
                              reprice({ roomUpgrade: upgrade.id });
                            }}
                            className="h-4 w-4 text-brand-600"
                          />
                          <span className="text-body-md">{upgrade.label}</span>
                        </span>
                        <span className="tabular text-body-md font-medium">
                          +{formatMoney(upgrade.priceCents, booking.currency)}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {roomUpgrade ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="mt-1"
                    onClick={() => {
                      setRoomUpgrade(null);
                      reprice({ roomUpgrade: null });
                    }}
                  >
                    Remove upgrade
                  </Button>
                ) : null}
              </section>

              {/* 06-USER-FLOWS.md § 7 has no action name for breakfast, so this
                  one is left unnamed rather than inventing a taxonomy entry. */}
              <Toggle
                label="Breakfast for two, every morning"
                description={`${formatMoney(BREAKFAST_PRICE_CENTS, booking.currency)} per day`}
                checked={breakfast}
                testId="ancillary-breakfast"
                onChange={(checked) => {
                  setBreakfast(checked);
                  reprice({ breakfast: checked });
                }}
              />
            </>
          )}

          <Toggle
            label="Travel insurance"
            description={`${formatMoney(INSURANCE_PRICE_CENTS, booking.currency)} — cancellation, delay and medical cover`}
            checked={insurance}
            actionName="Add insurance"
            testId="ancillary-insurance"
            onChange={(checked) => {
              setInsurance(checked);
              reprice({ insurance: checked });
            }}
          />
        </CardBody>
      </Card>

      <div className="flex justify-end">
        <Button
          size="lg"
          loading={save.isPending}
          data-testid="review-continue"
          onClick={() => navigate(`/checkout/${booking.id}/passengers`)}
        >
          Continue to travellers
        </Button>
      </div>
    </CheckoutShell>
  );
}
