/**
 * Voyager browser load generator.
 *
 * Keeps a small pool of headless Chromium sessions walking the booking funnel
 * so RUM has continuous, realistically-shaped traffic. k6 cannot do this job:
 * RUM only exists if a real browser engine runs the SDK, and the funnel
 * widget on dashboard D5 has nothing to draw without it.
 *
 * Two behaviours are worth knowing before reading the loop below.
 *
 * Sessions are started by a supervisor tick rather than run by long-lived
 * workers, and each one is told its rank in the pool. Lowering concurrency
 * therefore retires the newest sessions at their next step boundary instead
 * of waiting for a checkout to finish, which is what keeps an admin change
 * inside the 30-second budget.
 *
 * The front end may not be there at all. Phase 7 is built after this, and on
 * a half-brought-up stack `web-ui` is routinely missing. That is a state to
 * report, not to crash on, so the generator idles and says so once rather
 * than restarting in a loop.
 */

import { chromium, type Browser } from 'playwright';

import { FUNNEL } from './funnel';
import { log } from './logger';
import { closeRedis } from './redis';
import { UiMismatchError, runSession } from './session';
import { MAX_CONCURRENCY, browserSettings } from './settings';
import { count, publish } from './stats';

const BASE_URL = (process.env.WEB_BASE_URL ?? 'http://web-ui:8080').replace(/\/$/, '');

const TICK_MS = 1000;
const PROBE_WHEN_DOWN_MS = 15000;
const PROBE_WHEN_UP_MS = 60000;

/**
 * A page that answers but has none of the funnel's elements fails after the
 * element timeout, every time. Backing off turns a wall of identical
 * warnings into one every half minute, which is the difference between a log
 * an operator reads and one they mute.
 */
const MISMATCH_BACKOFF_MS = 30000;

/** How long a retiring session is given to reach a step boundary and stop. */
const DRAIN_TIMEOUT_MS = 30000;

/** How often an unreachable front end is mentioned again. */
const REANNOUNCE_MS = 600000;

let running = true;
let uiReachable = false;
let announced: boolean | null = null;
let announcedAt = 0;
let probedAt = 0;
let mismatchUntil = 0;
let nextSessionId = 1;
let target = 0;
let lastIssue = '';

const live = new Set<number>();

async function main(): Promise<void> {
  const browser = await chromium.launch({
    args: [
      // /dev/shm defaults to 64 MB in Docker and Chromium will crash on a
      // results page without this. The alternative is shm_size in Compose,
      // which would be one more thing to remember on a new host.
      '--disable-dev-shm-usage',
      // Chromium's own sandbox needs privileges this container deliberately
      // does not have. The only origin it ever visits is Voyager's own.
      '--no-sandbox',
    ],
  });

  log.info(
    { baseUrl: BASE_URL, maxConcurrency: MAX_CONCURRENCY },
    'Browser load generator started',
  );

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (running) {
    await tick(browser);
    await sleep(TICK_MS);
  }

  await drain();
  await browser.close().catch(() => {});
  await closeRedis();
  log.info('Browser load generator stopped');
}

async function tick(browser: Browser): Promise<void> {
  const settings = await browserSettings();
  await refreshReachability();

  target = settings.enabled && uiReachable && Date.now() >= mismatchUntil ? settings.concurrency : 0;

  await publish({
    browser_enabled: settings.enabled ? 1 : 0,
    browser_concurrency: settings.concurrency,
    browser_target: target,
    browser_in_flight: live.size,
    browser_ui_reachable: uiReachable ? 1 : 0,
    browser_max_concurrency: MAX_CONCURRENCY,
    browser_updated_at: Date.now(),
    browser_funnel: JSON.stringify(Object.fromEntries(FUNNEL.map((s) => [s.step, s.rate]))),
    // Whoever is looking at an empty funnel is looking at the stats hash,
    // not at this container's logs, so the reason has to travel with the
    // counters rather than sit in a stream nobody is tailing.
    browser_last_issue: lastIssue,
  });

  while (live.size < target) start(browser);
}

function start(browser: Browser): void {
  const id = nextSessionId;
  nextSessionId += 1;
  live.add(id);

  void (async () => {
    try {
      await count('browser_sessions');
      const outcome = await runSession(browser, () => !running || rank(id) >= target);
      await count(`browser_reached_${outcome.reached}`);
      if (outcome.confirmed) await count('browser_confirmed');
    } catch (error) {
      await handle(error);
    } finally {
      live.delete(id);
    }
  })();
}

/**
 * Ranked by session id, so the oldest sessions are the ones that survive a
 * reduction. Retiring the newest is both cheaper -- they have less work
 * invested -- and kinder to the funnel, because a session killed at step two
 * is indistinguishable from a bounce while one killed at step seven is a
 * booking that never happened.
 */
function rank(id: number): number {
  let ahead = 0;
  for (const other of live) if (other < id) ahead += 1;
  return ahead;
}

async function handle(error: unknown): Promise<void> {
  if (error instanceof UiMismatchError) {
    lastIssue = `${error.step}: no ${error.selector}`;
    await count('browser_ui_mismatch');
    if (Date.now() >= mismatchUntil) {
      mismatchUntil = Date.now() + MISMATCH_BACKOFF_MS;
      log.warn(
        { selector: error.selector, step: error.step, baseUrl: BASE_URL },
        'The UI answered but does not present the element this journey needs; pausing sessions',
      );
    }
    return;
  }

  lastIssue = (error as Error).message.split('\n')[0].slice(0, 160);
  await count('browser_errors');
  log.warn({ error: (error as Error).message }, 'Session ended early');
}

async function refreshReachability(): Promise<void> {
  const interval = uiReachable ? PROBE_WHEN_UP_MS : PROBE_WHEN_DOWN_MS;
  if (Date.now() - probedAt < interval) return;
  probedAt = Date.now();

  const reachable = await probe();
  const changed = reachable !== announced;
  uiReachable = reachable;

  // Announced on every change, and repeated while the front end is down so
  // that whoever asks "why is RUM empty?" two hours later finds the answer
  // in the recent log rather than at the top of the container's history.
  if (!changed && (reachable || Date.now() - announcedAt < REANNOUNCE_MS)) return;
  announced = reachable;
  announcedAt = Date.now();

  if (reachable) {
    log.info({ baseUrl: BASE_URL }, 'Front end is reachable; starting sessions');
  } else {
    log.warn(
      { baseUrl: BASE_URL },
      'Front end is not reachable; idling until it is. This is expected until Phase 7 ships web-ui',
    );
  }
}

async function probe(): Promise<boolean> {
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

function stop(signal: string): void {
  if (!running) return;
  running = false;
  log.info({ signal }, 'Shutting down');
}

/** Sessions check `shouldStop` at every step boundary, so this is quick. */
async function drain(): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (live.size > 0 && Date.now() < deadline) await sleep(250);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  log.error({ error: (error as Error).message }, 'Browser load generator failed to start');
  process.exit(1);
});
