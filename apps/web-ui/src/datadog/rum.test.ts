import { describe, expect, it } from 'vitest';
import { VIEW_ROUTES, viewNameFor } from './rum';

describe('RUM view names', () => {
  it('covers every route in 06-USER-FLOWS.md § 2', () => {
    expect(new Set(VIEW_ROUTES.map((route) => route.view))).toEqual(
      new Set([
        '/home',
        '/search/flights',
        '/search/hotels',
        '/results/flights',
        '/results/hotels',
        '/detail',
        '/checkout/review',
        '/checkout/passengers',
        '/checkout/payment',
        '/confirmation',
        '/manage',
        '/manage/detail',
        '/account',
        '/login',
        '/signup',
        '/admin',
      ]),
    );
  });

  it('names the pattern, never the instantiated path', () => {
    expect(viewNameFor('/results/flights/srch_01J8XYZ')).toBe('/results/flights');
    expect(viewNameFor('/detail/srch_01J8XYZ/res_44')).toBe('/detail');
    expect(viewNameFor('/checkout/1f0c4e2a-0000-4000-8000-000000000000/payment')).toBe(
      '/checkout/payment',
    );
    expect(viewNameFor('/confirmation/1f0c4e2a-0000-4000-8000-000000000000')).toBe(
      '/confirmation',
    );
  });

  it('does not let /manage/:pnr shadow /manage', () => {
    expect(viewNameFor('/manage')).toBe('/manage');
    expect(viewNameFor('/manage/K8M2QR')).toBe('/manage/detail');
  });

  it('returns null for a path with no screen, so the caller decides', () => {
    expect(viewNameFor('/nonsense/deep/path')).toBeNull();
  });

  it('never emits a view name carrying an id', () => {
    const paths = [
      '/',
      '/results/hotels/srch_9',
      '/detail/srch_9/res_1',
      '/checkout/abc/review',
      '/checkout/abc/passengers',
      '/manage/K8M2QR',
      '/confirmation/abc',
    ];
    for (const path of paths) {
      const view = viewNameFor(path);
      expect(view).not.toBeNull();
      expect(VIEW_ROUTES.some((route) => route.view === view)).toBe(true);
    }
  });
});
