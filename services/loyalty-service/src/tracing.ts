/**
 * Span helpers.
 *
 * Separate from `tracer.ts`, which only initialises and must stay importable
 * before anything else. This file is ordinary application code and may import
 * freely.
 */

import tracer from 'dd-trace';

/**
 * Tags whichever span is currently active.
 *
 * Call this at the top of a route handler or a consumer handler, where the
 * active span is the one the integration created for the request or the
 * message. Called from inside a `span()` callback it would tag the child
 * instead, and a tag on a child is not a trace-level facet -- it can only be
 * found by someone who already knows which span to open.
 */
export function tag(tags: Record<string, string | number | boolean>): void {
  const active = tracer.scope().active();
  if (!active) return;
  for (const [key, value] of Object.entries(tags)) {
    active.setTag(key, value);
  }
}

/** Runs `fn` inside a named child span. */
export function span<T>(name: string, fn: () => T): T {
  return tracer.trace(name, fn);
}
