/**
 * Every Datadog browser setting the app has, in one file.
 *
 * A customer should be able to read this file and understand the whole
 * front-end integration: initialisation, view naming, user context, the action
 * taxonomy helper, and the five custom timings. Nothing else in `src/` calls
 * `datadogRum` or `datadogLogs` directly.
 */

import { datadogLogs } from '@datadog/browser-logs';
import { datadogRum } from '@datadog/browser-rum';
import { matchRoutes } from 'react-router-dom';
import { env } from '@/lib/env';

const SERVICE = 'voyager-web';

/**
 * The route patterns from 06-USER-FLOWS.md § 2 paired with the view name RUM
 * reports for each.
 *
 * They are patterns, not paths, and react-router's own matcher ranks them, so
 * `/manage/:pnr` cannot shadow `/manage`. A view named after an instantiated
 * path would produce one view per search id, which is the failure mode § 2
 * calls out by name: thousands of one-off views and no usable analytics.
 */
export const VIEW_ROUTES: ReadonlyArray<{ path: string; view: string }> = [
  { path: '/', view: '/home' },
  { path: '/search/flights', view: '/search/flights' },
  { path: '/search/hotels', view: '/search/hotels' },
  { path: '/results/flights/:searchId', view: '/results/flights' },
  { path: '/results/hotels/:searchId', view: '/results/hotels' },
  { path: '/detail/:searchId/:resultId', view: '/detail' },
  { path: '/checkout/:bookingId/review', view: '/checkout/review' },
  { path: '/checkout/:bookingId/passengers', view: '/checkout/passengers' },
  { path: '/checkout/:bookingId/payment', view: '/checkout/payment' },
  { path: '/confirmation/:bookingId', view: '/confirmation' },
  { path: '/manage', view: '/manage' },
  { path: '/manage/:pnr', view: '/manage/detail' },
  { path: '/account', view: '/account' },
  { path: '/login', view: '/login' },
  { path: '/signup', view: '/signup' },
  { path: '/admin', view: '/admin' },
];

const MATCHABLE = VIEW_ROUTES.map(({ path }) => ({ path }));
const VIEW_BY_PATTERN = new Map(VIEW_ROUTES.map(({ path, view }) => [path, view]));

/** The five timings in 06-USER-FLOWS.md § 7.1. */
export type CustomTiming =
  | 'time_to_first_result'
  | 'time_to_interactive_results'
  | 'checkout_step_duration'
  | 'time_to_confirmation'
  | 'support_first_token';

/**
 * The origin `allowedTracingUrls` has to name.
 *
 * It is derived rather than configured because it must equal the origin the
 * browser really calls: `VITE_API_BASE_URL` is a relative path when the SPA
 * and the gateway share an origin behind the edge proxy, and an absolute URL
 * when the gateway answers on its own port. A hardcoded value that disagrees
 * with the deployment produces no error anywhere -- the browser simply stops
 * attaching trace headers, and RUM sessions and APM traces quietly stop
 * linking, which is half of what Phase 9 exists to demonstrate.
 */
function tracingOrigin(): string {
  try {
    return new URL(env.apiBaseUrl, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

let initialised = false;

export function initDatadog(): void {
  if (initialised) return;
  // No credentials is a legitimate local configuration (`make web-ui` against
  // the fixture layer), so this returns quietly instead of throwing.
  if (!env.rumApplicationId || !env.rumClientToken) return;
  initialised = true;

  const identity = {
    clientToken: env.rumClientToken,
    site: env.ddSite,
    service: SERVICE,
    env: env.ddEnv,
    version: env.version,
  };

  datadogRum.init({
    ...identity,
    applicationId: env.rumApplicationId,
    sessionSampleRate: env.rumSessionSampleRate,
    sessionReplaySampleRate: env.rumSessionReplaySampleRate,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    // Card numbers, CVCs and passport numbers are all user input, and this is
    // the setting that keeps them out of Session Replay by default. The
    // individual card fields additionally carry data-dd-privacy="mask", so a
    // future change to this value cannot expose them.
    defaultPrivacyLevel: 'mask-user-input',
    // Views come from `startRumView` below. Automatic tracking would name them
    // after the instantiated path.
    trackViewsManually: true,
    allowedTracingUrls: [
      { match: tracingOrigin(), propagatorTypes: ['datadog', 'tracecontext'] },
    ],
  });

  datadogLogs.init({
    ...identity,
    forwardErrorsToLogs: true,
    forwardConsoleLogs: 'all',
    sessionSampleRate: env.rumSessionSampleRate,
  });

  // 06-USER-FLOWS.md § 7.2. Set before any login so the funnel can be split by
  // guest against member; `setRumUser` overwrites it when someone signs in.
  datadogRum.setGlobalContextProperty('user_type', 'guest');
}

export function viewNameFor(pathname: string): string | null {
  const matches = matchRoutes(MATCHABLE, pathname);
  const matched = matches?.[matches.length - 1]?.route.path;
  return matched ? VIEW_BY_PATTERN.get(matched) ?? null : null;
}

let currentView: string | null = null;

/**
 * Name the view for a location. Unmatched paths become `/not-found` rather
 * than being skipped: a view left unstarted would attribute the 404's
 * resources and errors to whichever screen the visitor came from.
 */
export function startRumView(pathname: string): void {
  if (!initialised) return;
  const view = viewNameFor(pathname) ?? '/not-found';
  if (view === currentView) return;
  currentView = view;
  datadogRum.startView({ name: view });
}

/** View attributes, for the instance ids that must not reach the view name. */
export function setViewAttribute(key: string, value: unknown): void {
  if (!initialised) return;
  datadogRum.setViewContextProperty(key, value);
}

// ------------------------------------------------------------------ user --

/** The five fields 06-USER-FLOWS.md § 7.2 names. The index signature is the
 * SDK's own `User` contract, which allows arbitrary extra properties. */
interface RumUser {
  [key: string]: unknown;
  id: string;
  email: string;
  name: string;
  tier: string;
  signup_cohort: string | null;
}

export function setRumUser(user: RumUser): void {
  if (!initialised) return;
  datadogRum.setUser(user);
  datadogRum.setGlobalContextProperty('user_type', 'member');
  datadogLogs.setUser(user);
}

export function clearRumUser(): void {
  if (!initialised) return;
  datadogRum.clearUser();
  datadogRum.setGlobalContextProperty('user_type', 'guest');
  datadogLogs.clearUser();
}

// --------------------------------------------------------------- actions --

/**
 * Actions whose attributes are only known at runtime. The names themselves are
 * the Title-Case set in 06-USER-FLOWS.md § 7 -- most are declared on the
 * element as `data-dd-action-name` and collected by `trackUserInteractions`, so
 * this is for the handful that carry computed detail.
 */
export function trackAction(name: string, attributes?: Record<string, unknown>): void {
  if (!initialised) return;
  datadogRum.addAction(name, attributes);
}

// --------------------------------------------------------------- timings --

const marks = new Map<CustomTiming, number>();

export function startTiming(name: CustomTiming): void {
  marks.set(name, performance.now());
}

/**
 * Three of the five timings start on one view and finish on the next, so the
 * measured duration is passed explicitly. `addTiming` treats a value smaller
 * than a year as already-relative and records it verbatim; left to default it
 * would report time-since-navigation, which for `time_to_confirmation` is the
 * render cost of the confirmation page rather than the wait the traveller felt.
 */
export function stopTiming(name: CustomTiming): void {
  if (!initialised) {
    marks.delete(name);
    return;
  }
  const mark = marks.get(name);
  if (mark === undefined) return;
  marks.delete(name);
  datadogRum.addTiming(name, Math.max(1, Math.round(performance.now() - mark)));
}

/** True once `init` has run, so callers can skip work RUM would discard. */
export function rumStarted(): boolean {
  return initialised;
}
