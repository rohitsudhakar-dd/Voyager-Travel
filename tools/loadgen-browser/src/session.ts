/**
 * One browser session: land, search, maybe convert, leave.
 *
 * Every step is gated on the funnel in funnel.ts, so a session stops where a
 * real traveller's would. That drop-off is the point of running a real
 * browser at all -- k6 can produce the API load far more cheaply, but only
 * Chromium executes the RUM SDK, and only RUM can show the funnel.
 *
 * Nothing in here knows a selector. Everything the front end looks like is in
 * ui.ts, so reconciling against a UI change is one file.
 */

import type { Browser, BrowserContext, Locator, Page } from 'playwright';

import { FUNNEL, type FunnelStep, advancesFrom } from './funnel';
import { ACTIONS, ROUTES, TESTIDS, byAction, byActionOrTestId, byTestId } from './ui';

const BASE_URL = (process.env.WEB_BASE_URL ?? 'http://web-ui:8080').replace(/\/$/, '');
const UI_ORIGIN = new URL(BASE_URL).origin;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL ?? 'http://api-gateway:4000').replace(/\/$/, '');

/** A cold search fans out to four providers; the UI itself waits this long. */
const RESULTS_TIMEOUT_MS = 25000;
const CONFIRMATION_TIMEOUT_MS = 45000;
const ELEMENT_TIMEOUT_MS = 12000;

/**
 * Pairs the seeder actually schedules. Only 220 ordered pairs have flights,
 * so a randomly assembled origin and destination mostly produces an empty
 * results page, and a week of empty results looks like a broken funnel
 * rather than a thin one.
 */
const ROUTE_PAIRS = [
  ['LHR', 'JFK'], ['CDG', 'LHR'], ['AMS', 'BCN'], ['LHR', 'DXB'],
  ['JFK', 'LAX'], ['DXB', 'SIN'], ['CPH', 'DUB'], ['FRA', 'ORD'],
  ['LHR', 'ZRH'], ['SEA', 'ARN'], ['ATH', 'DOH'], ['SFO', 'BOM'],
];

const GIVEN_NAMES = ['Ada', 'Bruno', 'Chidi', 'Dagny', 'Elif', 'Farid', 'Greta', 'Hiro'];
const FAMILY_NAMES = ['Okonkwo', 'Vasquez', 'Lindqvist', 'Haddad', 'Novak', 'Ferreira'];

/** The mock provider's always-succeeds card (05-FUNCTIONALITY.md § 5.2). */
const TEST_CARD = { number: '4242424242424242', expiry: '12/29', cvc: '123' };

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Raised when the page loaded but did not contain something the funnel needs.
 * Distinct from a network failure on purpose: it should read as "the UI is
 * not what this generator was written against" rather than as a crash, and
 * it is the signal the supervisor backs off on.
 */
export class UiMismatchError extends Error {
  constructor(readonly selector: string, readonly step: FunnelStep) {
    super(`No element matching ${selector} at funnel step ${step}`);
    this.name = 'UiMismatchError';
  }
}

export type SessionOutcome = {
  reached: FunnelStep;
  confirmed: boolean;
};

export async function runSession(browser: Browser, shouldStop: () => boolean): Promise<SessionOutcome> {
  const context = await browser.newContext({
    viewport: pick([
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]),
    locale: 'en-GB',
    // The default Chromium user agent is left alone. RUM parses it into
    // device and browser facets, and a custom string would file every
    // synthetic session under "unknown browser" -- which is the one facet
    // nobody can segment out.
  });

  await forwardApiToGateway(context);

  const page = await context.newPage();
  let reached: FunnelStep = 'landed';

  try {
    await page.goto(`${BASE_URL}${ROUTES.home}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await expect(page, byTestId(page, TESTIDS.searchForm), TESTIDS.searchForm, 'landed');

    // The RUM SDK batches. Leaving before it flushes would lose the view
    // this session just created, which is the one thing it exists to record.
    await think(2, 6);
    if (shouldStop() || !advancesFrom('landed')) return outcome(reached);

    await fillSearchForm(page);
    await byActionOrTestId(page, ACTIONS.submitFlightSearch, TESTIDS.searchSubmit).click({
      timeout: ELEMENT_TIMEOUT_MS,
    });
    reached = 'searched';
    if (shouldStop() || !advancesFrom('searched')) return outcome(reached);

    // A search that never leaves the form is a rejected search, not a slow
    // one, and saying so names the field the UI would not accept instead of
    // reporting a bare navigation timeout every session.
    try {
      await page.waitForURL(`**${ROUTES.results}**`, { timeout: RESULTS_TIMEOUT_MS });
    } catch {
      throw new UiMismatchError(ROUTES.results, 'searched');
    }
    await expect(page, byTestId(page, TESTIDS.flightResultRow), TESTIDS.flightResultRow, 'results');
    reached = 'results';

    // Scanning a results page is the longest dwell in the funnel, and it is
    // where `frontend_blocking_js` and `frontend_heavy_assets` do their
    // damage. Rushing it would hide both.
    await think(6, 20);
    await page.mouse.wheel(0, 400 + Math.random() * 1200);
    await think(2, 8);
    if (shouldStop() || !advancesFrom('results')) return outcome(reached);

    await selectResult(page);
    reached = 'selected';
    if (shouldStop() || !advancesFrom('selected')) return outcome(reached);

    await page.waitForURL(`**${ROUTES.checkoutReview}**`, { timeout: RESULTS_TIMEOUT_MS });
    reached = 'review';
    await think(5, 15);
    if (shouldStop() || !advancesFrom('review')) return outcome(reached);

    await byTestId(page, TESTIDS.reviewContinue).click({ timeout: ELEMENT_TIMEOUT_MS });
    await fillPassengers(page);
    await byActionOrTestId(page, ACTIONS.submitPassengerDetails, TESTIDS.passengersContinue).click({
      timeout: ELEMENT_TIMEOUT_MS,
    });
    reached = 'passengers';
    if (shouldStop() || !advancesFrom('passengers')) return outcome(reached);

    await think(4, 12);
    await fillPayment(page);
    await byActionOrTestId(page, ACTIONS.submitPayment, TESTIDS.paymentSubmit).click({
      timeout: ELEMENT_TIMEOUT_MS,
    });
    reached = 'payment';

    // The last rung is not abandonment in the usual sense: confirmation is
    // asynchronous and the page polls for up to thirty seconds. Some people
    // close the tab while it spins, and that is exactly the 19 to 17 step.
    if (!advancesFrom('payment')) return outcome(reached);

    await page.waitForURL(`**${ROUTES.confirmation}**`, { timeout: CONFIRMATION_TIMEOUT_MS });
    await expect(page, byTestId(page, TESTIDS.confirmation), TESTIDS.confirmation, 'payment');
    reached = 'confirmed';
    await think(4, 10);
    if (Math.random() < 0.3) {
      await byAction(page, ACTIONS.copyPnr).click({ timeout: ELEMENT_TIMEOUT_MS }).catch(() => {});
    }
    return outcome(reached);
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Whether the origin serving the page also answers its API calls.
 *
 * Behind the edge it does, and those calls have to keep going through it or
 * Caddy stops seeing the traffic a real session makes. Pointed straight at
 * web-ui -- the laptop default, because the edge holds a certificate for the
 * public hostname and not for the name this container would have to dial --
 * it does not. web-ui serves the SPA for every path it does not recognise,
 * so an API call comes back as the index page under a 200, and the page
 * cannot tell that from an empty answer. It shows as "No matches" in the
 * airport field, and no session ever reaches a results page.
 *
 * Probed rather than configured because the answer is a property of wherever
 * WEB_BASE_URL happens to point, and a flag for it is one more thing to set
 * correctly in two environments.
 */
let originApiProbe: Promise<boolean> | undefined;

function originServesApi(): Promise<boolean> {
  originApiProbe ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/ref/airports?q=LHR`, {
        signal: AbortSignal.timeout(5000),
      });
      return (response.headers.get('content-type') ?? '').includes('application/json');
    } catch {
      return false;
    }
  })();
  return originApiProbe;
}

/**
 * Vite bakes `VITE_API_BASE_URL` into the bundle at build time, and the demo
 * builds it as the public origin a person's browser uses. That origin does
 * not resolve from inside the compose network, so every API call the page
 * makes would fail with a connection refused and the funnel would never get
 * past the airport field. Anything aimed at an API path on some other origin
 * is therefore replayed against GATEWAY_BASE_URL from Node, where no origin
 * policy applies, and handed back to the page as if it had answered.
 *
 * This is deliberately conditional. When the UI is served same-origin with
 * its API, which is what the edge proxy is for, the first branch takes every
 * request and this costs one comparison.
 */
async function forwardApiToGateway(context: BrowserContext): Promise<void> {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === UI_ORIGIN && (await originServesApi())) return route.continue();

    const headers = { ...request.headers() };
    delete headers.host;

    try {
      const response = await context.request.fetch(`${GATEWAY_BASE_URL}${url.pathname}${url.search}`, {
        method: request.method(),
        headers,
        data: request.postDataBuffer() ?? undefined,
        maxRedirects: 0,
        timeout: 40000,
      });
      await route.fulfill({
        response,
        // The page still believes it made a cross-origin call, so the
        // response has to carry permission for one or Chromium discards it
        // before the application ever sees the body.
        headers: {
          ...response.headers(),
          'access-control-allow-origin': UI_ORIGIN,
          'access-control-allow-credentials': 'true',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    } catch {
      await route.abort();
    }
  });
}

function outcome(reached: FunnelStep): SessionOutcome {
  return { reached, confirmed: reached === 'confirmed' };
}

async function fillSearchForm(page: Page): Promise<void> {
  const [origin, destination] = pick(ROUTE_PAIRS);

  await fillCombobox(page, TESTIDS.searchOrigin, origin);
  await think(1, 3);
  await fillCombobox(page, TESTIDS.searchDestination, destination);
  await think(1, 3);

  const departure = new Date(Date.now() + (7 + Math.floor(Math.random() * 60)) * 86400000);
  await pickDepartureDate(page, departure);
  await think(1, 4);
}

/**
 * The airport fields are comboboxes with a debounce, so typing and tabbing
 * away would leave them unset. Picking a suggestion is also what produces the
 * `Select airport suggestion` RUM action and the `/ref/airports` traces that
 * go with it.
 */
async function fillCombobox(page: Page, testId: string, value: string): Promise<void> {
  const input = byTestId(page, testId);
  await input.click({ timeout: ELEMENT_TIMEOUT_MS });
  await input.fill('');
  await input.type(value, { delay: 90 });

  const suggestion = byActionOrTestId(page, ACTIONS.selectAirportSuggestion, TESTIDS.comboboxOption);
  try {
    await suggestion.waitFor({ state: 'visible', timeout: 6000 });
  } catch {
    throw new UiMismatchError(TESTIDS.comboboxOption, 'landed');
  }
  await suggestion.click();

  // Choosing a suggestion has to leave the field showing the airport. An
  // empty field here means the option the UI rendered carried none of the
  // data it expects, which fails silently at submit time rather than here.
  if ((await input.inputValue()).trim() === '') {
    throw new UiMismatchError(`${testId} (empty after choosing a suggestion)`, 'landed');
  }
}

/**
 * The departure field is a popover calendar, not a text input, so the date
 * has to be reached by paging months and clicking the day. Matching on the
 * day's accessible name rather than its position is what keeps this working
 * across the one-month and two-month layouts.
 */
async function pickDepartureDate(page: Page, departure: Date): Promise<void> {
  await byTestId(page, TESTIDS.departDate).click({ timeout: ELEMENT_TIMEOUT_MS });

  const label = `${WEEKDAY_NAMES[departure.getDay()]} ${departure.getDate()} ${
    MONTH_NAMES[departure.getMonth()]
  } ${departure.getFullYear()}`;
  const cell = page.locator(`[data-testid="${TESTIDS.dateCell}"][aria-label="${label}"]:visible`).first();

  // Days outside the visible month are rendered but hidden, so paging is the
  // only way to reach a departure two or three months out.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await cell.isVisible().catch(() => false)) break;
    await byTestId(page, TESTIDS.dateNextMonth).click({ timeout: ELEMENT_TIMEOUT_MS });
    await page.waitForTimeout(150);
  }

  try {
    await cell.click({ timeout: ELEMENT_TIMEOUT_MS });
  } catch {
    throw new UiMismatchError(TESTIDS.dateCell, 'landed');
  }

  // The narrow layout keeps the calendar open behind a Done button, and the
  // search button underneath it is not clickable until that closes.
  const done = byTestId(page, TESTIDS.datePickerDone);
  if (await done.isVisible().catch(() => false)) await done.click();
}

/** Picks from the top of the list, the way someone scanning results does. */
async function selectResult(page: Page): Promise<void> {
  const buttons = page.locator(`[data-testid="${TESTIDS.flightResultSelect}"]`);
  const available = await buttons.count();
  if (available === 0) throw new UiMismatchError(TESTIDS.flightResultSelect, 'results');
  await buttons.nth(Math.floor(Math.random() * Math.min(available, 5))).click({
    timeout: ELEMENT_TIMEOUT_MS,
  });
}

async function fillPassengers(page: Page): Promise<void> {
  // Typing passport details is the slowest step of a real checkout, and the
  // step where the hold countdown starts to matter to the traveller.
  await byTestId(page, TESTIDS.passengerFirstName).fill(pick(GIVEN_NAMES), {
    timeout: ELEMENT_TIMEOUT_MS,
  });
  await byTestId(page, TESTIDS.passengerLastName).fill(pick(FAMILY_NAMES));
  await byTestId(page, TESTIDS.passengerDateOfBirth).fill('1988-04-12');
  await byTestId(page, TESTIDS.passengerNationality).fill('GB');

  // Same synthetic domain the API generator uses, so one query finds every
  // booking either of them made and nothing a demo audience created.
  await byTestId(page, TESTIDS.contactEmail).fill(
    `traveller-${Math.floor(Math.random() * 100000)}@loadgen.voyager.demo`,
  );
  await byTestId(page, TESTIDS.contactPhone).fill('+441632960123');
  await think(8, 22);
}

async function fillPayment(page: Page): Promise<void> {
  await byTestId(page, TESTIDS.cardHolder).fill('A TRAVELLER', { timeout: ELEMENT_TIMEOUT_MS });
  await byTestId(page, TESTIDS.cardNumber).fill(TEST_CARD.number);
  await byTestId(page, TESTIDS.cardExpiry).fill(TEST_CARD.expiry);
  await byTestId(page, TESTIDS.cardCvc).fill(TEST_CARD.cvc);
  await think(4, 10);
}

/**
 * Waits for one element and turns its absence into a UiMismatchError, so the
 * supervisor can say which selector was missing instead of printing a
 * Playwright stack trace every few seconds.
 */
async function expect(page: Page, locator: Locator, selector: string, step: FunnelStep): Promise<void> {
  try {
    await locator.waitFor({ state: 'visible', timeout: ELEMENT_TIMEOUT_MS });
  } catch (error) {
    throw new UiMismatchError(selector, step);
  }
}

function think(lowSeconds: number, highSeconds: number): Promise<void> {
  const milliseconds = (lowSeconds + Math.random() * (highSeconds - lowSeconds)) * 1000;
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

/** Exported for the supervisor's per-step counters. */
export const FUNNEL_STEPS = FUNNEL.map((entry) => entry.step);
