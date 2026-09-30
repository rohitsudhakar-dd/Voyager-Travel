import { useQueryClient } from '@tanstack/react-query';
import type {
  HotelFilters,
  HotelResult,
  HotelSearchRequest,
  SortKey,
} from '@voyager/shared-schemas';
import { addDays, format, parseISO } from 'date-fns';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useCheckoutInit } from '@/api/hooks/booking';
import { useHotelSearch, useSearchResultPage } from '@/api/hooks/search';
import { hasErrorType } from '@/api/errors';
import { queryKeys } from '@/api/queryClient';
import { useBlockingJs, useDelayedBanner, useInjectedJsError } from '@/chaos/ChaosProvider';
import { useResultsTelemetry } from '@/datadog/hooks';
import { PageContainer } from '@/components/layout/Page';
import { Badge, Button, Drawer, Select } from '@/components/ui';
import { formatCount, formatDateWithDay, pluralise } from '@/lib/format';
import { useElapsed, useMediaQuery } from '@/lib/hooks';
import { toast } from '@/store/toasts';
import { HotelFilterPanel } from './FilterPanel';
import { HotelResultCard } from './HotelResultCard';
import {
  LayoutShiftBanner,
  NoResults,
  PartialResultsBanner,
  ResultsExpired,
  ResultsSkeletonList,
  SearchFailed,
  SearchProgress,
} from './ResultsStates';
import {
  activeFilterCount,
  hotelSearchFromParams,
  hotelSearchToParams,
  nightsBetween,
} from './searchParams';

const SORT_OPTIONS = [
  { value: 'price_asc', label: 'Cheapest first' },
  { value: 'price_desc', label: 'Most expensive first' },
  { value: 'rating_desc', label: 'Best reviewed' },
];

const PAGE_SIZE = 20;

/** The Core Web Vitals screen: image-forward, and therefore LCP-sensitive. */
export default function HotelResultsPage() {
  const { searchId = '' } = useParams<{ searchId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const criteria = useMemo(() => hotelSearchFromParams(searchParams), [searchParams]);
  const sort = criteria.sort ?? 'price_asc';
  const nights = nightsBetween(criteria.checkIn, criteria.checkOut);

  const [page, setPage] = useState(1);
  const [accumulated, setAccumulated] = useState<HotelResult[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const search = useHotelSearch();
  const results = useSearchResultPage(searchId, page, sort, true);
  const checkout = useCheckoutInit();

  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const searching = search.isPending || (results.isFetching && page === 1);
  const elapsed = useElapsed(searching ? Date.now() - 1 : null);

  useBlockingJs(searchId);
  useInjectedJsError(searchId);
  const showShiftBanner = useDelayedBanner();

  useEffect(() => {
    setPage(1);
    setAccumulated([]);
  }, [searchId, sort]);

  useEffect(() => {
    const incoming = results.data?.results as HotelResult[] | undefined;
    if (!incoming) return;
    setAccumulated((current) => (results.data!.page === 1 ? incoming : [...current, ...incoming]));
  }, [results.data]);

  const applyCriteria = async (next: HotelSearchRequest) => {
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
        pathname: `/results/hotels/${response.searchId}`,
        search: `?${hotelSearchToParams(next).toString()}`,
      },
      { replace: true },
    );
  };

  const onSelect = async (result: HotelResult) => {
    try {
      const response = await checkout.mutateAsync({
        searchId,
        resultId: result.id,
        productType: 'hotel',
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
        toast.warning('That rate has expired', 'Run the search again for current prices.');
        return;
      }
      if (hasErrorType(error, 'InventoryUnavailableError')) {
        toast.warning('That room just sold out', 'Pick another property to continue.');
        return;
      }
      toast.danger('We could not start checkout', 'Please try again.');
    }
  };

  const total = results.data?.total ?? accumulated.length;
  const priceBounds = useMemo<[number, number]>(() => {
    if (accumulated.length === 0) return [0, 100_000];
    const prices = accumulated.map((result) => result.nightlyPriceCents);
    return [
      Math.floor(Math.min(...prices) / 500) * 500,
      Math.ceil(Math.max(...prices) / 500) * 500,
    ];
  }, [accumulated]);

  const neighborhoods = useMemo(
    () =>
      Array.from(
        new Set(
          accumulated
            .map((result) => result.neighborhood)
            .filter((value): value is string => Boolean(value)),
        ),
      ).sort(),
    [accumulated],
  );

  const currency = accumulated[0]?.currency ?? 'GBP';
  const filterCount = activeFilterCount(criteria.filters);

  useResultsTelemetry({
    route: criteria.city,
    // Hotels have no cabin, and dropping the attribute would make the two
    // results views un-comparable on the one dashboard that shows both.
    cabin: 'n/a',
    resultCount: total,
    cacheHit: results.data?.cacheHit,
    firstResultPainted: accumulated.length > 0,
    // The star-rating and amenity facets are derived from the loaded page, so
    // they are only complete once the first page has finished arriving.
    filtersUsable: accumulated.length > 0 && !searching,
  });

  const filterPanel = (
    <HotelFilterPanel
      filters={criteria.filters ?? {}}
      onChange={(filters: HotelFilters) => void applyCriteria({ ...criteria, filters })}
      priceBounds={priceBounds}
      neighborhoods={neighborhoods}
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
          <h1 className="text-display-sm">{criteria.city}</h1>
          <p className="mt-1 text-body-md text-fg-muted">
            {formatDateWithDay(criteria.checkIn)} – {formatDateWithDay(criteria.checkOut)} ·{' '}
            {pluralise(nights, 'night')} · {pluralise(criteria.guests, 'guest')} ·{' '}
            {pluralise(criteria.rooms, 'room')}
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
            onChange={(event) =>
              setSearchParams(
                hotelSearchToParams({ ...criteria, sort: event.target.value as SortKey }),
                {
                  replace: true,
                },
              )
            }
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

        <section aria-label="Hotel results" aria-busy={searching}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p role="status" aria-live="polite" className="tabular text-body-md text-fg-muted">
              {searching && accumulated.length === 0
                ? 'Searching…'
                : `${formatCount(total)} ${total === 1 ? 'property' : 'properties'}`}
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

            {searching && accumulated.length === 0 ? (
              <ResultsSkeletonList product="hotels" />
            ) : null}

            {!searching && accumulated.length === 0 && !results.isError ? (
              <NoResults
                summary={`No rooms in ${criteria.city} for ${pluralise(nights, 'night')} from ${formatDateWithDay(criteria.checkIn)}.`}
                alternativeDates={[1, 2, 3].map((offset) =>
                  format(addDays(parseISO(criteria.checkIn), offset), 'yyyy-MM-dd'),
                )}
                onPickDate={(checkIn) =>
                  void applyCriteria({
                    ...criteria,
                    checkIn,
                    checkOut: format(addDays(parseISO(checkIn), nights), 'yyyy-MM-dd'),
                    filters: {},
                  })
                }
              />
            ) : null}

            {accumulated.length > 0 ? (
              <ul className="space-y-3">
                {accumulated.map((result, index) => (
                  <HotelResultCard
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
