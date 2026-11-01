import { describe, expect, it } from 'vitest';
import { maxLtvForTarget, riskAttribution, runScenarios } from './analysis';
import { DEFAULT_DEAL, DEFAULT_MARKET, NO_HEDGES } from './defaults';
import { buildReport, closingCoverage, closingDscr, pricingFor } from './report';
import { principalSchedule, scheduledDebtService, simulate } from './simulate';
import type { Overrides } from './types';

const FROZEN: Overrides = { freezeGpu: true, freezePower: true, freezeUtil: true, noOfftakerDefault: true };
const opt = { sims: 400, seed: 7 };
const D = DEFAULT_DEAL;
const M = DEFAULT_MARKET;
const H = NO_HEDGES;

describe('debt schedule', () => {
  it('amortises the full principal with no balloon', () => {
    const P = D.capexPerGpu * D.gpuCount * D.ltv;
    expect(principalSchedule(D).reduce((a, b) => a + b, 0)).toBeCloseTo(P, 2);
    const ds = scheduledDebtService(D);
    expect(ds[0]).toBeGreaterThan(ds[ds.length - 1]);
  });

  it('front-loads the requested share into the contract period', () => {
    const P = D.capexPerGpu * D.gpuCount * D.ltv;
    const s = principalSchedule({ ...D, frontAmortPct: 0.75 });
    expect(s.slice(0, D.contractTenorMonths).reduce((a, b) => a + b, 0)).toBeCloseTo(0.75 * P, 2);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(P, 2);
  });
});

describe('simulate', () => {
  it('is reproducible for a given seed', () => {
    const a = simulate(D, M, H, opt);
    const b = simulate(D, M, H, opt);
    expect(a.expectedLoss).toBe(b.expectedLoss);
  });

  it('keeps PD × LGD × EAD = EL', () => {
    const r = simulate(D, M, H, opt);
    expect(r.probDefault * r.lossGivenDefaultPct * r.exposureAtDefaultPct).toBeCloseTo(r.expectedLossPct, 10);
  });

  it('has no defaults for a conservative deal in a frozen market', () => {
    const r = simulate({ ...D, ltv: 0.3 }, M, H, { ...opt, overrides: FROZEN });
    expect(r.probDefault).toBe(0);
  });

  it('matches a hand computation of month-1 DSCR in a frozen market', () => {
    const r = simulate(D, M, H, { sims: 1, seed: 1, overrides: FROZEN, keepMonthly: true });
    const spot = Math.exp(Math.log(M.gpuSpot0) - M.gpuDriftPerYear / 12);
    const util = M.merchantUtil + M.utilPriceBeta * (Math.log(spot) - Math.log(M.gpuSpot0));
    const revenue = D.gpuCount * 730 * (D.contractedShare * D.contractPrice + (1 - D.contractedShare) * util * spot);
    const load = D.contractedShare * 0.9 + (1 - D.contractedShare) * util;
    const energy = ((D.gpuCount * D.kwPerGpu * D.pue * 730) / 1000) * (load + D.idleLoadShare * (1 - load));
    const cfads = revenue - energy * M.power0 - D.gpuCount * D.opexPerGpuMonth;
    expect(r.dscrQuantiles![0].p50).toBeCloseTo(cfads / scheduledDebtService(D)[0], 6);
  });

  it('uses common random numbers: a bigger reserve never hurts any path', () => {
    const a = simulate({ ...D, reserveMonths: 3 }, M, H, opt);
    const b = simulate({ ...D, reserveMonths: 6 }, M, H, opt);
    expect(b.probDefault).toBeLessThanOrEqual(a.probDefault);
    expect(b.expectedLoss).toBeLessThanOrEqual(a.expectedLoss + 1e-6);
  });

  it('loses more when leverage goes up', () => {
    const low = simulate({ ...D, ltv: 0.5 }, M, H, opt);
    const high = simulate({ ...D, ltv: 0.85 }, M, H, opt);
    expect(high.expectedLossPct).toBeGreaterThan(low.expectedLossPct);
  });

  it('a tighter covenant makes the lender act earlier', () => {
    const loose = simulate({ ...D, dscrCovenant: 0.8 }, M, H, opt);
    const tight = simulate({ ...D, dscrCovenant: 1.15 }, M, H, opt);
    expect(tight.covenantDefaultShare).toBeGreaterThan(loose.covenantDefaultShare);
    expect(tight.expectedLoss).not.toBe(loose.expectedLoss);
  });

  it('an above-market contract raises tenant default risk', () => {
    const fair = simulate(D, M, H, { ...opt, overrides: { freezeGpu: true, freezePower: true, freezeUtil: true } });
    const rich = simulate({ ...D, contractPrice: 5 }, M, H, { ...opt, overrides: { freezeGpu: true, freezePower: true, freezeUtil: true } });
    expect(rich.probDefault).not.toBe(fair.probDefault);
  });

  it('renewal probability changes the loss', () => {
    const never = simulate({ ...D, renewalProbability: 0 }, M, H, opt);
    const always = simulate({ ...D, renewalProbability: 1 }, M, H, opt);
    expect(always.expectedLoss).toBeLessThan(never.expectedLoss);
  });

  it('loss given default reflects the forced-sale haircut', () => {
    const soft = simulate({ ...D, liquidationHaircut: 0.1 }, M, H, opt);
    const hard = simulate({ ...D, liquidationHaircut: 0.5 }, M, H, opt);
    expect(hard.lossGivenDefaultPct).toBeGreaterThan(soft.lossGivenDefaultPct);
  });

  it('handles zero power price without NaN', () => {
    const r = simulate(D, { ...M, power0: 0 }, H, { ...opt, keepMonthly: true });
    expect(r.dscrQuantiles!.every((q) => Number.isFinite(q.p50))).toBe(true);
    expect(r.probDefault).toBeLessThanOrEqual(simulate(D, M, H, opt).probDefault);
  });

  it('a GPU put has a positive premium and cuts losses in a glut', () => {
    const glut: Overrides = { gpuShock: { month: 6, logSize: Math.log(0.6) } };
    const open = simulate(D, M, H, { ...opt, overrides: glut });
    const hedged = simulate(D, M, { ...H, gpuPutShare: 1 }, { ...opt, overrides: glut });
    expect(hedged.gpuPutPremiumTotal).toBeGreaterThan(0);
    expect(hedged.expectedLoss).toBeLessThan(open.expectedLoss);
  });
});

describe('analysis', () => {
  it('the combined scenario is the worst', () => {
    const sc = runScenarios(D, M, H, 300, 3);
    const el = Object.fromEntries(sc.map((s) => [s.key, s.result.expectedLoss]));
    for (const k of ['base', 'glut', 'power', 'offtaker']) expect(el.combined).toBeGreaterThanOrEqual(el[k]);
  });

  it('attribution, including the structural share and renewal, covers 100% of expected loss', () => {
    const a = riskAttribution(D, M, H, 300, 3);
    expect(a.factors.map((f) => f.factor)).toContain('Renewal at expiry');
    expect(a.factors.reduce((s, f) => s + f.share, 0)).toBeCloseTo(1, 6);
    expect(a.expectedLoss).toBeCloseTo(simulate(D, M, H, { sims: 300, seed: 3 }).expectedLoss, 6);
  });

  it('max LTV meets its target and the cap', () => {
    const passes = (d: typeof D, r: ReturnType<typeof simulate>) => pricingFor(d, r).annualExpectedLoss <= 0.01;
    const m = maxLtvForTarget(D, M, H, passes, 300, 3);
    expect(m.ltv).toBeLessThanOrEqual(0.8);
    if (m.binding) {
      const d = { ...D, ltv: m.ltv };
      expect(passes(d, simulate(d, M, H, { sims: 300, seed: 3 }))).toBe(true);
    }
  });

  it('only recommends a lever that meets the sizing DSCR', () => {
    const r = buildReport(D, M, H, 400, 5);
    if (r.bestLever) expect(r.bestLever.coverage.contract).toBeGreaterThanOrEqual(D.sizingDscr);
    for (const l of r.levers) expect(l.financeable).toBe(l.coverage.contract >= D.sizingDscr);
  });

  it('finds a structure that improves the verdict on the neocloud deal', () => {
    const r = buildReport(D, M, H, 600, 5);
    expect(r.verdict).toBe('restructure');
    expect(r.bestLever).not.toBeNull();
    expect(r.bestLever!.keepsLoanSize).toBe(true);
    expect(['approve', 'conditions']).toContain(r.bestLever!.verdict);
  });

  it('a BBB tenant never gives a rating below B, and no loan beats its rated tenant', () => {
    const bbb = buildReport({ ...D, offtakerRating: 'BBB' }, M, H, 600, 5);
    expect(['AAA', 'AA', 'A', 'BBB', 'BB', 'B']).toContain(bbb.pricing.equivalentRating);
    const aa = buildReport({ ...D, offtakerRating: 'AA', contractTenorMonths: 36 }, M, H, 400, 5);
    expect(aa.pricing.equivalentRating).not.toBe('AAA');
  });

  it('projected DSCR is deterministic and shows the tail without renewal', () => {
    const a = closingCoverage(D, M, H);
    expect(closingCoverage(D, M, H)).toEqual(a);
    expect(a.tail).not.toBeNull();
    expect(a.tail!).toBeLessThan(a.tailRenewed!);
    expect(a.tail!).toBeLessThan(a.contract);
  });

  it('a covenant breach the collateral covers is cured, not liquidated', () => {
    const r = simulate({ ...D, ltv: 0.4 }, M, H, opt);
    expect(r.probCure).toBeGreaterThan(0);
    expect(r.probCovenantAcceleration).toBeLessThan(r.probCure);
  });

  it('a longer workout loses more', () => {
    const quick = simulate({ ...D, liquidationMonths: 0 }, M, H, opt);
    const slow = simulate({ ...D, liquidationMonths: 18 }, M, H, opt);
    expect(slow.expectedLoss).toBeGreaterThan(quick.expectedLoss);
  });

  it('does not approve a deal whose closing DSCR is under the covenant', () => {
    const deal = { ...D, ltv: 0.95, tenorMonths: 18, contractTenorMonths: 18 };
    expect(closingDscr(deal, M, H)).toBeLessThan(deal.dscrCovenant);
    expect(buildReport(deal, M, H, 300, 5).verdict).toBe('restructure');
  });
});
