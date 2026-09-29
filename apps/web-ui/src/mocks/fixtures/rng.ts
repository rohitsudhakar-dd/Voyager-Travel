/**
 * Deterministic pseudo-randomness, so a given search id always produces the
 * same results and a screenshot is reproducible.
 */
export function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface Rng {
  next: () => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  some: <T>(items: readonly T[], count: number) => T[];
  chance: (probability: number) => boolean;
}

export function rngFrom(seed: string | number): Rng {
  let state = (typeof seed === 'number' ? seed : seedFrom(seed)) || 1;

  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick: (items) => items[int(0, items.length - 1)],
    some: (items, count) => {
      const pool = [...items];
      const taken: typeof pool = [];
      while (taken.length < Math.min(count, items.length)) {
        taken.push(pool.splice(int(0, pool.length - 1), 1)[0]);
      }
      return taken;
    },
    chance: (probability) => next() < probability,
  };
}
