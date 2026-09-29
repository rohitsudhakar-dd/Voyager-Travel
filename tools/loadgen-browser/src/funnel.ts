/**
 * The conversion funnel from 06-USER-FLOWS.md § 8, which the load generator
 * is explicitly tuned to.
 *
 * These are cumulative session percentages, so the odds of carrying on from
 * one step to the next are the ratio of adjacent rows. Modelling it that way
 * rather than as seven independent coin flips is what makes the RUM funnel
 * widget on dashboard D5 read back the documented numbers instead of their
 * product.
 *
 * A demo funnel that converts at 90% tells the audience the app is fake. The
 * steepest drop is results to selection, and that is deliberate: it is the
 * step scenarios S1 and S8 visibly make worse, which is the entire reason the
 * funnel widget is on the dashboard.
 */

export type FunnelStep =
  | 'landed'
  | 'searched'
  | 'results'
  | 'selected'
  | 'review'
  | 'passengers'
  | 'payment'
  | 'confirmed';

export const FUNNEL: ReadonlyArray<{ step: FunnelStep; rate: number }> = [
  { step: 'landed', rate: 100 },
  { step: 'searched', rate: 72 },
  { step: 'results', rate: 70 },
  { step: 'selected', rate: 34 },
  { step: 'review', rate: 33 },
  { step: 'passengers', rate: 24 },
  { step: 'payment', rate: 19 },
  { step: 'confirmed', rate: 17 },
];

const RATE_BY_STEP = new Map(FUNNEL.map((entry) => [entry.step, entry.rate]));

/**
 * Whether a session that has reached `from` goes on to the next step. The
 * last step has nothing after it, so a session that reaches `confirmed` is
 * simply done.
 */
export function advancesFrom(from: FunnelStep): boolean {
  const index = FUNNEL.findIndex((entry) => entry.step === from);
  const next = FUNNEL[index + 1];
  if (!next) return false;
  return Math.random() < next.rate / FUNNEL[index].rate;
}

export function rateFor(step: FunnelStep): number {
  return RATE_BY_STEP.get(step) ?? 0;
}
