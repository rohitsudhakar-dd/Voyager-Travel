import type { FlightSearchRequest, HotelSearchRequest, SortKey } from '@voyager/shared-schemas';
import { HttpResponse, http } from 'msw';
import { detailFor, generateFlights, generateHotels, sortResults } from '../fixtures/generate';
import { PROVIDERS } from '../fixtures/reference';
import { chaosNumber, chaosString, nextId, state } from '../fixtures/state';
import { delay, errorResponse, requestId } from './shared';

const API = '/api/v1';
const PAGE_SIZE = 20;

/** Cached result sets expire, which is what makes the 410 interstitial reachable. */
const RESULT_TTL_MS = 10 * 60_000;

function providerCounts() {
  const down = chaosString('gds_provider_down');
  const responded = down ? PROVIDERS.length - 1 : PROVIDERS.length;
  return { providersQueried: PROVIDERS.length, providersResponded: responded };
}

export const searchHandlers = [
  http.post(`${API}/search/flights`, async ({ request }) => {
    const body = (await request.json()) as FlightSearchRequest;
    await delay(650, 'gds_latency_ms');

    if (Math.random() < chaosNumber('gds_error_rate')) {
      return errorResponse(
        503,
        'GdsUnavailableError',
        'gds_unavailable',
        'We could not reach our flight partners.',
      );
    }

    const searchId = nextId('srch');
    const results = sortResults(generateFlights(body, searchId), body.sort);
    const counts = providerCounts();

    state.searches.set(searchId, {
      id: searchId,
      productType: 'flight',
      results,
      cacheHit: false,
      ...counts,
      createdAt: Date.now(),
    });

    return HttpResponse.json({
      searchId,
      cacheHit: false,
      ...counts,
      resultCount: results.length,
      results: results.slice(0, PAGE_SIZE),
      requestId: requestId(),
    });
  }),

  http.post(`${API}/search/hotels`, async ({ request }) => {
    const body = (await request.json()) as HotelSearchRequest;
    await delay(600, 'gds_latency_ms');

    if (Math.random() < chaosNumber('gds_error_rate')) {
      return errorResponse(
        503,
        'GdsUnavailableError',
        'gds_unavailable',
        'We could not reach our hotel partners.',
      );
    }

    const searchId = nextId('srch');
    const results = sortResults(generateHotels(body, searchId), body.sort);
    const counts = providerCounts();

    state.searches.set(searchId, {
      id: searchId,
      productType: 'hotel',
      results,
      cacheHit: false,
      ...counts,
      createdAt: Date.now(),
    });

    return HttpResponse.json({
      searchId,
      cacheHit: false,
      ...counts,
      resultCount: results.length,
      results: results.slice(0, PAGE_SIZE),
      requestId: requestId(),
    });
  }),

  http.get(`${API}/search/:searchId/results`, async ({ params, request }) => {
    await delay(140);
    const record = state.searches.get(String(params.searchId));

    if (!record || Date.now() - record.createdAt > RESULT_TTL_MS) {
      return errorResponse(
        410,
        'SearchResultExpiredError',
        'search_result_expired',
        'These prices have expired. Please search again.',
      );
    }

    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Number(url.searchParams.get('size') ?? PAGE_SIZE);
    const sort = (url.searchParams.get('sort') ?? 'price_asc') as SortKey;
    const sorted = sortResults(record.results, sort);

    return HttpResponse.json({
      searchId: record.id,
      results: sorted.slice((page - 1) * size, page * size),
      page,
      size,
      total: sorted.length,
      cacheHit: page > 1,
      providersQueried: record.providersQueried,
      providersResponded: record.providersResponded,
      requestId: requestId(),
    });
  }),

  http.get(`${API}/search/:searchId/results/:resultId`, async ({ params }) => {
    await delay(180);
    const record = state.searches.get(String(params.searchId));
    const result = record?.results.find((candidate) => candidate.id === String(params.resultId));

    if (!record || !result) {
      return errorResponse(
        410,
        'SearchResultExpiredError',
        'search_result_expired',
        'That fare has expired. Please search again.',
      );
    }

    return HttpResponse.json(detailFor(record.id, result));
  }),
];
