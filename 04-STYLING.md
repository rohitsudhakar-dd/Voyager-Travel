# 04 — Styling & Design System

The UI has one job beyond being usable: **it must look like software a real company shipped.** A demo app that looks like a tutorial undermines everything the traces are trying to prove. Customers judge credibility in the first three seconds, before you've opened Datadog at all.

Two visual identities live in this app:
- **Voyager** — the customer-facing travel product. Warm, confident, commercial.
- **Voyager Ops** — the internal admin/chaos console. Dense, dark, utilitarian. Deliberately different, because internal tools always are.

---

## 1. Design principles

1. **Commercial, not cute.** This is a transactional product where people spend money. Restrained palette, real prices, no illustrations of smiling people.
2. **Density where it counts.** Search results are a scannable data table with imagery, not a wall of cards with 40 px of padding.
3. **The funnel is obvious.** At any point in checkout, the user knows which step they're on and what it costs.
4. **Every state is designed.** Loading, empty, error, partial, and slow all have real treatments — this matters enormously during chaos demos, where those states are the whole point.
5. **Instrumentation-friendly markup.** Stable `data-testid` and `data-dd-action-name` on everything interactive, from the first line of code.
6. **Ops console is visually distinct.** Nobody should ever confuse the chaos panel for the storefront.

---

## 2. Design tokens

Define once in `apps/web-ui/src/styles/tokens.css` as CSS custom properties, then map into `tailwind.config.ts`. Never hardcode a hex value in a component.

### 2.1 Color — Voyager (customer)

```css
:root {
  /* Brand — deep ocean blue. Trustworthy, travel-adjacent, not a copy of anyone. */
  --v-brand-50:  #eef4ff;
  --v-brand-100: #d9e5ff;
  --v-brand-200: #bcd2ff;
  --v-brand-300: #8eb4ff;
  --v-brand-400: #598bfd;
  --v-brand-500: #3565f4;
  --v-brand-600: #2149e0;  /* primary action */
  --v-brand-700: #1b3ab6;
  --v-brand-800: #1c3390;
  --v-brand-900: #1c2f72;

  /* Accent — warm amber. Prices, deals, loyalty. Used sparingly. */
  --v-accent-50:  #fff8ed;
  --v-accent-100: #ffefd4;
  --v-accent-300: #fdc069;
  --v-accent-500: #f79009;
  --v-accent-600: #dc6803;
  --v-accent-700: #b54708;

  /* Neutrals — slightly cool grey */
  --v-neutral-0:   #ffffff;
  --v-neutral-25:  #fcfcfd;
  --v-neutral-50:  #f8f9fc;
  --v-neutral-100: #f1f3f9;
  --v-neutral-200: #e4e7ef;
  --v-neutral-300: #ced3e0;
  --v-neutral-400: #98a2b3;
  --v-neutral-500: #667085;
  --v-neutral-600: #475467;
  --v-neutral-700: #344054;
  --v-neutral-800: #1d2939;
  --v-neutral-900: #101828;

  /* Semantic */
  --v-success-50:  #ecfdf3;  --v-success-500: #12b76a;  --v-success-700: #027a48;
  --v-warning-50:  #fffaeb;  --v-warning-500: #f79009;  --v-warning-700: #b54708;
  --v-danger-50:   #fef3f2;  --v-danger-500:  #f04438;  --v-danger-700:  #b42318;
  --v-info-50:     #eff8ff;  --v-info-500:    #2e90fa;  --v-info-700:    #175cd3;

  /* Applied roles */
  --v-bg:            var(--v-neutral-50);
  --v-bg-elevated:   var(--v-neutral-0);
  --v-bg-sunken:     var(--v-neutral-100);
  --v-border:        var(--v-neutral-200);
  --v-border-strong: var(--v-neutral-300);
  --v-text:          var(--v-neutral-900);
  --v-text-muted:    var(--v-neutral-500);
  --v-text-inverse:  var(--v-neutral-0);
}
```

### 2.2 Color — Voyager Ops (admin)

Scoped under `[data-theme="ops"]`, applied to the `/admin` route subtree only.

```css
[data-theme="ops"] {
  --v-bg:            #0b0f1a;
  --v-bg-elevated:   #141a29;
  --v-bg-sunken:     #070a12;
  --v-border:        #232b3d;
  --v-border-strong: #33405c;
  --v-text:          #e6eaf2;
  --v-text-muted:    #8b95ad;

  /* Ops accent — violet, so the chaos panel never reads as the storefront */
  --v-brand-600:     #7c5cfc;
  --v-brand-500:     #9277ff;
  --v-brand-700:     #6240e0;

  /* Status colors run hotter in the dark UI */
  --v-success-500:   #32d583;
  --v-warning-500:   #fdb022;
  --v-danger-500:    #ff6b5e;
}
```

### 2.3 Dark mode (customer side)

Optional but expected of a real product. Implement via `[data-theme="dark"]` on `<html>`, defaulting to `prefers-color-scheme` with a user override in `localStorage`. Redefine only the applied-role variables; never define a color exclusively inside a media query.

```css
[data-theme="dark"] {
  --v-bg:            #0f1420;
  --v-bg-elevated:   #171d2b;
  --v-bg-sunken:     #0a0e17;
  --v-border:        #252d3e;
  --v-border-strong: #364259;
  --v-text:          #e8ecf4;
  --v-text-muted:    #94a0b8;
}
```

### 2.4 Typography

```
Sans (UI + body):   "Inter var", Inter, -apple-system, "Segoe UI", Roboto, sans-serif
Mono (ops, IDs, code): "JetBrains Mono", "SF Mono", ui-monospace, monospace
```

Load Inter and JetBrains Mono from Google Fonts with `display=swap` and a full fallback stack. Type scale:

| Token | Size / line-height | Weight | Used for |
|---|---|---|---|
| `display-lg` | 44 / 52 | 700 | Hero on the search landing page |
| `display-sm` | 32 / 40 | 700 | Page titles |
| `heading-lg` | 24 / 32 | 600 | Section headings |
| `heading-md` | 20 / 28 | 600 | Card titles |
| `heading-sm` | 16 / 24 | 600 | Sub-headings, table headers |
| `body-lg` | 16 / 24 | 400 | Primary body |
| `body-md` | 14 / 20 | 400 | Default UI text |
| `body-sm` | 13 / 18 | 400 | Secondary detail |
| `caption` | 12 / 16 | 500 | Labels, badges, metadata |
| `price-lg` | 28 / 34 | 700, tabular-nums | Total price |
| `price-md` | 20 / 26 | 700, tabular-nums | Result price |
| `mono-sm` | 13 / 18 | 500 | PNRs, IDs, trace IDs, chaos flag names |

**Always** use `font-variant-numeric: tabular-nums` on prices, times, and durations. Prices that jitter as digits change look broken.

### 2.5 Spacing, radius, shadow, motion

Spacing: 4 px base — `0, 1(4), 2(8), 3(12), 4(16), 5(20), 6(24), 8(32), 10(40), 12(48), 16(64), 20(80)`.

```css
--v-radius-sm: 6px;   --v-radius-md: 10px;   --v-radius-lg: 14px;
--v-radius-xl: 20px;  --v-radius-full: 9999px;

--v-shadow-xs: 0 1px 2px rgba(16,24,40,.05);
--v-shadow-sm: 0 1px 3px rgba(16,24,40,.10), 0 1px 2px rgba(16,24,40,.06);
--v-shadow-md: 0 4px 8px -2px rgba(16,24,40,.10), 0 2px 4px -2px rgba(16,24,40,.06);
--v-shadow-lg: 0 12px 16px -4px rgba(16,24,40,.08), 0 4px 6px -2px rgba(16,24,40,.03);
--v-shadow-xl: 0 20px 24px -4px rgba(16,24,40,.08), 0 8px 8px -4px rgba(16,24,40,.03);

--v-ease:        cubic-bezier(.4,0,.2,1);
--v-ease-out:    cubic-bezier(0,0,.2,1);
--v-dur-fast:    120ms;
--v-dur-normal:  200ms;
--v-dur-slow:    320ms;
```

Respect `@media (prefers-reduced-motion: reduce)` — collapse all durations to `1ms`.

---

## 3. Layout

| Breakpoint | Width | Behavior |
|---|---|---|
| `sm` | 640 | Single column, bottom-sheet filters, sticky price bar |
| `md` | 768 | Two-column forms, filters in a drawer |
| `lg` | 1024 | Filter sidebar visible, results list beside it |
| `xl` | 1280 | Max content width 1200 px, centered |
| `2xl` | 1536 | Content stays 1200 px; gutters grow |

Grid: 12 columns, 24 px gutters at `lg`+. Search results use a `[280px | 1fr]` sidebar/content split at `lg`+.

Page chrome:
- **Header** — 64 px, sticky, `--v-bg-elevated` with a bottom border and `--v-shadow-xs` once scrolled. Logo, product tabs (Flights / Hotels), Manage booking, Support, theme toggle, account menu.
- **Footer** — three columns of links, plus a small build badge showing `DD_VERSION` and the short git SHA. The badge is a genuinely useful demo prop — it ties the UI to Deployment Tracking.
- **Checkout** — its own simplified header (logo + step indicator + secure-payment mark), no product nav, to reduce abandonment the way real OTAs do.

---

## 4. Component specifications

### 4.1 Search form (`SearchPanel`)
Elevated card overlapping the hero by 40 px. Tabs for Flights / Hotels. Flight fields: origin, destination (swap button between them), depart, return, passengers, cabin. Hotel fields: destination, check-in, check-out, guests, rooms. Prominent primary Search button. Airport autocomplete queries the gateway with 250 ms debounce — this is a nice secondary source of RUM actions and gateway traces.

`data-dd-action-name`: `Submit flight search`, `Submit hotel search`, `Swap airports`, `Select airport suggestion`. (Title Case, per § 8 and the canonical taxonomy in `06-USER-FLOWS.md § 7`. The `data-testid` values are the kebab-case ones: `search-submit`, `search-swap-airports`, `search-tab-flights`, `search-tab-hotels`.)

### 4.2 Result row (`FlightResultRow`)
A horizontal row, not a card — this is how real OTAs display flights and it reads as far more credible.

```
[airline logo 40px] [08:15 LHR ──── 5h 40m, nonstop ──── 11:55 JFK]  [cabin badge]  [£412  Select →]
```

- Airline logo: generated SVG monograms from the fictional airline codes. **Do not use real airline logos or marks.**
- Hover: `--v-border-strong` and `--v-shadow-sm`.
- Expandable detail row: segments, aircraft, baggage, fare conditions.
- Price uses `price-md` with tabular numerals.
- Skeleton variant required — during chaos demos users stare at these skeletons, so they must look intentional.

### 4.3 Hotel result card (`HotelResultCard`)
Horizontal card: 240×180 image, then name, star rating, neighborhood, review score chip, 3 amenity icons, then a right-aligned price block with "per night" and "total for N nights".

Images come from a deterministic local placeholder generator (seeded gradients + a geometric motif) rather than remote stock photos. Reasons: no external dependency, no licensing question, and the `frontend_heavy_assets` chaos flag can swap in deliberately oversized versions to tank LCP on demand.

### 4.4 Filter sidebar
Sticky, collapsible sections: price range (dual slider), stops, departure-time buckets, airlines, duration, amenities (hotels). Active filter count badge. "Clear all". Every filter change is a RUM action and re-queries the gateway — cheap, realistic trace volume.

### 4.5 Checkout stepper (`CheckoutStepper`)
Four steps: **Review → Passengers → Payment → Confirmation**. Horizontal on `md`+, compact "Step 2 of 4" on `sm`.

- Completed steps: filled brand circle with a check, clickable to go back.
- Current step: brand ring, bold label.
- Future steps: neutral, not clickable.
- A live **hold countdown timer** appears from the Passengers step onward: "Your fare is held for 14:32". It turns `--v-warning-500` under 5 minutes and `--v-danger-500` under 1 minute. This is one of the most effective demo props in the app — during S2 (payment brownout), the audience watches the timer run down while the payment retries.

### 4.6 Price summary (`PriceSummary`)
Sticky sidebar on `lg`+, collapsible sticky bottom bar on `sm`. Line items: base fare, taxes and fees, seat selection, baggage, then a bold total. Loyalty points to be earned shown as an amber accent line. Any line item that is still loading shows an inline shimmer rather than shifting layout.

### 4.7 Payment form
Card number, expiry, CVC, cardholder name, billing country. Card-type detection from the IIN. A 3DS step-up modal for the step-up path.

**Privacy requirement:** card number, CVC, and expiry inputs must carry `data-dd-privacy="mask"` and the app must run with `defaultPrivacyLevel: 'mask-user-input'`. Showing a session replay where the card number is visible ends the demo badly. Test this explicitly.

### 4.8 Confirmation page
Large success mark, PNR in `mono-sm` inside a copyable chip (e.g. `K8M2QR` — the alphabet excludes `0`, `1`, `I`, `O`), itinerary summary, passenger list, total paid, loyalty points earned, and "Add to calendar" / "Email itinerary" buttons. An amber info banner appears if the confirmation email hasn't arrived yet — which is exactly what scenario S5 (slow consumer) produces, so this state must be designed, not an afterthought.

### 4.9 Support chat (`SupportChat`)
Bottom-right launcher, expanding to a 400×600 panel. Streamed assistant messages with a typing indicator. **Tool calls are rendered visibly** as inline chips: "🔍 Looked up booking ABC123", "📋 Checked cancellation policy". This is deliberate — it makes the LLM Observability trace legible to the audience before you've even switched tabs.

### 4.10 Error, empty, and loading states

| State | Treatment |
|---|---|
| Search returned nothing | Illustration-free empty state, the parsed query echoed back, and 3 suggested alternative dates |
| Search failed | Danger-tinted card, "We couldn't reach our flight partners", a Retry button, and a small mono `requestId` — which is the trace ID. Tremendously useful in demos: read the ID off the screen, paste it into Datadog. |
| Search slow (> 3 s) | Progressive message: "Still searching…" at 3 s, "Our partners are responding slowly" at 8 s. Never a bare spinner. |
| Partial results | Info banner: "Showing 12 of 18 providers — some partners didn't respond in time." Realistic, and it maps directly to a partial GDS fan-out in the trace. |
| Hold expired | Full-page interstitial, not a toast. "Your fare hold expired." with a Search again CTA. |
| Payment declined | Inline danger box with the human-readable decline reason and a Try another card action |
| JS error boundary | Friendly fallback with a Reload button and the RUM session ID in mono text |

**Every one of these states must be reachable via a chaos flag.** Build them alongside the flags, not afterwards.

---

## 5. Voyager Ops — admin panel styling

Dark, dense, monospace-leaning. It should feel like an internal tool, because that's what makes it believable.

**Layout:** left nav (Chaos / Scenarios / Load / Status / Data), main content area, and a persistent top bar showing environment, `DD_VERSION`, and an active-chaos-count badge that glows danger-red when anything is on.

### 5.1 Chaos flag control
One row per flag:

```
[toggle]  gds_latency_ms                                    [====|====] 2000ms   [i]
          Adds latency to all mock-GDS responses.  Scenario: S1, S4
```

- Boolean flags: a toggle switch.
- Numeric flags: toggle + slider + numeric input.
- Enum flags: toggle + segmented control.
- Each row shows a one-line description and which scenarios use it.
- Active rows get a left border in `--v-danger-500` and a faint red-tinted background. You must be able to tell at a glance what is on.
- Flags are grouped into the eight groups from `05-FUNCTIONALITY.md § 11`: **Third parties**, **Database**, **Cache**, **Queue**, **Compute**, **Frontend**, **LLM**, **Meta**.
- The group list and every flag's type, default, description, and scenarios come from `GET /api/v1/admin/chaos` — **do not hardcode the flag list in the UI.**

### 5.2 Scenario cards
A 2-column grid of 10 cards. Each shows: ID badge (`S4`), title, a one-sentence story, the flags it sets, expected blast radius, and an **Apply** button. An applied scenario's card gets a danger border and its button becomes **Revert**.

Above the grid, a full-width, unmissable **RESET ALL CHAOS** button — danger-filled, 48 px tall. You will reach for this while talking, without looking. Make it impossible to miss.

### 5.3 Status grid
A card per service: name, health dot, p95 latency, error rate, request rate, and version. Polls `/api/v1/admin/status` every 5 s. Red border on unhealthy. Underneath, a strip for Postgres connections, Redis hit ratio and memory, and Kafka lag per consumer group.

### 5.4 Load control
Intensity segmented control (`Off / 1× / 2× / 5×`), separate API and browser toggles, current VU count, and a small Recharts sparkline of request rate over the last 15 minutes.

---

## 6. UI primitives to build

All in `apps/web-ui/src/components/ui/`. Each is a single file, forwards refs, accepts `className`, composes classes with `clsx` + `tailwind-merge`, and exports its variant types.

| Component | Variants / notes |
|---|---|
| `Button` | `primary`, `secondary`, `ghost`, `danger`, `link`; sizes `sm`/`md`/`lg`; `loading` and `disabled` states; optional leading/trailing icon |
| `IconButton` | Square, three sizes, required `aria-label` |
| `Input` | With label, hint, error text, prefix/suffix slots, character counter |
| `Select` | Native-backed for reliability; custom listbox variant for autocomplete |
| `Combobox` | Async autocomplete with debounce and keyboard nav — used for airports and cities |
| `DateRangePicker` | Two-month view, min/max dates, mobile bottom-sheet variant |
| `QuantityStepper` | Number input with −/+ — passengers, guests, rooms. (Named to avoid colliding with `CheckoutStepper`.) |
| `CheckoutStepper` | The four-step progress indicator from § 4.5 — horizontal on `md`+, "Step 2 of 4" on `sm` |
| `Card` | `flat`, `elevated`, `interactive` |
| `Badge` | `neutral`, `brand`, `success`, `warning`, `danger`, `info`; `sm`/`md`; dot variant |
| `Tabs` | Underline and pill variants, keyboard navigable |
| `Modal` | Focus trap, ESC to close, scroll lock, `sm`/`md`/`lg` |
| `Drawer` | Right on desktop, bottom on mobile |
| `Toast` | Four intents, auto-dismiss, stacking, region announced to screen readers |
| `Skeleton` | `text`, `circle`, `rect`, plus composed `ResultRowSkeleton` and `HotelCardSkeleton` |
| `EmptyState` | Icon, title, description, optional action |
| `Alert` | Inline, four intents, optional dismiss |
| `Tooltip` | Hover + focus, 300 ms delay |
| `Toggle` | Switch with label and description — the chaos panel's workhorse |
| `Slider` | Single and dual-handle, with value labels |
| `Table` | Sortable headers, sticky header, zebra optional, dense mode for Ops |
| `PriceTag` | Currency, amount, optional strikethrough, optional "from" prefix; tabular numerals |
| `CountdownTimer` | The hold timer — accepts a deadline, escalates color, fires a callback at zero |
| `CopyChip` | Mono text with a copy button; used for PNR, trace IDs, session IDs |
| `StatusDot` | `healthy`, `degraded`, `down`, `unknown`; optional pulse |

---

## 7. Accessibility requirements

Not optional — customers ask, and broken accessibility is visible in a screenshare.

- WCAG 2.1 AA contrast for all text and interactive elements. Verify `--v-brand-600` on white and `--v-accent-500` on white specifically; adjust the token rather than the usage if either fails.
- Full keyboard operability. Visible focus ring: `2px solid var(--v-brand-500)` with a `2px` offset. Never `outline: none` without a replacement.
- Semantic landmarks: `header`, `nav`, `main`, `footer`; a skip-to-content link.
- Every form input has an associated `<label>`; errors are linked with `aria-describedby` and announced via `aria-live="polite"`.
- Modals and drawers trap focus and restore it on close.
- Loading regions use `aria-busy`; results counts are announced.
- Icon-only buttons always have `aria-label`.
- All imagery has meaningful `alt` text, or `alt=""` when decorative.

---

## 8. Instrumentation hooks in markup

Add these as you build components. Retrofitting them in Phase 9 is slow and error-prone.

| Attribute | Purpose | Convention |
|---|---|---|
| `data-testid` | Playwright + Vitest selectors | `kebab-case`, structural: `flight-result-row`, `payment-submit` |
| `data-dd-action-name` | RUM action naming | Human-readable, stable, low-cardinality: `Select flight result`, `Submit payment`. **Never interpolate IDs or prices into it** — that destroys RUM aggregation. |
| `data-dd-privacy` | Session Replay masking | `mask` on all payment fields; `allow` on prices and PNRs that you *want* visible in replay |

Rules:
- One `data-dd-action-name` per meaningful interaction, on the outermost clickable element.
- Any variable detail goes into a RUM action *attribute* via `addAction`, never into the action name.
- Keep the total set of distinct action names under ~40.

---

## 9. Tailwind configuration

`tailwind.config.ts` extends rather than replaces, and reads every color from the CSS variables so themes swap with no class changes:

```ts
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        brand: { 50:'var(--v-brand-50)', /* …through 900 */ },
        accent: { /* … */ },
        neutral: { /* … */ },
        success: { /* … */ }, warning: { /* … */ },
        danger: { /* … */ },  info: { /* … */ },
        bg: 'var(--v-bg)',
        'bg-elevated': 'var(--v-bg-elevated)',
        'bg-sunken': 'var(--v-bg-sunken)',
        border: 'var(--v-border)',
        'border-strong': 'var(--v-border-strong)',
        fg: 'var(--v-text)',
        'fg-muted': 'var(--v-text-muted)',
      },
      fontFamily: {
        sans: ['"Inter var"','Inter','-apple-system','"Segoe UI"','Roboto','sans-serif'],
        mono: ['"JetBrains Mono"','"SF Mono"','ui-monospace','monospace'],
      },
      borderRadius: {
        sm:'var(--v-radius-sm)', md:'var(--v-radius-md)',
        lg:'var(--v-radius-lg)', xl:'var(--v-radius-xl)',
      },
      boxShadow: {
        xs:'var(--v-shadow-xs)', sm:'var(--v-shadow-sm)', md:'var(--v-shadow-md)',
        lg:'var(--v-shadow-lg)', xl:'var(--v-shadow-xl)',
      },
      transitionTimingFunction: { DEFAULT: 'var(--v-ease)' },
      maxWidth: { content: '1200px' },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
```

Use Tailwind utilities for layout and spacing. Use CSS variables for color. Do not introduce a second styling system — no CSS-in-JS, no component library with its own theme.

---

## 10. Asset strategy

- **Airline "logos"**: deterministically generated SVG monograms — two-letter code on a seeded color, per fictional airline. Generated at build time into `public/airlines/`.
- **Hotel imagery**: a seeded procedural generator producing layered gradients plus a simple geometric motif, at 3 sizes (`sm` 240×180, `md` 480×360, `lg` 960×720). The `frontend_heavy_assets` chaos flag serves `lg` everywhere and disables lazy loading, which reliably wrecks LCP.
- **Icons**: `lucide-react`, tree-shaken.
- **Fonts**: Google Fonts, `display=swap`, `preconnect` to `fonts.gstatic.com`, with a real fallback stack so a blocked font request doesn't shift layout.
- **No real brand marks, no stock photography, no third-party image hosts.** Everything renders from the repo.

---

## 11. Performance budget (chaos off)

These are demo-credibility numbers, and they also give the chaos flags something to visibly ruin.

| Metric | Budget |
|---|---|
| LCP (search results, `lg`) | < 2.0 s |
| INP | < 200 ms |
| CLS | < 0.05 |
| Initial JS (gzipped) | < 220 KB |
| Initial CSS (gzipped) | < 30 KB |
| Lighthouse performance | ≥ 85 |
| Time to first flight result rendered | < 1.5 s warm cache |

Techniques: route-level code splitting, `react-query` prefetch on result hover, `loading="lazy"` plus explicit `width`/`height` on every image, `content-visibility: auto` on off-screen result rows, and no layout-shifting skeleton-to-content swaps.

---

## 12. What not to do

- Don't use a purple-gradient hero. It reads as "AI demo app" and costs you credibility instantly.
- Don't use emoji as UI iconography (the deliberate exception: tool-call chips in the support chat, where they help).
- Don't animate anything over 320 ms. It looks slow, and it contaminates INP measurements.
- Don't put IDs, prices, or any variable text into `data-dd-action-name`.
- Don't reproduce any real airline's, hotel chain's, or OTA's branding, logo, wordmark, or distinctive visual design. All brands in Voyager are invented.
- Don't leave any state undesigned. During a chaos demo, the broken states are the demo.
