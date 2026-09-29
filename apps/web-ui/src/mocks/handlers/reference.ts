import { HttpResponse, http } from 'msw';
import { AIRLINES, AIRPORTS, CITIES } from '../fixtures/reference';
import { delay } from './shared';

const API = '/api/v1';

export const referenceHandlers = [
  http.get(`${API}/ref/airports`, async ({ request }) => {
    await delay(90);
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Number(url.searchParams.get('limit') ?? 8);

    const airports = AIRPORTS.filter(
      (airport) =>
        airport.iataCode.toLowerCase().startsWith(query) ||
        airport.cityName.toLowerCase().includes(query) ||
        airport.name.toLowerCase().includes(query),
    ).slice(0, limit);

    return HttpResponse.json({ airports });
  }),

  http.get(`${API}/ref/cities`, async ({ request }) => {
    await delay(90);
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const limit = Number(url.searchParams.get('limit') ?? 8);

    const cities = CITIES.filter((city) => city.name.toLowerCase().includes(query)).slice(0, limit);
    return HttpResponse.json({ cities });
  }),

  http.get(`${API}/ref/airlines`, async () => {
    await delay(60);
    return HttpResponse.json({ airlines: AIRLINES });
  }),
];
