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
 * Called from a Fastify hook or a route handler the active span is the one
 * dd-trace created for the request, which is this service's local root and
 * therefore the only place a tag becomes a trace-level facet. Called from
 * inside a custom child span it would tag the child instead, where nothing
 * can find it.
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
