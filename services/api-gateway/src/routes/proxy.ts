/**
 * The pass-through half of the public API: search, bookings, payments,
 * loyalty, and support (05-FUNCTIONALITY.md §§ 2.3, 2.5, 2.6, 2.7).
 *
 * These forward to one service each. They are not thin for lack of ambition:
 * the aggregation lives in the BFF endpoints, and mixing the two would make
 * every trace ambiguous about which shape it was.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { principalOf, requirePrincipal } from '../auth';
import { ValidationError } from '../errors';
import { callService, type Upstream } from '../http';
import type { Deps } from '../deps';

/** A cold search fans out to four providers on a three-second budget. */
const SEARCH_TIMEOUT_MS = 20_000;
const BOOKING_TIMEOUT_MS = 15_000;
/** Authorization can sit behind payment_latency_ms for several seconds. */
const PAYMENT_TIMEOUT_MS = 25_000;

export function registerProxyRoutes(app: FastifyInstance, _deps: Deps): void {
  // ------------------------------------------------------------- search --

  app.post('/api/v1/search/flights', async (request, reply) =>
    forward(request, reply, 'search', {
      method: 'POST',
      path: '/v1/search/flights',
      body: request.body,
      timeoutMs: SEARCH_TIMEOUT_MS,
    }),
  );

  app.post('/api/v1/search/hotels', async (request, reply) =>
    forward(request, reply, 'search', {
      method: 'POST',
      path: '/v1/search/hotels',
      body: request.body,
      timeoutMs: SEARCH_TIMEOUT_MS,
    }),
  );

  app.get('/api/v1/search/:searchId/results', async (request, reply) => {
    const { searchId } = request.params as { searchId: string };
    return forward(request, reply, 'search', {
      path: `/v1/search/${encodeURIComponent(searchId)}/results`,
      query: request.query as Record<string, string>,
    });
  });

  app.get('/api/v1/search/:searchId/results/:resultId', async (request, reply) => {
    const { searchId, resultId } = request.params as Record<string, string>;
    return forward(request, reply, 'search', {
      path: `/v1/search/${encodeURIComponent(searchId)}/results/${encodeURIComponent(resultId)}`,
    });
  });

  // ------------------------------------------------------------ bookings --

  app.post('/api/v1/bookings', async (request, reply) => {
    const principal = principalOf(request);
    // Guests may book. If someone is signed in the booking is attributed to
    // them from the token, never from the request body -- otherwise anyone
    // could file a booking under someone else's account.
    const body = { ...(request.body as Record<string, unknown>) };
    body.userId = principal?.id ?? null;

    return forward(request, reply, 'booking', {
      method: 'POST',
      path: '/v1/bookings',
      body,
      timeoutMs: BOOKING_TIMEOUT_MS,
    });
  });

  for (const action of ['hold', 'confirm', 'cancel'] as const) {
    app.post(`/api/v1/bookings/:id/${action}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      return forward(request, reply, 'booking', {
        method: 'POST',
        path: `/v1/bookings/${encodeURIComponent(id)}/${action}`,
        body: request.body ?? {},
        timeoutMs: BOOKING_TIMEOUT_MS,
      });
    });
  }

  for (const part of ['passengers', 'ancillaries'] as const) {
    app.put(`/api/v1/bookings/:id/${part}`, async (request, reply) => {
      const { id } = request.params as { id: string };
      return forward(request, reply, 'booking', {
        method: 'PUT',
        path: `/v1/bookings/${encodeURIComponent(id)}/${part}`,
        body: request.body,
        timeoutMs: BOOKING_TIMEOUT_MS,
      });
    });
  }

  // Declared before /bookings/:id so "mine" is not read as a booking id.
  app.get('/api/v1/bookings/mine', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { page = '1', size = '20' } = request.query as Record<string, string>;
    const limit = Math.min(Number(size) || 20, 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    return forward(request, reply, 'booking', {
      path: '/v1/bookings',
      query: { user_id: principal.id, limit, offset },
      timeoutMs: BOOKING_TIMEOUT_MS,
    });
  });

  app.get('/api/v1/bookings', async (request, reply) => {
    const { pnr, lastName } = request.query as Record<string, string>;
    if (!pnr || !lastName) {
      throw new ValidationError(
        'A guest lookup needs both a booking reference and the lead passenger\u2019s surname.',
      );
    }
    return forward(request, reply, 'booking', {
      path: '/v1/bookings',
      query: { pnr, lastName },
    });
  });

  app.get('/api/v1/bookings/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return forward(request, reply, 'booking', {
      path: `/v1/bookings/${encodeURIComponent(id)}`,
    });
  });

  // ------------------------------------------------------------ payments --

  app.post('/api/v1/payments/authorize', async (request, reply) => {
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      throw new ValidationError('An Idempotency-Key header is required.');
    }
    return forward(request, reply, 'payment', {
      method: 'POST',
      path: '/v1/payments/authorize',
      body: request.body,
      headers: { 'idempotency-key': key },
      timeoutMs: PAYMENT_TIMEOUT_MS,
    });
  });

  app.post('/api/v1/payments/:id/3ds/complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    return forward(request, reply, 'payment', {
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(id)}/3ds/complete`,
      body: request.body ?? {},
      timeoutMs: PAYMENT_TIMEOUT_MS,
    });
  });

  app.get('/api/v1/payments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return forward(request, reply, 'payment', {
      path: `/v1/payments/${encodeURIComponent(id)}`,
    });
  });

  // ------------------------------------------------- loyalty and support --

  app.get('/api/v1/loyalty/me', async (request, reply) => {
    const principal = requirePrincipal(request);
    return forward(request, reply, 'loyalty', {
      path: `/v1/loyalty/${principal.id}`,
    });
  });

  app.post('/api/v1/support/conversations', async (request, reply) => {
    const principal = principalOf(request);
    return forward(request, reply, 'aiSupport', {
      method: 'POST',
      path: '/v1/conversations',
      body: { ...(request.body as Record<string, unknown>), userId: principal?.id ?? null },
    });
  });

  app.get('/api/v1/support/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return forward(request, reply, 'aiSupport', {
      path: `/v1/conversations/${encodeURIComponent(id)}`,
    });
  });
}

type ForwardOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

async function forward(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: Upstream,
  options: ForwardOptions,
): Promise<unknown> {
  const result = await callService(upstream, {
    ...options,
    requestId: request.id,
    authorization: request.headers.authorization,
  });
  reply.code(result.status);
  return result.body;
}
