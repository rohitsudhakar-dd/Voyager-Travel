/**
 * Every path the browser calls, in one file.
 *
 * Paths are relative to VITE_API_BASE_URL, which already carries the `/api`
 * prefix, so these all start at `/v1`. Names come from
 * 05-FUNCTIONALITY.md § 2 -- nothing here is invented.
 */

export const endpoints = {
  auth: {
    signup: '/v1/auth/signup',
    login: '/v1/auth/login',
    refresh: '/v1/auth/refresh',
    logout: '/v1/auth/logout',
    me: '/v1/auth/me',
  },

  ref: {
    airports: '/v1/ref/airports',
    cities: '/v1/ref/cities',
    airlines: '/v1/ref/airlines',
  },

  search: {
    flights: '/v1/search/flights',
    hotels: '/v1/search/hotels',
    results: (searchId: string) => `/v1/search/${searchId}/results`,
    result: (searchId: string, resultId: string) => `/v1/search/${searchId}/results/${resultId}`,
  },

  bff: {
    home: '/v1/bff/home',
    checkoutInit: '/v1/bff/checkout/init',
    booking: (idOrPnr: string) => `/v1/bff/booking/${idOrPnr}`,
    account: '/v1/bff/account',
  },

  bookings: {
    lookup: '/v1/bookings',
    mine: '/v1/bookings/mine',
    passengers: (id: string) => `/v1/bookings/${id}/passengers`,
    ancillaries: (id: string) => `/v1/bookings/${id}/ancillaries`,
    cancel: (id: string) => `/v1/bookings/${id}/cancel`,
  },

  payments: {
    authorize: '/v1/payments/authorize',
    threeDsComplete: (id: string) => `/v1/payments/${id}/3ds/complete`,
    get: (id: string) => `/v1/payments/${id}`,
  },

  loyalty: {
    me: '/v1/loyalty/me',
  },

  support: {
    conversations: '/v1/support/conversations',
    messages: (id: string) => `/v1/support/conversations/${id}/messages`,
    conversation: (id: string) => `/v1/support/conversations/${id}`,
  },

  /** Unauthenticated, read-only, four flags (05-FUNCTIONALITY.md § 2.9). */
  chaos: {
    frontend: '/v1/chaos/frontend',
  },

  admin: {
    chaos: '/v1/admin/chaos',
    chaosReset: '/v1/admin/chaos/reset',
    scenarios: '/v1/admin/scenarios',
    scenarioApply: (id: string) => `/v1/admin/scenarios/${id}/apply`,
    scenarioRevert: (id: string) => `/v1/admin/scenarios/${id}/revert`,
    status: '/v1/admin/status',
    loadgen: '/v1/admin/loadgen',
    seedReset: '/v1/admin/seed/reset',
    version: '/v1/admin/version',
  },
} as const;
