import { useQueryClient } from '@tanstack/react-query';
import type {
  FlightFilters,
  FlightResult,
  FlightSearchRequest,
  SortKey,
} from '@voyager/shared-schemas';
import { addDays, format, parseISO } from 'date-fns';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAirlines } from '@/api/hooks/reference';
import { useCheckoutInit } from '@/api/hooks/booking';
import { useFlightSearch, useSearchResultPage } from '@/api/hooks/search';
import { hasErrorType } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import { useBlockingJs, useDelayedBanner, useInjectedJsError } from '@/chaos/ChaosProvider';
import { useResultsTelemetry } from '@/datadog/hooks';
import { PageContainer } from '@/components/layout/Page';
import { Badge, Button, Drawer, Select } from '@/components/ui';
import { useElapsed, useMediaQuery } from '@/lib/hooks';
import { formatCount, formatDateWithDay, pluralise } from '@/lib/format';
import { toast } from '@/store/toasts';
import { FlightFilterPanel } from './FilterPanel';
import { FlightResultRow } from './FlightResultRow';
import {
  LayoutShiftBanner,
  NoResults,
  PartialResultsBanner,
  ResultsExpired,
  ResultsSkeletonList,
  SearchFailed,
  SearchProgress,
} from './ResultsStates';
import { activeFilterCount, flightSearchFromParams, flightSearchToParams } from './searchParams';

const SORT_OPTIONS = [
  { value: 'price_asc', label: 'Cheapest first' },
  { value: 'price_desc', label: 'Most expensive first' },
  { value: 'duration_asc', label: 'Shortest journey' },
  { value: 'depart_asc', label: 'Earliest departure' },
];

const PAGE_SIZE = 20;

export default function FlightResultsPage() {
  const { searchId = '' } = useParams<{ searchId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const criteria = useMemo(() => flightSearchFromParams(searchParams), [searchParams]);
  const sort = criteria.sort ?? 'price_asc';

  const [page, setPage] = useState(1);
  const [accumulated, setAccumulated] = useState<FlightResult[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const search = useFlightSearch();
  const results = useSearchResultPage(searchId, page, sort, true);
  const airlines = useAirlines();
  const checkout = useCheckoutInit();

  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const searching = search.isPending || (results.isFetching && page === 1);
  const elapsed = useElapsed(searching ? Date.now() - 1 : null);

  // Chaos hooks. Each one is inert unless its flag is set.
  useBlockingJs(searchId);
  useInjectedJsError(searchId);
  const showShiftBanner = useDelayedBanner();

  useEffect(() => {
    setPage(1);
    setAccumulated([]);
  }, [searchId, sort]);

  useEffect(() => {
    const incoming = results.data?.results as FlightResult[] | undefined;
    if (!incoming) return;
    setAccumulated((current) => (results.data!.page === 1 ? incoming : [...current, ...incoming]));
  }, [results.data]);

  /** A changed filter is a different normalised search, so it re-POSTs. */
  const applyCriteria = async (next: FlightSearchRequest) => {
    const response = await search.mutateAsync(next);
    queryClient.setQueryData(queryKeys.searchPage(response.searchId, 1, next.sort ?? 'price_asc'), {
      searchId: response.searchId,
      results: response.results,
      page: 1,
      size: response.results.length,
      total: response.resultCount,
      cacheHit: response.cacheHit,
      providersQueried: response.providersQueried,
      providersResponded: response.providersResponded,
      requestId: response.requestId,
    });
    navigate(
      {
        pathname: `/results/flights/${response.searchId}`,
        search: `?${flightSearchToParams(next).toString()}`,
      },
      { replace: true },
    );
  };

  const onFiltersChange = (filters: FlightFilters) => {
    void applyCriteria({ ...criteria, filters });
  };

  const onSortChange = (nextSort: SortKey) => {
    const params = flightSearchToParams({ ...criteria, sort: nextSort });
    setSearchParams(params, { replace: true });
  };

  const onSelect = async (result: FlightResult) => {
    try {
      const response = await checkout.mutateAsync({
        searchId,
        resultId: result.id,
        productType: 'flight',
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
      if (hasErrorType(error, 'InventoryUnavailableError')) {
        toast.warning('That fare just sold out', 'Pick another flight to continue.');
        return;
      }
      toast.danger('We could not start checkout', 'Please try again.');
    }
  };

  const total = results.data?.total ?? accumulated.length;
  const priceBounds = useMemo<[number, number]>(() => {
    if (accumulated.length === 0) return [0, 200_000];
    const prices = accumulated.map((result) => result.fare.totalCents);
    return [
      Math.floor(Math.min(...prices) / 1000) * 1000,
      Math.ceil(Math.max(...prices) / 1000) * 1000,
    ];
  }, [accumulated]);

  const durationBounds = useMemo<[number, number]>(() => {
    if (accumulated.length === 0) return [0, 1_440];
    const durations = accumulated.map((result) => result.durationMinutes);
    return [Math.min(...durations), Math.ceil(Math.max(...durations) / 30) * 30];
  }, [accumulated]);

  const currency = accumulated[0]?.fare.currency ?? 'GBP';
  const filterCount = activeFilterCount(criteria.filters);

  useResultsTelemetry({
    route: `${criteria.origin}-${criteria.destination}`,
    cabin: criteria.cabin,
    resultCount: total,
    cacheHit: results.data?.cacheHit,
    firstResultPainted: accumulated.length > 0,
    // The airline list is what the filter panel's checkboxes are built from, so
    // the filters are not usable until it has arrived, however fast the fares did.
    filtersUsable: accumulated.length > 0 && airlines.data !== undefined,
  });

  const filterPanel = (
    <FlightFilterPanel
      filters={criteria.filters ?? {}}
      onChange={onFiltersChange}
      airlines={airlines.data ?? []}
      priceBounds={priceBounds}
      durationBounds={durationBounds}
      currency={currency}
    />
  );

  if (hasErrorType(results.error, 'SearchResultExpiredError')) {
    return (
      <PageContainer className="py-8">
        <ResultsExpired onSearchAgain={() => void applyCriteria(criteria)} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display-sm">
            {criteria.origin} <span className="text-fg-muted">to</span> {criteria.destination}
          </h1>
          <p className="mt-1 text-body-md text-fg-muted">
            {formatDateWithDay(criteria.departDate)}
            {criteria.returnDate ? ` – ${formatDateWithDay(criteria.returnDate)}` : ''} ·{' '}
            {pluralise(
              criteria.passengers.adults +
                criteria.passengers.children +
                criteria.passengers.infants,
              'traveller',
            )}{' '}
            · {criteria.cabin.replace(/_/g, ' ')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!isDesktop ? (
            <Button
              variant="secondary"
              leadingIcon={<SlidersHorizontal className="h-4 w-4" />}
              data-testid="filters-open"
              onClick={() => setFiltersOpen(true)}
            >
              Filters
              {filterCount > 0 ? (
                <Badge intent="brand" size="sm">
                  {filterCount}
                </Badge>
              ) : null}
            </Button>
          ) : null}

          <Select
            label="Sort by"
            labelHidden
            options={SORT_OPTIONS}
            value={sort}
            data-testid="results-sort"
            data-dd-action-name="Change sort"
            onChange={(event) => onSortChange(event.target.value as SortKey)}
            containerClassName="w-48"
          />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-results">
        {isDesktop ? (
          <aside aria-label="Filters" className="sticky top-20 self-start">
            {filterPanel}
          </aside>
        ) : (
          <Drawer open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters">
            {filterPanel}
          </Drawer>
        )}

        <section aria-label="Flight results" aria-busy={searching}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p role="status" aria-live="polite" className="tabular text-body-md text-fg-muted">
              {searching && accumulated.length === 0
                ? 'Searching…'
                : `${formatCount(total)} ${total === 1 ? 'fare' : 'fares'}`}
            </p>
            {searching ? <SearchProgress elapsedMs={elapsed} /> : null}
          </div>

          <div className="space-y-3">
            {showShiftBanner ? <LayoutShiftBanner /> : null}

            {results.data && results.data.providersResponded < results.data.providersQueried ? (
              <PartialResultsBanner
                responded={results.data.providersResponded}
                queried={results.data.providersQueried}
              />
            ) : null}

            {results.isError && !hasErrorType(results.error, 'SearchResultExpiredError') ? (
              <SearchFailed error={results.error} onRetry={() => void results.refetch()} />
            ) : null}

            {search.isError ? (
              <SearchFailed error={search.error} onRetry={() => void applyCriteria(criteria)} />
            ) : null}

            {searching && accumulated.length === 0 ? (
              <ResultsSkeletonList product="flights" />
            ) : null}

            {!searching && accumulated.length === 0 && !results.isError ? (
              <NoResults
                summary={`No fares from ${criteria.origin} to ${criteria.destination} on ${formatDateWithDay(criteria.departDate)} in ${criteria.cabin.replace(/_/g, ' ')}.`}
                alternativeDates={[1, 2, 3].map((offset) =>
                  format(addDays(parseISO(criteria.departDate), offset), 'yyyy-MM-dd'),
                )}
                onPickDate={(departDate) =>
                  void applyCriteria({ ...criteria, departDate, filters: {} })
                }
              />
            ) : null}

            {accumulated.length > 0 ? (
              <ul className="space-y-3">
                {accumulated.map((result, index) => (
                  <FlightResultRow
                    key={result.id}
                    result={result}
                    position={index}
                    selecting={checkout.isPending}
                    onSelect={onSelect}
                    onViewDetails={(selected) => navigate(`/detail/${searchId}/${selected.id}`)}
                  />
                ))}
              </ul>
            ) : null}

            {accumulated.length > 0 && accumulated.length < total ? (
              <div className="flex justify-center pt-2">
                <Button
                  variant="secondary"
                  loading={results.isFetching}
                  data-testid="results-load-more"
                  data-dd-action-name="Load more results"
                  onClick={() => setPage((current) => current + 1)}
                >
                  Show {Math.min(PAGE_SIZE, total - accumulated.length)} more
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </PageContainer>
  );
}
