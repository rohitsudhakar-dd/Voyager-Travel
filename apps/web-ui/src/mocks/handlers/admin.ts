import type { ChaosUpdate, LoadgenRequest } from '@voyager/shared-schemas';
import { HttpResponse, http } from 'msw';
import { SCENARIO_SEEDS, activeFlagNames, buildFlags, defaultValues } from '../fixtures/chaos';
import { buildStatus, nextId, resetChaos, setChaos, state } from '../fixtures/state';
import { delay, requestId, unauthorisedWithoutAdmin } from './shared';

const API = '/api/v1';

const VU_COUNTS = { off: 0, '1x': 20, '2x': 40, '5x': 100 } as const;

function catalog() {
  return {
    flags: buildFlags(state.chaos),
    activeFlags: activeFlagNames(state.chaos),
    requestId: requestId(),
  };
}

function scenarioList() {
  return {
    scenarios: SCENARIO_SEEDS.map((scenario) => ({
      ...scenario,
      active: Object.entries(scenario.flags).every(
        ([name, value]) => JSON.stringify(state.chaos[name]) === JSON.stringify(value),
      ),
    })),
    activeScenarioId: state.activeScenarioId,
  };
}

export const adminHandlers = [
  http.get(`${API}/admin/chaos`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(120);
    return HttpResponse.json(catalog());
  }),

  http.put(`${API}/admin/chaos`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    const body = (await request.json()) as ChaosUpdate;
    await delay(180);
    setChaos(body);
    return HttpResponse.json(catalog());
  }),

  http.post(`${API}/admin/chaos/reset`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(260);
    resetChaos();
    return HttpResponse.json(catalog());
  }),

  http.get(`${API}/admin/scenarios`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(120);
    return HttpResponse.json(scenarioList());
  }),

  http.post(`${API}/admin/scenarios/:id/apply`, async ({ params, request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(340);

    const scenario = SCENARIO_SEEDS.find((candidate) => candidate.id === String(params.id));
    if (scenario) {
      // Applying resets first, as documented in 05-FUNCTIONALITY.md § 2.8.
      resetChaos();
      setChaos(scenario.flags);
      state.activeScenarioId = scenario.id;
    }
    return HttpResponse.json(scenarioList());
  }),

  http.post(`${API}/admin/scenarios/:id/revert`, async ({ params, request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(280);

    const scenario = SCENARIO_SEEDS.find((candidate) => candidate.id === String(params.id));
    if (scenario) {
      const defaults = defaultValues();
      setChaos(
        Object.fromEntries(Object.keys(scenario.flags).map((name) => [name, defaults[name]])),
      );
      state.activeScenarioId = null;
    }
    return HttpResponse.json(scenarioList());
  }),

  http.get(`${API}/admin/status`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(140);
    return HttpResponse.json(buildStatus());
  }),

  http.post(`${API}/admin/loadgen`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    const body = (await request.json()) as LoadgenRequest;
    await delay(220);

    state.loadgen = {
      api: { ...body.api, vus: body.api.enabled ? VU_COUNTS[body.api.intensity] : 0 },
      browser: body.browser,
    };
    return HttpResponse.json(buildStatus());
  }),

  http.post(`${API}/admin/seed/reset`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    await delay(400);
    return HttpResponse.json({ jobId: nextId('job') });
  }),

  http.post(`${API}/admin/version`, async ({ request }) => {
    const denied = unauthorisedWithoutAdmin(request);
    if (denied) return denied;
    const body = (await request.json()) as { version: string };
    await delay(160);
    state.versionOverride = body.version;
    state.chaos.version_override = body.version;
    return HttpResponse.json({ version: body.version });
  }),
];
