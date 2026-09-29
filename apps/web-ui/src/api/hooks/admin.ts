import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminStatus,
  ChaosCatalog,
  ChaosUpdate,
  LoadgenRequest,
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

export function useChaosCatalog(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.chaos,
    queryFn: ({ signal }) => request<ChaosCatalog>(endpoints.admin.chaos, { admin: true, signal }),
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
      queryClient.setQueryData(queryKeys.chaos, catalog);
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
      queryClient.setQueryData(queryKeys.chaos, catalog);
      void queryClient.invalidateQueries({ queryKey: queryKeys.scenarios });
      void queryClient.invalidateQueries({ queryKey: queryKeys.frontendChaos });
    },
  });
}

export function useScenarios(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scenarios,
    queryFn: ({ signal }) =>
      request<ScenarioList>(endpoints.admin.scenarios, { admin: true, signal }),
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
    onSuccess: (list) => {
      queryClient.setQueryData(queryKeys.scenarios, list);
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
    onSuccess: (list) => {
      queryClient.setQueryData(queryKeys.scenarios, list);
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
