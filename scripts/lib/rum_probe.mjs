/**
 * Drives one real browser session against the storefront and prints what the
 * RUM SDK actually did, as a single JSON object on stdout.
 *
 * It runs inside the `voyager-loadgen-browser` image because that image already
 * carries Chromium and a matching Playwright, and because RUM only exists if a
 * real browser engine executes the SDK -- reading the bundle proves the code
 * shipped, not that it ran. There is no host Node toolchain, so this is the only
 * way scripts/verify-rum.sh can assert on live behaviour.
 *
 * Everything it reports is an observation. It makes no assertions; verify-rum.sh
 * owns those, so the pass/fail rules live with the other verify scripts.
 */

import { chromium } from 'playwright';

const BASE_URL = process.env.WEB_BASE_URL ?? 'http://web-ui:8080';

/** Long enough for the SDK's view, resource and replay batches to flush. */
const FLUSH_MS = 12_000;

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const out = { baseUrl: BASE_URL, errors: [] };
  page.on('pageerror', (error) => out.errors.push(String(error.message)));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction('!!window.DD_RUM', null, { timeout: 15_000 }).catch(() => {});

  out.config = await page.evaluate(() => {
    const rum = window.DD_RUM;
    if (!rum) return null;
    const c = rum.getInitConfiguration() ?? {};
    const logs = window.DD_LOGS ? window.DD_LOGS.getInitConfiguration() ?? {} : null;
    return {
      sdkVersion: rum.version,
      applicationId: c.applicationId ?? '',
      clientTokenPrefix: String(c.clientToken ?? '').slice(0, 3),
      site: c.site,
      service: c.service,
      env: c.env,
      version: c.version,
      sessionSampleRate: c.sessionSampleRate,
      sessionReplaySampleRate: c.sessionReplaySampleRate,
      trackUserInteractions: c.trackUserInteractions === true,
      trackResources: c.trackResources === true,
      trackLongTasks: c.trackLongTasks === true,
      trackViewsManually: c.trackViewsManually === true,
      defaultPrivacyLevel: c.defaultPrivacyLevel,
      allowedTracingUrls: c.allowedTracingUrls ?? [],
      sessionId: (rum.getInternalContext() ?? {}).session_id ?? null,
      initialView: ((rum.getInternalContext() ?? {}).view ?? {}).name ?? null,
      logsService: logs ? logs.service : null,
      logsForwardErrors: logs ? logs.forwardErrorsToLogs === true : null,
      logsForwardConsole: logs ? logs.forwardConsoleLogs : null,
    };
  });

  if (!out.config) {
    out.fatal = 'window.DD_RUM is absent -- the SDK never initialised';
    console.log(JSON.stringify(out));
    await browser.close();
    process.exit(0);
  }

  // Which origin RUM was told to trace. Taken from the live configuration rather
  // than assumed, so this probe stays correct behind the edge proxy (same-origin)
  // and against a published gateway port (cross-origin) alike.
  const tracingOrigin = await page.evaluate(() => {
    const entries = (window.DD_RUM.getInitConfiguration() ?? {}).allowedTracingUrls ?? [];
    const first = entries[0];
    return typeof first === 'string' ? first : first && first.match;
  });
  out.tracingOrigin = tracingOrigin ?? null;

  // The headers RUM attaches, captured in the page. XHR is used rather than
  // fetch because RUM sets XHR headers through setRequestHeader, which is
  // observable; its fetch instrumentation mutates the init it passes to the
  // fetch it captured at init time, which is not.
  //
  // The second probe is the control: an asset on the page's own origin must come
  // out with no trace headers at all, or `allowedTracingUrls` is matching
  // everything and the first result means nothing.
  out.propagation = await page.evaluate(
    async ({ origin, pageOrigin }) => {
      const captured = { traced: {}, control: {} };
      const original = XMLHttpRequest.prototype.setRequestHeader;
      let bucket = null;
      XMLHttpRequest.prototype.setRequestHeader = function (key, value) {
        if (bucket) bucket[String(key).toLowerCase()] = value;
        return original.apply(this, arguments);
      };
      const probe = (url, into) =>
        new Promise((resolve) => {
          bucket = into;
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url);
          const done = () => {
            bucket = null;
            resolve(xhr.status);
          };
          xhr.onloadend = done;
          xhr.onerror = done;
          xhr.send();
        });

      const tracedStatus = await probe(`${origin}/api/v1/ref/airlines`, captured.traced);
      const controlStatus = await probe(`${pageOrigin}/favicon.svg`, captured.control);
      XMLHttpRequest.prototype.setRequestHeader = original;

      return {
        tracedStatus,
        tracedHeaders: captured.traced,
        controlStatus,
        controlHeaders: captured.control,
      };
    },
    { origin: tracingOrigin, pageOrigin: BASE_URL },
  );

  // Client-side route changes, to prove view names come from the route pattern.
  out.views = await page.evaluate(async () => {
    const seen = [];
    const note = () => {
      const context = window.DD_RUM.getInternalContext() ?? {};
      seen.push({ path: location.pathname, view: (context.view ?? {}).name ?? null });
    };
    note();
    for (const href of ['/manage', '/search/hotels', '/signup']) {
      const link = document.querySelector(`a[href="${href}"]`);
      if (!link) continue;
      link.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      note();
    }
    return seen;
  });

  await page.evaluate(() => window.DD_RUM.addAction('Toggle theme', { theme: 'dark' }));
  await page.waitForTimeout(FLUSH_MS);

  // What the intake actually answered. responseStatus is the only place a
  // beacon's HTTP status is visible from inside the page, and it is the
  // difference between "the SDK tried" and "Datadog accepted it": a revoked
  // client token produces exactly the same resource entry with a 403.
  out.beacons = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('browser-intake'))
      .map((entry) => ({
        endpoint: new URL(entry.name).pathname,
        status: entry.responseStatus ?? null,
      })),
  );

  out.replayLink = await page.evaluate(() => window.DD_RUM.getSessionReplayLink() ?? null);

  console.log(JSON.stringify(out));
  await browser.close();
}

main().catch((error) => {
  console.log(JSON.stringify({ fatal: String((error && error.stack) || error) }));
  process.exit(0);
});
