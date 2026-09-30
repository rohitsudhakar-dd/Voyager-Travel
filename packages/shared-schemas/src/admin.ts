import { z } from 'zod';

/**
 * Admin API -- 05-FUNCTIONALITY.md § 2.8.
 *
 * `GET /admin/chaos` is self-describing on purpose: the Ops console renders
 * whatever the gateway reports, and must never hardcode the flag list
 * (04-STYLING.md § 5.1).
 */

export const CHAOS_GROUPS = [
  'Third parties',
  'Database',
  'Cache',
  'Queue',
  'Compute',
  'Frontend',
  'LLM',
  'Meta',
] as const;

export const chaosGroupSchema = z.enum(CHAOS_GROUPS);
export type ChaosGroup = z.infer<typeof chaosGroupSchema>;

export const chaosFlagTypeSchema = z.enum(['bool', 'int', 'float', 'enum', 'string', 'map']);
export type ChaosFlagType = z.infer<typeof chaosFlagTypeSchema>;

export const chaosValueSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.record(z.union([z.number(), z.string()])),
]);
export type ChaosValue = z.infer<typeof chaosValueSchema>;

export const chaosFlagSchema = z.object({
  name: z.string(),
  group: chaosGroupSchema,
  type: chaosFlagTypeSchema,
  default: chaosValueSchema,
  value: chaosValueSchema,
  description: z.string(),
  scenarios: z.array(z.string()),
  enumValues: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
});
export type ChaosFlag = z.infer<typeof chaosFlagSchema>;

export const chaosCatalogSchema = z.object({
  flags: z.array(chaosFlagSchema),
  activeFlags: z.array(z.string()),
  requestId: z.string().optional(),
});
export type ChaosCatalog = z.infer<typeof chaosCatalogSchema>;

export const chaosUpdateSchema = z.record(chaosValueSchema);
export type ChaosUpdate = z.infer<typeof chaosUpdateSchema>;

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  story: z.string(),
  flags: z.record(chaosValueSchema),
  blastRadius: z.string(),
  active: z.boolean(),
  /** S7 is the documented exception that needs a single-service restart. */
  requiresRestartToRevert: z.boolean().optional(),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export const scenarioListSchema = z.object({
  scenarios: z.array(scenarioSchema),
  activeScenarioId: z.string().nullable(),
});
export type ScenarioList = z.infer<typeof scenarioListSchema>;

export const serviceHealthSchema = z.enum(['healthy', 'degraded', 'down', 'unknown']);
export type ServiceHealth = z.infer<typeof serviceHealthSchema>;

export const serviceStatusSchema = z.object({
  name: z.string(),
  health: serviceHealthSchema,
  p95Ms: z.number().nullable(),
  errorRate: z.number().nullable(),
  requestRate: z.number().nullable(),
  version: z.string().nullable(),
  checks: z.record(z.string()).optional(),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const loadgenStateSchema = z.object({
  api: z.object({ enabled: z.boolean(), intensity: z.enum(['off', '1x', '2x', '5x']), vus: z.number().int() }),
  browser: z.object({ enabled: z.boolean(), concurrency: z.number().int() }),
});
export type LoadgenState = z.infer<typeof loadgenStateSchema>;

export const adminStatusSchema = z.object({
  env: z.string(),
  version: z.string(),
  services: z.array(serviceStatusSchema),
  postgres: z.object({
    connections: z.number().int(),
    maxConnections: z.number().int(),
    health: serviceHealthSchema,
  }),
  redis: z.object({
    hitRatio: z.number(),
    usedMemoryBytes: z.number(),
    maxMemoryBytes: z.number(),
    evictedKeys: z.number().int(),
    health: serviceHealthSchema,
  }),
  kafka: z.object({
    consumerGroups: z.array(z.object({ group: z.string(), lag: z.number().int() })),
    health: serviceHealthSchema,
  }),
  loadgen: loadgenStateSchema,
  activeFlagCount: z.number().int(),
  requestId: z.string().optional(),
});
export type AdminStatus = z.infer<typeof adminStatusSchema>;

export const loadgenRequestSchema = z.object({
  api: z.object({ enabled: z.boolean(), intensity: z.enum(['off', '1x', '2x', '5x']) }),
  browser: z.object({ enabled: z.boolean(), concurrency: z.number().int().min(0).max(8) }),
});
export type LoadgenRequest = z.infer<typeof loadgenRequestSchema>;

export const seedResetResponseSchema = z.object({ jobId: z.string() });
export type SeedResetResponse = z.infer<typeof seedResetResponseSchema>;

export const versionOverrideRequestSchema = z.object({ version: z.string() });
export type VersionOverrideRequest = z.infer<typeof versionOverrideRequestSchema>;

/** The four flags the browser itself honours (05-FUNCTIONALITY.md § 11). */
export const FRONTEND_CHAOS_FLAGS = [
  'frontend_heavy_assets',
  'frontend_blocking_js',
  'frontend_js_error_rate',
  'frontend_layout_shift',
] as const;
export type FrontendChaosFlag = (typeof FRONTEND_CHAOS_FLAGS)[number];

/**
 * `GET /chaos/frontend` (05-FUNCTIONALITY.md § 2.9). Deliberately not the
 * self-describing `ChaosCatalog` shape: this response is unauthenticated, so it
 * carries values and nothing else -- no defaults, no injection points, and no
 * evidence that the other thirty-four flags exist.
 */
export const frontendChaosSchema = z.object({
  flags: z.object({
    frontend_heavy_assets: z.boolean(),
    frontend_blocking_js: z.boolean(),
    frontend_js_error_rate: z.number(),
    frontend_layout_shift: z.boolean(),
  }),
});
export type FrontendChaosResponse = z.infer<typeof frontendChaosSchema>;
