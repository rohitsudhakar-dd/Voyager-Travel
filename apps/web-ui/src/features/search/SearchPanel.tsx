import type {
  Airport,
  City,
  FlightSearchRequest,
  HotelSearchRequest,
} from '@voyager/shared-schemas';
import { flightSearchRequestSchema, hotelSearchRequestSchema } from '@voyager/shared-schemas';
import { ArrowLeftRight, Building2, MapPin, Plane, Search } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useAirportSearch, useCitySearch } from '@/api/hooks/reference';
import { useFlightSearch, useHotelSearch } from '@/api/hooks/search';
import { queryKeys } from '@/api/queryClient';
import {
  Alert,
  Button,
  Combobox,
  DateRangePicker,
  IconButton,
  QuantityStepper,
  Select,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage, errorRequestId } from '@/api/errors';
import { useQueryClient } from '@tanstack/react-query';
import { PassengerSelect } from './PassengerSelect';
import {
  defaultFlightSearch,
  defaultHotelSearch,
  flightSearchToParams,
  hotelSearchToParams,
  maxDateIso,
  nightsBetween,
  todayIso,
} from './searchParams';

const CABINS = [
  { value: 'economy', label: 'Economy' },
  { value: 'economy_plus', label: 'Premium economy' },
  { value: 'business', label: 'Business' },
  { value: 'first', label: 'First' },
];

export type SearchProduct = 'flights' | 'hotels';

export interface SearchPanelProps {
  product: SearchProduct;
  onProductChange: (product: SearchProduct) => void;
  initialFlight?: FlightSearchRequest;
  initialHotel?: HotelSearchRequest;
  /** Overlaps the hero by 40 px on the home page. */
  overlap?: boolean;
  className?: string;
}

/**
 * The search panel from 04-STYLING.md § 4.1. Submitting runs the search here
 * rather than on the results route, so the results screen can be entered with
 * data already in the query cache and paint its first row immediately.
 */
export function SearchPanel({
  product,
  onProductChange,
  initialFlight,
  initialHotel,
  overlap,
  className,
}: SearchPanelProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-bg-elevated p-4 shadow-lg sm:p-5',
        overlap && '-mt-10',
        className,
      )}
    >
      <Tabs
        ariaLabel="What are you booking"
        value={product}
        onChange={(id) => onProductChange(id as SearchProduct)}
        variant="pill"
        className="mb-4 w-fit"
        items={[
          {
            id: 'flights',
            label: 'Flights',
            testId: 'search-tab-flights',
            icon: <Plane className="h-4 w-4" />,
          },
          {
            id: 'hotels',
            label: 'Hotels',
            testId: 'search-tab-hotels',
            icon: <Building2 className="h-4 w-4" />,
          },
        ]}
      />

      {product === 'flights' ? (
        <FlightSearchForm initial={initialFlight} />
      ) : (
        <HotelSearchForm initial={initialHotel} />
      )}
    </div>
  );
}

// The schemas are shared with the gateway, so their messages are contract
// language, not copy. Field errors are translated here instead.
const FIELD_COPY: Record<string, string> = {
  origin: 'Pick a departure airport from the list',
  destination: 'Pick an arrival airport from the list',
  departDate: 'Choose a departure date',
  returnDate: 'Choose a return date, or switch to one way',
  city: 'Pick a city from the list',
  checkIn: 'Choose a check-in date',
  checkOut: 'Check-out must be after check-in',
};

function fieldMessages(issues: z.ZodIssue[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.join('.') || 'form';
    errors[key] ??= FIELD_COPY[key] ?? issue.message;
  }
  return errors;
}

function SearchError({ error }: { error: unknown }) {
  const requestId = errorRequestId(error);
  return (
    <Alert intent="danger" title="We could not run that search" testId="search-error">
      {errorMessage(error)}
      {requestId ? (
        <span className="mt-1 block font-mono text-mono-sm">requestId {requestId}</span>
      ) : null}
    </Alert>
  );
}

function FlightSearchForm({ initial }: { initial?: FlightSearchRequest }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useFlightSearch();

  const [request, setRequest] = useState<FlightSearchRequest>(initial ?? defaultFlightSearch());
  const [originLabel, setOriginLabel] = useState(initial?.origin ?? '');
  const [destinationLabel, setDestinationLabel] = useState(initial?.destination ?? '');
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [roundTrip, setRoundTrip] = useState(Boolean(initial?.returnDate));

  const origins = useAirportSearch(originQuery);
  const destinations = useAirportSearch(destinationQuery);

  const swap = () => {
    setRequest((current) => ({
      ...current,
      origin: current.destination,
      destination: current.origin,
    }));
    setOriginLabel(destinationLabel);
    setDestinationLabel(originLabel);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const candidate: FlightSearchRequest = {
      ...request,
      returnDate: roundTrip ? request.returnDate : undefined,
    };

    const parsed = flightSearchRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      setFieldErrors(fieldMessages(parsed.error.issues));
      return;
    }

    setFieldErrors({});
    const response = await search.mutateAsync(parsed.data);

    // Seed page 1 so the results screen renders without a second round trip.
    queryClient.setQueryData(
      queryKeys.searchPage(response.searchId, 1, parsed.data.sort ?? 'price_asc'),
      {
        searchId: response.searchId,
        results: response.results,
        page: 1,
        size: response.results.length,
        total: response.resultCount,
        cacheHit: response.cacheHit,
        providersQueried: response.providersQueried,
        providersResponded: response.providersResponded,
        requestId: response.requestId,
      },
    );

    navigate({
      pathname: `/results/flights/${response.searchId}`,
      search: `?${flightSearchToParams(parsed.data).toString()}`,
    });
  };

  return (
    <form onSubmit={submit} noValidate data-testid="flight-search-form" className="space-y-4">
      <fieldset className="flex gap-4" aria-label="Trip type">
        {[
          { value: false, label: 'One way' },
          { value: true, label: 'Return' },
        ].map((option) => (
          <label key={option.label} className="inline-flex items-center gap-2 text-body-md">
            <input
              type="radio"
              name="tripType"
              checked={roundTrip === option.value}
              onChange={() => setRoundTrip(option.value)}
              data-testid={`search-trip-${option.value ? 'return' : 'one-way'}`}
              className="text-brand-600 focus:ring-brand-500"
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr_1.4fr]">
        <Combobox<Airport>
          label="From"
          placeholder="City or airport"
          leadingIcon={<Plane className="h-4 w-4" />}
          displayValue={originLabel}
          items={origins.data ?? []}
          loading={origins.isFetching}
          error={fieldErrors.origin}
          getKey={(airport) => airport.iataCode}
          renderItem={(airport) => <AirportOption airport={airport} />}
          onQueryChange={setOriginQuery}
          onSelect={(airport) => {
            setRequest((current) => ({ ...current, origin: airport.iataCode }));
            setOriginLabel(`${airport.cityName} (${airport.iataCode})`);
          }}
          inputProps={{ 'data-testid': 'search-origin' }}
        />

        <div className="flex items-end justify-center pb-1 lg:pb-0">
          <IconButton
            aria-label="Swap origin and destination"
            variant="secondary"
            data-testid="search-swap-airports"
            data-dd-action-name="Swap airports"
            onClick={swap}
            className="lg:mb-0"
          >
            <ArrowLeftRight aria-hidden className="h-4 w-4" />
          </IconButton>
        </div>

        <Combobox<Airport>
          label="To"
          placeholder="City or airport"
          leadingIcon={<MapPin className="h-4 w-4" />}
          displayValue={destinationLabel}
          items={destinations.data ?? []}
          loading={destinations.isFetching}
          error={fieldErrors.destination}
          getKey={(airport) => airport.iataCode}
          renderItem={(airport) => <AirportOption airport={airport} />}
          onQueryChange={setDestinationQuery}
          onSelect={(airport) => {
            setRequest((current) => ({ ...current, destination: airport.iataCode }));
            setDestinationLabel(`${airport.cityName} (${airport.iataCode})`);
          }}
          inputProps={{ 'data-testid': 'search-destination' }}
        />

        <DateRangePicker
          mode={roundTrip ? 'range' : 'single'}
          startLabel="Depart"
          endLabel="Return"
          start={request.departDate}
          end={request.returnDate}
          minDate={todayIso()}
          maxDate={maxDateIso()}
          error={fieldErrors.departDate ?? fieldErrors.returnDate}
          onChange={({ start, end }) =>
            setRequest((current) => ({ ...current, departDate: start, returnDate: end }))
          }
          testId="search-dates"
        />
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <PassengerSelect
          value={request.passengers}
          error={fieldErrors['passengers.adults'] ?? fieldErrors['passengers.infants']}
          onChange={(passengers) => setRequest((current) => ({ ...current, passengers }))}
        />

        <Select
          label="Cabin"
          options={CABINS}
          value={request.cabin}
          data-testid="search-cabin"
          onChange={(event) =>
            setRequest((current) => ({
              ...current,
              cabin: event.target.value as FlightSearchRequest['cabin'],
            }))
          }
        />

        <Button
          type="submit"
          size="lg"
          loading={search.isPending}
          leadingIcon={<Search className="h-4 w-4" />}
          data-testid="search-submit"
          data-dd-action-name="Submit flight search"
          className="w-full sm:w-auto"
        >
          Search flights
        </Button>
      </div>

      {search.isError ? <SearchError error={search.error} /> : null}
    </form>
  );
}

function HotelSearchForm({ initial }: { initial?: HotelSearchRequest }) {
  const navigate = useNavigate();
  const search = useHotelSearch();

  const [request, setRequest] = useState<HotelSearchRequest>(initial ?? defaultHotelSearch());
  const [cityLabel, setCityLabel] = useState(initial?.city ?? '');
  const [cityQuery, setCityQuery] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const cities = useCitySearch(cityQuery);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = hotelSearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFieldErrors(fieldMessages(parsed.error.issues));
      return;
    }

    setFieldErrors({});
    const response = await search.mutateAsync(parsed.data);
    navigate({
      pathname: `/results/hotels/${response.searchId}`,
      search: `?${hotelSearchToParams(parsed.data).toString()}`,
    });
  };

  const nights = nightsBetween(request.checkIn, request.checkOut);

  return (
    <form onSubmit={submit} noValidate data-testid="hotel-search-form" className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1.4fr]">
        <Combobox<City>
          label="Where to"
          placeholder="City or region"
          leadingIcon={<MapPin className="h-4 w-4" />}
          displayValue={cityLabel}
          items={cities.data ?? []}
          loading={cities.isFetching}
          error={fieldErrors.city}
          getKey={(city) => String(city.id)}
          renderItem={(city) => (
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate font-medium">{city.name}</span>
              <span className="shrink-0 text-body-sm text-fg-muted">{city.countryCode}</span>
            </span>
          )}
          onQueryChange={setCityQuery}
          onSelect={(city) => {
            setRequest((current) => ({ ...current, city: city.name }));
            setCityLabel(city.name);
          }}
          inputProps={{ 'data-testid': 'search-city' }}
        />

        <DateRangePicker
          mode="range"
          startLabel="Check in"
          endLabel="Check out"
          start={request.checkIn}
          end={request.checkOut}
          minDate={todayIso()}
          maxDate={maxDateIso()}
          error={fieldErrors.checkIn ?? fieldErrors.checkOut}
          onChange={({ start, end }) =>
            setRequest((current) => ({
              ...current,
              checkIn: start,
              checkOut: end ?? current.checkOut,
            }))
          }
          testId="search-stay"
        />
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <div className="rounded-md border border-border-strong bg-bg-elevated px-3 py-2">
          <QuantityStepper
            label="Guests"
            value={request.guests}
            min={1}
            max={9}
            testId="search-guests"
            onChange={(guests) => setRequest((current) => ({ ...current, guests }))}
          />
        </div>

        <div className="rounded-md border border-border-strong bg-bg-elevated px-3 py-2">
          <QuantityStepper
            label="Rooms"
            value={request.rooms}
            min={1}
            max={5}
            testId="search-rooms"
            onChange={(rooms) => setRequest((current) => ({ ...current, rooms }))}
          />
        </div>

        <Button
          type="submit"
          size="lg"
          loading={search.isPending}
          leadingIcon={<Search className="h-4 w-4" />}
          data-testid="search-submit"
          data-dd-action-name="Submit hotel search"
          className="w-full sm:w-auto"
        >
          Search hotels
        </Button>
      </div>

      <p className="tabular text-body-sm text-fg-muted">
        {nights} {nights === 1 ? 'night' : 'nights'}
      </p>

      {search.isError ? <SearchError error={search.error} /> : null}
    </form>
  );
}

function AirportOption({ airport }: { airport: Airport }) {
  return (
    <span className="flex items-baseline justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {airport.cityName} ({airport.iataCode})
        </span>
        <span className="block truncate text-body-sm text-fg-muted">{airport.name}</span>
      </span>
      <span className="shrink-0 text-body-sm text-fg-muted">{airport.countryCode}</span>
    </span>
  );
}
