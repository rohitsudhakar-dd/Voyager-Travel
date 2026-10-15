import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminStatus,
  ChaosCatalog,
  ChaosFlag,
  ChaosUpdate,
  ChaosValue,
  LoadgenRequest,
  Scenario,
  ScenarioList,
} from '@voyager/shared-schemas';
import { request } from '../client';
import { endpoints } from '../endpoints';
import { queryKeys } from '../queryClient';

/**
 * Admin API -- 05-FUNCTIONALITY.md § 2.8. Every call carries
 * `X-Voyager-Admin`; without it the gateway answers 401 and says nothing else.
 */

const STATUS_POLL_MS = 5_000;

/**
 * The gateway describes each flag with `active`, `injection` and `options`,
 * and does not send `activeFlags`. The console was written against the
 * schema names, so a successful response crashed on `activeFlags.length`.
 */
export function normalizeChaosCatalog(body: unknown): ChaosCatalog {
  const raw = (body ?? {}) as {
    flags?: Array<Partial<ChaosFlag> & { active?: boolean; injection?: string; options?: string[] }>;
    activeFlags?: string[];
  };
  const flags: ChaosFlag[] = (raw.flags ?? []).map((flag) => ({
    name: String(flag.name ?? ''),
    group: flag.group ?? 'Meta',
    type: flag.type ?? 'string',
    default: (flag.default ?? '') as ChaosValue,
    value: (flag.value ?? flag.default ?? '') as ChaosValue,
    description: String(flag.description ?? flag.injection ?? ''),
    scenarios: Array.isArray(flag.scenarios) ? flag.scenarios : [],
    enumValues: flag.enumValues ?? flag.options,
    min: flag.min,
    max: flag.max,
    step: flag.step,
    unit: flag.unit,
  }));
  const activeFlags =
    raw.activeFlags ??
    (raw.flags ?? []).flatMap((flag) => (flag.active && flag.name ? [flag.name] : []));
  return { flags, activeFlags };
}

/** Scenarios arrive as `{ name, active: "S4" }`, not `{ title, active: true }`. */
export function normalizeScenarios(body: unknown): ScenarioList {
  const raw = (body ?? {}) as {
    scenarios?: Array<Partial<Scenario> & { name?: string; products?: string[]; requiresRestartToRecover?: boolean }>;
    active?: string | null;
    activeScenarioId?: string | null;
  };
  const activeScenarioId = raw.activeScenarioId ?? raw.active ?? null;
  const scenarios: Scenario[] = (raw.scenarios ?? []).map((scenario) => ({
    id: String(scenario.id ?? ''),
    title: String(scenario.title ?? scenario.name ?? scenario.id ?? ''),
    story: String(scenario.story ?? ''),
    flags: scenario.flags ?? {},
    blastRadius: String(
      scenario.blastRadius ?? (scenario.products ? scenario.products.join(', ') : ''),
    ),
    active: scenario.active === true || scenario.id === activeScenarioId,
    requiresRestartToRevert: Boolean(
      scenario.requiresRestartToRevert ?? scenario.requiresRestartToRecover,
    ),
  }));
  return { scenarios, activeScenarioId };
}

export function useChaosCatalog(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.chaos,
    queryFn: async ({ signal }) =>
      normalizeChaosCatalog(await request(endpoints.admin.chaos, { admin: true, signal })),
    enabled,
    // Long enough to be cheap, short enough that a change another operator
    // made shows up while you are talking.
    refetchInterval: 10_000,
  });
}

export function useUpdateChaos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: ChaosUpdate) =>
      request<ChaosCatalog>(endpoints.admin.chaos, { method: 'PUT', body: update, admin: true }),
    onSuccess: (catalog) => {
      queryClient.setQueryData(queryKeys.chaos, normalizeChaosCatalog(catalog));
      void queryClient.invalidateQueries({ queryKey: queryKeys.scenarios });
      void queryClient.invalidateQueries({ queryKey: queryKeys.frontendChaos });
    },
  });
}

export function useResetChaos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request<ChaosCatalog>(endpoints.admin.chaosReset, { method: 'POST', admin: true }),
    onSuccess: (catalog) => {
      queryClient.setQueryData(queryKeys.chaos, normalizeChaosCatalog(catalog));
      void queryClient.invalidateQueries({ queryKey: queryKeys.scenarios });
      void queryClient.invalidateQueries({ queryKey: queryKeys.frontendChaos });
    },
  });
}

export function useScenarios(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scenarios,
    queryFn: async ({ signal }) =>
      normalizeScenarios(await request(endpoints.admin.scenarios, { admin: true, signal })),
    enabled,
  });
}

export function useApplyScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scenarioId: string) =>
      request<ScenarioList>(endpoints.admin.scenarioApply(scenarioId), {
        method: 'POST',
        admin: true,
      }),
    onSuccess: () => {
      // Apply returns one scenario plus the chaos view, not the scenario list.
      void queryClient.invalidateQueries({ queryKey: queryKeys.scenarios });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chaos });
      void queryClient.invalidateQueries({ queryKey: queryKeys.frontendChaos });
    },
  });
}

export function useRevertScenario() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scenarioId: string) =>
      request<ScenarioList>(endpoints.admin.scenarioRevert(scenarioId), {
        method: 'POST',
        admin: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.scenarios });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chaos });
      void queryClient.invalidateQueries({ queryKey: queryKeys.frontendChaos });
    },
  });
}

export function useAdminStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.adminStatus,
    queryFn: ({ signal }) => request<AdminStatus>(endpoints.admin.status, { admin: true, signal }),
    enabled,
    refetchInterval: STATUS_POLL_MS,
  });
}

export function useSetLoadgen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoadgenRequest) =>
      request<AdminStatus>(endpoints.admin.loadgen, { method: 'POST', body, admin: true }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.adminStatus, status),
  });
}

export function useReseed() {
  return useMutation({
    mutationFn: () =>
      request<{ jobId: string }>(endpoints.admin.seedReset, { method: 'POST', admin: true }),
  });
}

/** Fakes a deploy for scenario S6 by overriding the reported DD_VERSION. */
export function useSetVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (version: string) =>
      request<{ version: string }>(endpoints.admin.version, {
        method: 'POST',
        body: { version },
        admin: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminStatus });
    },
  });
}
