import { ArmchairIcon, ChevronLeft, Luggage } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCheckoutInit } from '@/api/hooks/booking';
import { useResultDetail } from '@/api/hooks/search';
import { hasErrorType } from '@/api/errors';
import { PageContainer } from '@/components/layout/Page';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  PriceTag,
  Skeleton,
} from '@/components/ui';
import { formatDuration, formatTime, pluralise, stopsLabel } from '@/lib/format';
import { toast } from '@/store/toasts';
import { AirlineLogo } from './AirlineLogo';
import { ResultsExpired } from './ResultsStates';

/** `/detail/:searchId/:resultId` -- fare rules, baggage, seat availability. */
export default function DetailPage() {
  const { searchId = '', resultId = '' } = useParams<{ searchId: string; resultId: string }>();
  const navigate = useNavigate();
  const detail = useResultDetail(searchId, resultId);
  const checkout = useCheckoutInit();

  const select = async () => {
    if (!detail.data) return;
    try {
      const response = await checkout.mutateAsync({
        searchId,
        resultId,
        productType: detail.data.result.productType,
      });
      navigate(`/checkout/${response.booking.id}/review`, {
        state: {
          checkout: {
            priceChanged: response.priceChanged,
            previousTotalCents: response.previousTotalCents,
            pointsPreview: response.pointsPreview,
          },
        },
      });
    } catch (error) {
      if (hasErrorType(error, 'SearchResultExpiredError')) {
        toast.warning('That fare has expired', 'Run the search again for current prices.');
        return;
      }
      toast.danger('We could not start checkout', 'Please try again.');
    }
  };

  if (hasErrorType(detail.error, 'SearchResultExpiredError')) {
    return (
      <PageContainer className="py-8">
        <ResultsExpired onSearchAgain={() => navigate('/search/flights')} />
      </PageContainer>
    );
  }

  if (detail.isPending) {
    return (
      <PageContainer className="space-y-4 py-8">
        <Skeleton width={180} height={20} />
        <Skeleton shape="rect" className="h-56" />
        <Skeleton shape="rect" className="h-40" />
      </PageContainer>
    );
  }

  if (!detail.data) {
    return (
      <PageContainer className="py-8">
        <Alert intent="danger" title="We could not load that fare">
          Go back to your results and pick another option.
        </Alert>
      </PageContainer>
    );
  }

  const { result, fareRules, baggageAllowance, cancellationPolicy, seatMapAvailable } = detail.data;
  const isFlight = result.productType === 'flight';
  const totalCents = isFlight ? result.fare.totalCents : result.totalCents;
  const currency = isFlight ? result.fare.currency : result.currency;

  return (
    <PageContainer className="py-6">
      <Button
        variant="link"
        leadingIcon={<ChevronLeft className="h-4 w-4" />}
        data-testid="detail-back"
        onClick={() => navigate(-1)}
      >
        Back to results
      </Button>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card variant="elevated">
            <CardHeader>
              <CardTitle>{isFlight ? 'Your itinerary' : result.name}</CardTitle>
            </CardHeader>
            <CardBody className="space-y-4">
              {isFlight ? (
                <>
                  <div className="flex items-center gap-3">
                    <AirlineLogo code={result.airline.iataCode} name={result.airline.name} />
                    <div>
                      <p className="text-heading-sm">{result.airline.name}</p>
                      <p className="tabular text-body-sm text-fg-muted">
                        {formatDuration(result.durationMinutes)} · {stopsLabel(result.stops)}
                      </p>
                    </div>
                  </div>

                  <ol className="space-y-3">
                    {result.segments.map((segment) => (
                      <li
                        key={`${segment.flightNumber}-${segment.departAt}`}
                        className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md bg-bg-sunken p-3"
                      >
                        <span className="font-mono text-mono-sm">
                          {segment.airlineCode}
                          {segment.flightNumber}
                        </span>
                        <span className="tabular text-body-md">
                          {formatTime(segment.departAt)} {segment.origin} →{' '}
                          {formatTime(segment.arriveAt)} {segment.destination}
                        </span>
                        <span className="text-body-sm text-fg-muted">
                          {segment.aircraftType ?? 'Aircraft TBC'}
                        </span>
                        <span className="tabular ml-auto text-body-sm text-fg-muted">
                          {formatDuration(segment.durationMinutes)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-body-md text-fg-muted">
                    {result.neighborhood ? `${result.neighborhood}, ` : ''}
                    {result.cityName}
                  </p>
                  <p className="text-body-md">
                    {result.roomName} · {result.ratePlanName}
                  </p>
                  <p className="tabular text-body-sm text-fg-muted">
                    {pluralise(result.nights, 'night')} · {result.roomsAvailable} rooms left
                  </p>
                  <ul className="flex flex-wrap gap-2 pt-2">
                    {result.amenities.map((amenity) => (
                      <li key={amenity}>
                        <Badge intent="neutral" size="sm" className="capitalize">
                          {amenity.replace(/_/g, ' ')}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>

          <Card variant="elevated">
            <CardHeader>
              <CardTitle>Fare conditions</CardTitle>
            </CardHeader>
            <CardBody>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {fareRules.map((rule) => (
                  <div
                    key={rule.label}
                    className="flex justify-between gap-4 border-b border-border py-2"
                  >
                    <dt className="text-body-sm text-fg-muted">{rule.label}</dt>
                    <dd className="text-body-sm font-medium text-fg">{rule.value}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>

          <Card variant="elevated">
            <CardHeader>
              <CardTitle>Baggage and seats</CardTitle>
            </CardHeader>
            <CardBody className="space-y-2">
              <p className="inline-flex items-center gap-2 text-body-md">
                <Luggage aria-hidden className="h-4 w-4 text-fg-muted" />
                {baggageAllowance.cabinBags} cabin ·{' '}
                {baggageAllowance.checkedBags > 0
                  ? `${baggageAllowance.checkedBags} checked up to ${baggageAllowance.checkedWeightKg} kg`
                  : 'no checked bag included'}
              </p>
              <p className="inline-flex items-center gap-2 text-body-md">
                <ArmchairIcon aria-hidden className="h-4 w-4 text-fg-muted" />
                {seatMapAvailable
                  ? 'Seat selection available at checkout'
                  : 'Seats assigned at check-in'}
              </p>
            </CardBody>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card variant="elevated">
            <CardBody className="space-y-4">
              <PriceTag cents={totalCents} currency={currency} size="lg" />
              <p className="text-body-sm text-fg-muted">
                {isFlight
                  ? 'Includes taxes, fees and carrier charges.'
                  : `Total for ${pluralise(result.nights, 'night')}, taxes included.`}
              </p>

              <Alert intent={cancellationPolicy.refundable ? 'success' : 'warning'}>
                {cancellationPolicy.summary}
              </Alert>

              <Button
                fullWidth
                size="lg"
                loading={checkout.isPending}
                data-testid="detail-select"
                data-dd-action-name={isFlight ? 'Select flight result' : 'Select hotel result'}
                onClick={select}
              >
                Continue
              </Button>
            </CardBody>
          </Card>
        </aside>
      </div>
    </PageContainer>
  );
}
