import { describe, expect, it } from 'vitest';
import { CHAOS_OFF, runBlockingTask, stateFromValues } from './frontendChaos';

describe('frontend chaos state', () => {
  it('fails open when the flag store says nothing', () => {
    expect(stateFromValues({})).toEqual(CHAOS_OFF);
  });

  it('reads the four documented flags, tolerating string values', () => {
    expect(
      stateFromValues({
        frontend_heavy_assets: 'true',
        frontend_blocking_js: true,
        frontend_js_error_rate: '0.4',
        frontend_layout_shift: 1,
      }),
    ).toEqual({ heavyAssets: true, blockingJs: true, jsErrorRate: 0.4, layoutShift: true });
  });

  it('clamps an out-of-range error rate rather than throwing', () => {
    expect(stateFromValues({ frontend_js_error_rate: 9 }).jsErrorRate).toBe(1);
    expect(stateFromValues({ frontend_js_error_rate: -2 }).jsErrorRate).toBe(0);
    expect(stateFromValues({ frontend_js_error_rate: 'nonsense' }).jsErrorRate).toBe(0);
  });

  it('does real work rather than busy-waiting', () => {
    const started = performance.now();
    const sink = runBlockingTask(40);

    expect(sink).toBeGreaterThan(0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
  });
});
