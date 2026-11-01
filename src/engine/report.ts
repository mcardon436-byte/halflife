import { maxLtvForTarget, riskAttribution, runScenarios, type Attribution, type ScenarioResult } from './analysis';
import { CUMULATIVE_EL_3Y } from './defaults';
import { projectedDscr, simulate } from './simulate';
import type { Deal, Hedges, Market, SimResult } from './types';

// Verdict thresholds. Losses and price drive the verdict; technical defaults that recover in full do not.
export const RESTRUCTURE_IF = { probLoss: 0.15, annualExpectedLoss: 0.03, riskAdjustedMargin: 0.01 };
export const APPROVE_IF = { probLoss: 0.03, annualExpectedLoss: 0.005, riskAdjustedMargin: 0.02, ltv: 0.85 };
// Max LTV target: expected loss under 1% a year (around BB on expected loss) and the loss odds above.
export const MAX_LTV_ANNUAL_EL = 0.01;

const RATING_ORDER = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'Below CCC'];

export type Verdict = 'approve' | 'conditions' | 'restructure';
const VERDICT_RANK: Record<Verdict, number> = { approve: 0, conditions: 1, restructure: 2 };
const VERDICT_NAME: Record<Verdict, string> = { approve: 'Approve', conditions: 'Approve with conditions', restructure: 'Restructure' };

export interface Coverage {
  contract: number; // lowest projected DSCR while the anchor contract runs, in the expected market
  tail: number | null; // lowest projected DSCR after expiry if the tenant does not renew (null: no tail)
  tailRenewed: number | null; // same, if the tenant renews at the spot price of the day
}

export interface Pricing {
  walYears: number;
  annualExpectedLoss: number; // EL / WAL
  spread: number; // coupon − cost of funds
  riskAdjustedMargin: number; // spread − annual EL
  breakEvenRate: number; // cost of funds + annual EL
  equivalentRating: string; // read off expected loss, never better than a rated tenant
  ratingCapped: boolean; // true when capped at the tenant's own rating
  probLossCi: number; // 95% half-width of the simulated loss probability
}

export interface Lever {
  label: string;
  detail: string;
  phrase: string; // how the memo names it, mid-sentence
  deal: Deal;
  hedges: Hedges;
  result: SimResult;
  coverage: Coverage;
  pricing: Pricing;
  verdict: Verdict;
  financeable: boolean; // projected DSCR during the contract at or above the sizing DSCR
  keepsLoanSize: boolean; // false for LTV cuts: they shrink the deal instead of fixing it
}

export interface Report {
  deal: Deal;
  base: SimResult;
  coverage: Coverage;
  pricing: Pricing;
  scenarios: ScenarioResult[];
  attribution: { expectedLoss: number; factors: Attribution[] };
  maxLtv: { ltv: number; binding: boolean; structure: string };
  levers: Lever[];
  bestLever: Lever | null;
  upgrade: Lever | null; // a smaller loan that reaches a better verdict than the recommended change
  verdict: Verdict;
  headline: string;
  memo: { heading: string; body: string[] }[];
}

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const usd = (x: number) => (Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
const oneIn = (p: number) =>
  p <= 0 ? 'none of the' : p < 0.005 ? 'fewer than 1 in 200' : p >= 0.3 ? `${Math.round(p * 10)} in 10` : `1 in ${Math.round(1 / p)}`;
// Lower-case the first letter for mid-sentence use, but leave acronyms such as "GPU" alone.
const midSentence = (t: string) => (/^[A-Z]{2}/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));
const ratingArticle = (r: string) => (r.startsWith('A') ? `an ${r}-rated` : `a ${r}-rated`);

export function closingCoverage(deal: Deal, mkt: Market, hedges: Hedges): Coverage {
  const C = Math.max(1, Math.min(deal.contractTenorMonths, deal.tenorMonths));
  const never = projectedDscr(deal, mkt, hedges, 'never');
  const minOf = (v: number[]) => (v.some(Number.isFinite) ? Math.min(...v.filter(Number.isFinite)) : null);
  const contract = minOf(never.slice(0, C)) ?? Infinity;
  if (deal.contractTenorMonths >= deal.tenorMonths || deal.contractTenorMonths <= 0) return { contract, tail: null, tailRenewed: null };
  const always = projectedDscr(deal, mkt, hedges, 'always');
  // A loan swept to zero before the contract ends has no tail to cover.
  return { contract, tail: minOf(never.slice(C)), tailRenewed: minOf(always.slice(C)) };
}

export function closingDscr(deal: Deal, mkt: Market, hedges: Hedges): number {
  return closingCoverage(deal, mkt, hedges).contract;
}

export function pricingFor(deal: Deal, r: SimResult): Pricing {
  const wal = Math.max(r.walYears, 1 / 12);
  const annualExpectedLoss = r.expectedLossPct / wal;
  const spread = deal.annualRate - deal.costOfFunds;
  // Rating agencies grade loss, so compare a three-year expected loss with the idealised table.
  const el3 = annualExpectedLoss * 3;
  let equivalentRating: string = CUMULATIVE_EL_3Y.find(([, v]) => el3 <= v)?.[0] ?? 'Below CCC';
  let ratingCapped = false;
  const tenant = deal.offtakerRating;
  if (deal.contractedShare > 0 && RATING_ORDER.includes(tenant) && RATING_ORDER.indexOf(equivalentRating) < RATING_ORDER.indexOf(tenant)) {
    // A loan repaid by one tenant's contract is not better than that tenant.
    equivalentRating = tenant;
    ratingCapped = true;
  }
  return {
    walYears: wal,
    annualExpectedLoss,
    spread,
    riskAdjustedMargin: spread - annualExpectedLoss,
    breakEvenRate: deal.costOfFunds + annualExpectedLoss,
    equivalentRating,
    ratingCapped,
    probLossCi: 1.96 * Math.sqrt((r.probLoss * (1 - r.probLoss)) / Math.max(1, r.sims)),
  };
}

export function verdictFor(deal: Deal, r: SimResult, raw: Pricing, cov: Coverage): Verdict {
  // Compare at basis-point precision so a 2.00% margin is not read as 1.9999…%.
  const bp = (x: number) => Math.round(x * 1e4) / 1e4;
  const p = { ...raw, annualExpectedLoss: bp(raw.annualExpectedLoss), riskAdjustedMargin: bp(raw.riskAdjustedMargin) };
  if (
    cov.contract < deal.dscrCovenant ||
    r.probLoss > RESTRUCTURE_IF.probLoss ||
    p.annualExpectedLoss > RESTRUCTURE_IF.annualExpectedLoss ||
    p.riskAdjustedMargin < RESTRUCTURE_IF.riskAdjustedMargin
  ) {
    return 'restructure';
  }
  if (
    r.probLoss <= APPROVE_IF.probLoss &&
    p.annualExpectedLoss <= APPROVE_IF.annualExpectedLoss &&
    p.riskAdjustedMargin >= APPROVE_IF.riskAdjustedMargin &&
    cov.contract >= deal.sizingDscr &&
    deal.ltv <= APPROVE_IF.ltv
  ) {
    return 'approve';
  }
  return 'conditions';
}

export function buildReport(deal: Deal, mkt: Market, hedges: Hedges, sims = 2000, seed = 2026): Report {
  const small = Math.max(300, Math.round(sims / 2));
  const base = simulate(deal, mkt, hedges, { sims, seed, keepMonthly: true });
  const scenarios = runScenarios(deal, mkt, hedges, sims, seed);
  const attribution = riskAttribution(deal, mkt, hedges, small, seed);

  const levers: Lever[] = [];
  const add = (label: string, detail: string, phrase: string, d: Deal, h: Hedges, result?: SimResult) => {
    const coverage = closingCoverage(d, mkt, h);
    const res = result ?? simulate(d, mkt, h, { sims, seed });
    const pricing = pricingFor(d, res);
    levers.push({
      label,
      detail,
      phrase,
      deal: d,
      hedges: h,
      result: res,
      coverage,
      pricing,
      verdict: verdictFor(d, res, pricing, coverage),
      financeable: coverage.contract >= d.sizingDscr,
      keepsLoanSize: d.ltv === deal.ltv,
    });
  };
  add('As structured', 'Current terms', 'the current terms', deal, hedges, base);
  const C = deal.contractTenorMonths;
  const hasTail = C < deal.tenorMonths && C > 0;
  const sweep = { ...deal, cashSweepPct: 1 };
  if (hasTail) {
    if (deal.frontAmortPct < 0.75) {
      add(
        'Front-load amortisation',
        `75% of principal repaid by month ${C}, the rest over the last ${deal.tenorMonths - C} months`,
        `front-loading amortisation so that 75% is repaid by month ${C}`,
        { ...deal, frontAmortPct: 0.75 },
        hedges,
      );
    }
    add('Match tenor to contract', `Tenor cut from ${deal.tenorMonths} to ${C} months`, `cutting the tenor to ${C} months`, { ...deal, tenorMonths: C }, hedges);
  }
  if (deal.cashSweepPct < 1) {
    add('100% cash sweep', 'All excess cash prepays the loan', 'a 100% cash sweep', sweep, hedges);
  }
  if (hedges.powerFixedShare < 0.8) {
    add('Fix 80% of power', `Forward at ${pct(hedges.powerFixedPremium, 0)} over today's price`, 'fixing 80% of the power price', deal, { ...hedges, powerFixedShare: 0.8 });
  }
  if (hedges.gpuPutShare < 0.5) {
    const h = { ...hedges, gpuPutShare: 0.5 };
    const r = simulate(deal, mkt, h, { sims, seed });
    add('GPU rental put on 50%', `Strike ${pct(hedges.gpuPutStrike, 0)} of spot, premium ${usd(r.gpuPutPremiumTotal)}`, 'a put on the GPU rental index for half the fleet', deal, h, r);
  }
  // Combinations: what a structurer would actually put in front of committee.
  if (hasTail && deal.frontAmortPct < 0.75 && deal.cashSweepPct < 1) {
    add(
      'Front-load + 100% sweep',
      `75% repaid by month ${C} and all excess cash prepays`,
      `front-loading 75% of amortisation into the contract with a 100% cash sweep`,
      { ...sweep, frontAmortPct: 0.75 },
      hedges,
    );
  }
  if (deal.ltv > 0.6 && deal.cashSweepPct < 1) {
    add('LTV 60% + 100% sweep', `Loan cut to 60% of cost, all excess cash prepays`, 'cutting the LTV to 60% with a 100% cash sweep', { ...sweep, ltv: 0.6 }, hedges);
  }

  // Recommend a financeable change that improves the verdict, or keeps the loan size and cuts the loss by
  // more than noise. Prefer changes that keep the loan size, then the best verdict, then the lowest loss.
  const ref = base.expectedLoss;
  const baseVerdict = levers[0].verdict;
  const candidates = levers
    .slice(1)
    .filter((l) => l.financeable)
    .filter(
      (l) =>
        VERDICT_RANK[l.verdict] < VERDICT_RANK[baseVerdict] ||
        (l.keepsLoanSize && ref - l.result.expectedLoss > Math.max(0.1 * ref, 1e-4 * base.principal)),
    );
  const byOutcome = (a: Lever, b: Lever) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.pricing.annualExpectedLoss - b.pricing.annualExpectedLoss;
  const bestLever = [...candidates].sort((a, b) => Number(b.keepsLoanSize) - Number(a.keepsLoanSize) || byOutcome(a, b))[0] ?? null;
  // A smaller loan may reach a better verdict still: name it as the alternative.
  const topOutcome = [...candidates].sort(byOutcome)[0];
  const upgrade = bestLever && topOutcome && VERDICT_RANK[topOutcome.verdict] < VERDICT_RANK[bestLever.verdict] ? topOutcome : null;

  // Highest LTV meeting the target, with the recommended structure in place.
  const sized = bestLever ? { deal: bestLever.deal, hedges: bestLever.hedges, name: bestLever.phrase } : { deal, hedges, name: 'the current terms' };
  const maxLtv = {
    ...maxLtvForTarget(
      sized.deal,
      mkt,
      sized.hedges,
      (d, r) => pricingFor(d, r).annualExpectedLoss <= MAX_LTV_ANNUAL_EL && r.probLoss <= RESTRUCTURE_IF.probLoss,
      small,
      seed,
    ),
    structure: sized.name,
  };

  const coverage = levers[0].coverage;
  const pricing = levers[0].pricing;
  const verdict = baseVerdict;
  const headline = writeHeadline(deal, base, verdict, bestLever);
  return {
    deal,
    base,
    coverage,
    pricing,
    scenarios,
    attribution,
    maxLtv,
    levers,
    bestLever,
    verdict,
    headline,
    upgrade,
    memo: writeMemo(deal, base, coverage, pricing, scenarios, attribution, maxLtv, levers, bestLever, upgrade, verdict),
  };
}

function writeHeadline(deal: Deal, base: SimResult, verdict: Verdict, best: Lever | null): string {
  let s = `This loan loses money in ${oneIn(base.probLoss)} simulated markets`;
  if (base.expectedLoss > 0) {
    if (deal.contractTenorMonths < deal.tenorMonths && base.lossAfterExpiryShare >= 0.5) {
      s += `, mostly after the anchor contract ends in month ${deal.contractTenorMonths}`;
    } else if (deal.contractedShare > 0 && base.lossAfterExpiryShare < 0.5) {
      s += ', mostly when the anchor tenant stops paying';
    }
  }
  s += '.';
  if (best) {
    const p = best.phrase;
    s += ` ${p.charAt(0).toUpperCase()}${p.slice(1)} brings that to ${best.result.probLoss <= 0 ? 'zero' : oneIn(best.result.probLoss)}`;
    s += best.verdict !== verdict ? ` and moves the verdict to ${VERDICT_NAME[best.verdict]}.` : '.';
  }
  return s;
}

function coverageText(deal: Deal, c: Coverage): string {
  let s = `Projected DSCR in the expected market: ${c.contract.toFixed(2)}x at its lowest during the contract`;
  if (c.tail !== null && c.tailRenewed !== null) {
    s += `; after month ${deal.contractTenorMonths}, ${c.tail.toFixed(2)}x if the tenant does not renew and ${c.tailRenewed.toFixed(2)}x if it renews at spot (base renewal odds ${pct(deal.renewalProbability, 0)})`;
  }
  return `${s}. The loan is sized on a minimum of ${deal.sizingDscr.toFixed(2)}x.`;
}

function writeMemo(
  deal: Deal,
  base: SimResult,
  coverage: Coverage,
  pricing: Pricing,
  scenarios: ScenarioResult[],
  attribution: { expectedLoss: number; factors: Attribution[] },
  maxLtv: { ltv: number; binding: boolean; structure: string },
  levers: Lever[],
  best: Lever | null,
  upgrade: Lever | null,
  verdict: Verdict,
): { heading: string; body: string[] }[] {
  const capex = deal.capexPerGpu * deal.gpuCount;
  const top = [...attribution.factors].sort((a, b) => b.share - a.share).filter((f) => f.share > 0.005);
  const worst = scenarios.reduce((a, b) => (b.result.expectedLoss > a.result.expectedLoss ? b : a));
  const verdictText = {
    approve: 'Approve as structured.',
    conditions: 'Approve subject to the structural conditions below.',
    restructure: 'Do not approve as structured; restructure before committee.',
  }[verdict];
  const tenant = deal.offtakerRating === 'Unrated AI startup' ? 'an unrated AI startup' : ratingArticle(deal.offtakerRating);

  const sections: { heading: string; body: string[] }[] = [
    {
      heading: 'Recommendation',
      body: [
        `${verdictText} The lender loses money in ${pct(base.probLoss)} of simulated markets (±${pct(pricing.probLossCi)}). Expected loss is ${pct(base.expectedLossPct, 2)} of principal (${usd(base.expectedLoss)}), or ${pct(pricing.annualExpectedLoss, 2)} a year over a ${pricing.walYears.toFixed(1)}-year average life: comparable to a ${pricing.equivalentRating} credit on expected loss${pricing.ratingCapped ? ', capped at the tenant’s rating' : ''}. Against a ${pct(pricing.spread, 1)} spread over funding, the risk-adjusted margin is ${pct(pricing.riskAdjustedMargin, 1)}.`,
        `Events of default occur in ${pct(base.probDefault)} of paths (missed payment ${pct(base.probPaymentDefault)}, covenant acceleration ${pct(base.probCovenantAcceleration)}); ${pct(base.fullRecoveryShare, 0)} of them are recovered in full. A further ${pct(base.probCure)} of paths breach the covenant but are cured with a full cash sweep and a ${pct(0.02, 0)} margin step-up, because the GPUs still cover the debt.`,
      ],
    },
    {
      heading: 'Transaction',
      body: [
        `${usd(base.principal)} senior loan (${pct(deal.ltv, 0)} LTV on ${usd(capex)} of capex) financing ${deal.gpuCount.toLocaleString('en-US')} GPUs. ${deal.tenorMonths}-month tenor at ${pct(deal.annualRate)}, ${deal.frontAmortPct > 0 ? `${pct(deal.frontAmortPct, 0)} of principal repaid during the anchor contract` : 'straight-line amortisation'}${deal.balloonPct > 0 ? `, ${pct(deal.balloonPct, 0)} balloon` : ''}${deal.cashSweepPct > 0 ? `, ${pct(deal.cashSweepPct, 0)} cash sweep` : ''}. ${deal.reserveMonths}-month debt service reserve funded by the sponsor. Cash lock-up below ${deal.lockupDscr.toFixed(2)}x DSCR; event of default below ${deal.dscrCovenant.toFixed(2)}x at two consecutive quarterly tests, unless the collateral covers the debt.`,
        `Anchor offtake: ${pct(deal.contractedShare, 0)} of capacity at $${deal.contractPrice.toFixed(2)}/GPU-hour for ${deal.contractTenorMonths} months with ${tenant} counterparty. ${coverageText(deal, coverage)}`,
      ],
    },
  ];

  const risk: string[] = [];
  if (deal.tenorMonths > deal.contractTenorMonths && base.defaultMonths.length > 0) {
    risk.push(
      `Renewal cliff: the anchor contract ends in month ${deal.contractTenorMonths}, ${deal.tenorMonths - deal.contractTenorMonths} months before maturity. ${pct(base.defaultsAfterExpiryShare, 0)} of defaults happen after that date, when capacity is re-let at the spot price of the day, but they carry ${pct(base.lossAfterExpiryShare, 0)} of the loss: by then the loan has amortised and the GPUs often still cover it.`,
    );
  }
  if (top.length) {
    risk.push(`Expected loss by source (Shapley, adds up to 100%): ${top.map((f) => `${midSentence(f.factor)} ${pct(f.share, 0)}`).join(', ')}.`);
  }
  risk.push(
    `Cash is trapped at least once in ${pct(base.probLockup)} of paths. Recovery assumes a ${deal.liquidationMonths}-month workout collecting half of the operating cash flow, ${pct(deal.workoutCostPct, 0)} costs and a ${pct(deal.liquidationHaircut, 0)} forced-sale discount that widens when prices have fallen, discounted at the loan rate.`,
  );
  risk.push(`Worst named scenario: ${midSentence(worst.label)} — expected loss ${pct(worst.result.expectedLossPct, 2)}, loss probability ${pct(worst.result.probLoss)}.`);
  sections.push({ heading: 'Key risks', body: risk });

  const cond: string[] = [];
  if (best) {
    cond.push(
      `Recommended structure: ${best.phrase}. Loss probability ${pct(base.probLoss)} → ${pct(best.result.probLoss)}, expected loss ${pct(pricing.annualExpectedLoss, 2)} → ${pct(best.pricing.annualExpectedLoss, 2)} a year, risk-adjusted margin ${pct(best.pricing.riskAdjustedMargin, 1)}, projected DSCR ${best.coverage.contract.toFixed(2)}x during the contract. Verdict with this change: ${VERDICT_NAME[best.verdict]}.`,
    );
    if (upgrade) {
      cond.push(
        `To reach ${VERDICT_NAME[upgrade.verdict]}: ${upgrade.phrase} (loss probability ${pct(upgrade.result.probLoss)}, expected loss ${pct(upgrade.pricing.annualExpectedLoss, 2)} a year, ${upgrade.pricing.equivalentRating} equivalent${upgrade.pricing.ratingCapped ? ', capped at the tenant’s rating' : ''}).`,
      );
    }
  } else if (verdict !== 'approve') {
    cond.push('None of the tested changes both passes the sizing DSCR and improves the outcome; renegotiate the contract term or price.');
  }
  cond.push(
    maxLtv.binding
      ? `Highest LTV keeping expected loss under ${pct(MAX_LTV_ANNUAL_EL, 0)} a year with ${maxLtv.structure}: ${pct(maxLtv.ltv, 0)}.`
      : `Expected loss stays under ${pct(MAX_LTV_ANNUAL_EL, 0)} a year up to ${pct(maxLtv.ltv, 0)} LTV with ${maxLtv.structure}; leverage is not the binding constraint.`,
  );
  const unfinanceable = levers.filter((l) => !l.financeable && l.label !== 'As structured');
  if (unfinanceable.length) {
    cond.push(
      `Not financeable as tested: ${unfinanceable.map((l) => `${l.phrase} (DSCR ${l.coverage.contract.toFixed(2)}x, below the ${deal.sizingDscr.toFixed(2)}x sizing minimum)`).join('; ')}.`,
    );
  }
  sections.push({ heading: 'Structuring', body: cond });
  sections.push({
    heading: 'Model notes',
    body: [
      'Monthly Monte Carlo with common random numbers across scenarios. Correlated GPU rental and power price paths, new-generation shocks, tenant default that rises when the contract is above market, renewal at spot that is likelier in a tight market, merchant utilisation linked to price, residual value tied to age and rental price, quarterly covenant tests with cash lock-up and cure. The equivalent rating compares a three-year expected loss with an approximate idealised expected-loss table. Market parameters are illustrative and anchored on public 2026 indices; calibrate before use.',
    ],
  });
  return sections;
}
