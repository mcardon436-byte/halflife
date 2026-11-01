import { simulate } from './simulate';
import type { Deal, Hedges, Market, Overrides, SimResult } from './types';

export interface ScenarioResult {
  key: string;
  label: string;
  description: string;
  result: SimResult;
}

export function stressScenarios(deal: Deal): { key: string; label: string; description: string; overrides: Overrides }[] {
  const shockMonth = Math.max(1, Math.min(deal.tenorMonths, 6));
  const tenantMonth = Math.max(1, Math.round(deal.contractTenorMonths / 2));
  return [
    { key: 'base', label: 'Base case', description: 'Simulated market, no imposed shock.', overrides: {} },
    {
      key: 'glut',
      label: 'Next-gen glut',
      description: `GPU rental prices drop 40% in month ${shockMonth} as a new generation floods the market.`,
      overrides: { gpuShock: { month: shockMonth, logSize: Math.log(0.6) } },
    },
    {
      key: 'power',
      label: 'Power squeeze',
      description: 'Wholesale power doubles for six months, as in a PJM-style summer.',
      overrides: { powerMultiplier: { from: 7, to: 12, factor: 2 } },
    },
    {
      key: 'offtaker',
      label: 'Tenant default',
      description: `The anchor tenant stops paying in month ${tenantMonth}, halfway through its contract.`,
      overrides: { forceOfftakerDefaultMonth: tenantMonth },
    },
    {
      key: 'combined',
      label: 'Combined',
      description: 'Glut, tenant default and power squeeze together: the correlated downside.',
      overrides: {
        gpuShock: { month: shockMonth, logSize: Math.log(0.6) },
        powerMultiplier: { from: 7, to: 12, factor: 2 },
        forceOfftakerDefaultMonth: tenantMonth,
      },
    },
  ];
}

export function runScenarios(deal: Deal, mkt: Market, hedges: Hedges, sims: number, seed: number): ScenarioResult[] {
  return stressScenarios(deal).map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    result: simulate(deal, mkt, hedges, { sims, seed, overrides: s.overrides }),
  }));
}

export interface Attribution {
  factor: string;
  share: number; // share of total expected loss; factors plus the structural share sum to 1
}

export const STRUCTURE_FACTOR = 'Structure, expected market';

const FACTORS: [string, keyof Overrides][] = [
  ['GPU rental price', 'freezeGpu'],
  ['Tenant credit', 'noOfftakerDefault'],
  ['Renewal at expiry', 'freezeRenewal'],
  ['Power price', 'freezePower'],
  ['Utilisation', 'freezeUtil'],
];

/**
 * Shapley decomposition of expected loss across the five risk factors: each factor's average marginal
 * contribution over every order of switching factors on. The loss left when every factor is frozen at
 * its expected value is the structure's own loss, shown as its own share, so the shares cover 100% of EL.
 */
export function riskAttribution(deal: Deal, mkt: Market, hedges: Hedges, sims: number, seed: number): {
  expectedLoss: number;
  factors: Attribution[];
} {
  const n = FACTORS.length;
  const el = new Map<number, number>();
  for (let mask = 0; mask < 1 << n; mask++) {
    // Bit set = factor is live (random); unset = frozen.
    const overrides: Overrides = {};
    FACTORS.forEach(([, key], i) => {
      if (!(mask & (1 << i))) (overrides as Record<string, boolean>)[key] = true;
    });
    el.set(mask, simulate(deal, mkt, hedges, { sims, seed, overrides }).expectedLoss);
  }
  const fact = (k: number): number => (k <= 1 ? 1 : k * fact(k - 1));
  const raw = FACTORS.map((_, i) => {
    let phi = 0;
    for (let mask = 0; mask < 1 << n; mask++) {
      if (mask & (1 << i)) continue;
      const size = [...Array(n).keys()].filter((j) => mask & (1 << j)).length;
      const w = (fact(size) * fact(n - size - 1)) / fact(n);
      phi += w * (el.get(mask | (1 << i))! - el.get(mask)!);
    }
    return phi;
  });
  const total = el.get((1 << n) - 1)!;
  const structural = el.get(0)!;
  const share = (x: number) => (total > 1e-9 ? x / total : 0);
  return {
    expectedLoss: total,
    factors: [...FACTORS.map(([factor], i) => ({ factor, share: share(raw[i]) })), { factor: STRUCTURE_FACTOR, share: share(structural) }],
  };
}

export const MAX_LTV_CAP = 0.8;

/**
 * Highest LTV (step 1%, capped) at which the deal still meets the target (expected loss a year, loss odds).
 * The pass test is supplied by the caller so the target matches the verdict's own criteria.
 */
export function maxLtvForTarget(
  deal: Deal,
  mkt: Market,
  hedges: Hedges,
  passes: (d: Deal, r: SimResult) => boolean,
  sims: number,
  seed: number,
): { ltv: number; binding: boolean } {
  let lo = 0.2;
  let hi = MAX_LTV_CAP;
  const ok = (ltv: number) => {
    const d = { ...deal, ltv };
    return passes(d, simulate(d, mkt, hedges, { sims, seed }));
  };
  if (ok(hi)) return { ltv: hi, binding: false };
  if (!ok(lo)) return { ltv: lo, binding: true };
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  // Simulated losses are not perfectly monotone in LTV, so step down until the rounded value passes.
  let best = Math.floor(lo * 100) / 100;
  while (best > 0.2 && !ok(best)) best = Math.round((best - 0.01) * 100) / 100;
  return { ltv: best, binding: true };
}
