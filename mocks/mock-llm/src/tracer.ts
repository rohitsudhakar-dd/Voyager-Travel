/**
 * Tracer initialisation.
 *
 * This file must run before anything else in the process. `dd-trace` works by
 * patching modules as they are required, so `fastify`, `pg` and `ioredis` all
 * have to load *after* it -- which is why the Dockerfile starts the process
 * with `node --require ./dist/tracer.js` rather than importing this from
 * `server.ts`. An import there would still be hoisted below Fastify's, and
 * the only symptom would be a service reporting no HTTP spans at all while
 * looking otherwise healthy.
 *
 * Almost everything is configured from the environment, by the
 * `x-datadog-env` Compose anchor. What appears here is the handful of
 * settings that have no environment equivalent.
 */

import tracer from 'dd-trace';

const service = process.env.DD_SERVICE ?? 'voyager';

tracer.init({
  logInjection: true,
  runtimeMetrics: true,
});

// This mock holds no database of its own; the only client worth naming is
// Redis, which it reads the chaos hash from.
tracer.use('ioredis', { service: `${service}-redis` });

// Without this, every distinct upstream hostname becomes its own node in the
// Service Map, so the gateway appears to depend on eight databases-of-one
// rather than on eight services.
tracer.use('http', { splitByDomain: false });

export default tracer;
