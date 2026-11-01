import { ANNUAL_PD } from './defaults';
import { Rng } from './rng';
import type { Deal, Hedges, Market, SimOptions, SimResult } from './types';

const HOURS = 730;
const DT = 1 / 12;
const WORKOUT_CASH_SHARE = 0.5; // share of operating cash flow the lender still collects during a workout
const CURE_STEP_UP = 0.02; // margin step-up agreed when a covenant breach is cured with a full sweep

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Scheduled principal per month: straight-line, or front-loaded into the anchor contract's life. */
export function principalSchedule(deal: Deal): number[] {
  const T = deal.tenorMonths;
  const P = deal.capexPerGpu * deal.gpuCount * deal.ltv;
  const amortisable = P * (1 - deal.balloonPct);
  const C = Math.min(deal.contractTenorMonths, T);
  const out: number[] = [];
  if (deal.frontAmortPct > 0 && C > 0 && C < T) {
    const front = Math.min(amortisable, P * deal.frontAmortPct);
    for (let t = 1; t <= T; t++) out.push(t <= C ? front / C : (amortisable - front) / (T - C));
  } else {
    for (let t = 1; t <= T; t++) out.push(amortisable / T);
  }
  return out;
}

export function scheduledDebtService(deal: Deal): number[] {
  let bal = deal.capexPerGpu * deal.gpuCount * deal.ltv;
  return principalSchedule(deal).map((p) => {
    const ds = bal * (deal.annualRate / 12) + p;
    bal -= p;
    return ds;
  });
}

export function weightedAverageLife(deal: Deal): number {
  const P = deal.capexPerGpu * deal.gpuCount * deal.ltv;
  if (P <= 0) return 0;
  const sched = principalSchedule(deal);
  const amort = sched.reduce((a, p, i) => a + p * ((i + 1) / 12), 0);
  return (amort + P * deal.balloonPct * (deal.tenorMonths / 12)) / P;
}

function pathSeed(seed: number, s: number): number {
  let h = (seed ^ Math.imul(s + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

export function simulate(deal: Deal, mkt: Market, hedges: Hedges, opt: SimOptions): SimResult {
  const T = deal.tenorMonths;
  const L = Math.max(0, Math.round(deal.liquidationMonths));
  const TT = T + L; // factor paths extend past maturity to cover a workout that starts late
  const S = opt.sims;
  const o = opt.overrides ?? {};
  const N = deal.gpuCount;
  const C = deal.contractTenorMonths;

  const x0 = Math.log(mkt.gpuSpot0);
  const powerOn = mkt.power0 > 0;
  const y0 = Math.log(Math.max(mkt.power0, 1e-9));
  const rho = mkt.powerGpuCorrelation;
  const shockProb = 1 - Math.pow(1 - mkt.genShockProbPerYear, DT);
  const expectedLog = new Float64Array(TT);
  for (let t = 0; t < TT; t++) expectedLog[t] = x0 - (mkt.gpuDriftPerYear * (t + 1)) / 12;

  // ---- Pass 1: market paths. One RNG per path with a fixed number of draws per month, so every
  // deal variant, scenario and attribution run sees exactly the same random numbers (common random numbers).
  const logGpu = new Float64Array(S * TT);
  const power = new Float64Array(S * TT);
  const util = new Float64Array(S * TT);
  const uDefault = new Float64Array(S * TT);
  const uRenew = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    const rng = new Rng(pathSeed(opt.seed, s));
    uRenew[s] = rng.uniform();
    let x = x0;
    let y = y0;
    let jumps = 0;
    for (let t = 0; t < TT; t++) {
      const z1 = rng.normal();
      const z2 = rho * z1 + Math.sqrt(1 - rho * rho) * rng.normal();
      const zu = rng.normal();
      const uShock = rng.uniform();
      const uSpike = rng.uniform();
      const uDef = rng.uniform();
      const forced = o.gpuShock && o.gpuShock.month === t + 1 ? o.gpuShock.logSize : 0;
      if (o.freezeGpu) {
        jumps += forced;
        x = expectedLog[t] + jumps;
      } else {
        const shock = (uShock < shockProb ? mkt.genShockSize : 0) + forced;
        jumps += shock;
        x = x + mkt.gpuMeanReversion * (expectedLog[t] + jumps - x) * DT + mkt.gpuVol * Math.sqrt(DT) * z1 + shock;
      }
      logGpu[s * TT + t] = x;

      let p = 0;
      if (powerOn) {
        if (o.freezePower) {
          p = mkt.power0;
        } else {
          y = y + mkt.powerMeanReversion * (y0 - y) * DT + mkt.powerVol * Math.sqrt(DT) * z2;
          p = Math.exp(y) * (uSpike < mkt.powerSpikeProbPerMonth ? Math.exp(mkt.powerSpikeSize) : 1);
        }
        if (o.powerMultiplier && t + 1 >= o.powerMultiplier.from && t + 1 <= o.powerMultiplier.to) {
          p *= o.powerMultiplier.factor;
        }
      }
      power[s * TT + t] = p;
      const noise = o.freezeUtil ? 0 : 0.04 * zu;
      util[s * TT + t] = Math.min(0.98, Math.max(0.2, mkt.merchantUtil + mkt.utilPriceBeta * (x - x0) + noise));
      uDefault[s * TT + t] = uDef;
    }
  }

  // ---- Hedge pricing off the simulated paths: fair value plus the seller's loading.
  const strike = mkt.gpuSpot0 * hedges.gpuPutStrike;
  let putFair = 0;
  if (hedges.gpuPutShare > 0) {
    for (let s = 0; s < S; s++) {
      for (let t = 0; t < T; t++) {
        putFair += N * hedges.gpuPutShare * HOURS * Math.max(0, strike - Math.exp(logGpu[s * TT + t]));
      }
    }
    putFair /= S;
  }
  const putPremiumTotal = putFair * (1 + hedges.gpuPutLoading);
  const putPremiumMonthly = T > 0 ? putPremiumTotal / T : 0;

  const principal = deal.capexPerGpu * N * deal.ltv;
  const sched = principalSchedule(deal);
  const schedDs = scheduledDebtService(deal);
  const reserveTarget = deal.reserveMonths * (schedDs[0] ?? 0);
  const baseHazard = 1 - Math.pow(1 - ANNUAL_PD[deal.offtakerRating], DT);
  const energyFull = (N * deal.kwPerGpu * deal.pue * HOURS) / 1000; // MWh per month at full load
  const fixedPower = mkt.power0 * (1 + hedges.powerFixedPremium);
  const r = deal.annualRate / 12;
  const p0 = deal.renewalProbability;

  const losses: number[] = [];
  let lifeYears = 0;
  const defaultMonths: number[] = [];
  const defaultLosses: number[] = [];
  const defaultEads: number[] = [];
  let lockups = 0;
  let covenantDefaults = 0;
  let cures = 0;
  const dscrByMonth: number[][] = Array.from({ length: T }, () => []);
  const defaultedBy = new Array<number>(T).fill(0);

  for (let s = 0; s < S; s++) {
    const base = s * TT;
    let offDefault = Infinity;
    let renewalPrice = 0;
    let renewShare = 0; // share of the anchor capacity renewed at expiry (fractional when renewal is frozen)

    const rv = (t: number) =>
      deal.capexPerGpu *
      Math.pow(0.5, (deal.ageAtCloseMonths + t) / mkt.rvHalfLifeMonths) *
      Math.exp(mkt.rvPriceElasticity * (logGpu[base + t - 1] - x0));

    /** Operating cash flow available for debt service in month t (1-based), updating tenant state. */
    const cfads = (t: number): number => {
      const i = base + t - 1;
      const spot = Math.exp(logGpu[i]);
      if (t === C + 1 && offDefault === Infinity && o.renewal !== 'never' && (p0 > 0 || o.renewal === 'always')) {
        const tight = logGpu[i] - expectedLog[t - 1];
        const pr = p0 >= 1 ? 1 : p0 <= 0 ? 0 : 1 / (1 + Math.exp(-(Math.log(p0 / (1 - p0)) + mkt.renewalTightness * tight)));
        renewShare = o.renewal === 'always' ? 1 : o.freezeRenewal ? pr : uRenew[s] < pr ? 1 : 0;
        if (renewShare > 0) renewalPrice = spot;
      }
      const original = t <= C;
      const contractActive = (original || renewalPrice > 0) && t < offDefault;
      const price = original ? deal.contractPrice : renewalPrice;
      const anchorShare = deal.contractedShare * (original || offDefault <= C ? 1 : renewShare);
      if (contractActive && offDefault === Infinity) {
        if (o.forceOfftakerDefaultMonth !== undefined) {
          if (o.forceOfftakerDefaultMonth === t) offDefault = t;
        } else if (!o.noOfftakerDefault) {
          // An above-market contract is the one a tenant walks away from: hazard rises with price / spot.
          const h = Math.min(0.5, baseHazard * Math.exp(mkt.wrongWay * Math.log(price / spot)));
          if (uDefault[i] < h) offDefault = t;
        }
      }
      const active = contractActive && t < offDefault;
      const inGap = t >= offDefault && t < offDefault + deal.releaseDelayMonths;
      const contracted = active ? anchorShare : 0;
      const idle = inGap ? anchorShare : 0;
      const merchant = 1 - contracted - idle;
      const u = util[i];
      const load = contracted * 0.9 + merchant * u;
      const energy = energyFull * (load + deal.idleLoadShare * (1 - load));
      const powerCost = energy * (hedges.powerFixedShare * fixedPower + (1 - hedges.powerFixedShare) * power[i]);
      const passThrough = load > 0 ? powerCost * ((contracted * 0.9) / load) * deal.powerPassThrough : 0;
      const revenue = N * HOURS * (contracted * price + merchant * u * spot) + passThrough;
      const putPayoff = t <= T && hedges.gpuPutShare > 0 ? N * hedges.gpuPutShare * HOURS * Math.max(0, strike - spot) : 0;
      const cf = revenue - powerCost - N * deal.opexPerGpuMonth + putPayoff - (t <= T ? putPremiumMonthly : 0);
      if (!Number.isFinite(cf)) throw new Error(`Cash flow is not a number in month ${t}; check the inputs`);
      return cf;
    };

    /**
     * Event of default in month t: acceleration, workout, forced sale. Returns the lender's loss, with
     * collections and sale proceeds discounted to the default date at the loan rate (the claim's own yield).
     */
    const workout = (t: number, exposure: number, cash: number): number => {
      let collections = 0;
      for (let k = 1; k <= L; k++) {
        // A defaulted operator loses customers and staff: only part of the cash flow reaches the lender.
        collections += (WORKOUT_CASH_SHARE * Math.max(0, cfads(t + k))) / Math.pow(1 + r, k);
      }
      const saleMonth = t + L;
      const drop = Math.max(0, x0 - logGpu[base + saleMonth - 1]);
      const haircut = Math.min(0.8, deal.liquidationHaircut + mkt.forcedSaleSensitivity * drop);
      const proceeds = (N * rv(saleMonth) * (1 - haircut)) / Math.pow(1 + r, L);
      return Math.max(0, exposure * (1 + deal.workoutCostPct) - collections - proceeds - cash);
    };

    let bal = principal;
    let reserve = reserveTarget;
    let trap = 0;
    let locked = false;
    let everLocked = false;
    let belowTests = 0;
    let sweepAll = false;
    let rate = r;
    let loss = 0;
    let defaultMonth = 0;
    let byCovenant = false;
    let ead = 0;
    const recent: number[] = [];

    let balanceMonths = 0; // area under the outstanding balance, for the realised average life
    for (let t = 1; t <= T; t++) {
      if (bal <= 1e-6) break; // repaid early (cash sweep): nothing left to cover
      balanceMonths += bal;
      const cf = cfads(t);
      const interest = bal * rate;
      const principalPay = Math.min(sched[t - 1], bal);
      const ds = interest + principalPay;
      const dscr = cf / ds;
      dscrByMonth[t - 1].push(dscr);
      recent.push(dscr);
      if (recent.length > 3) recent.shift();

      if (cf >= ds) {
        bal -= principalPay;
        let excess = cf - ds;
        const refill = Math.min(excess, Math.max(0, reserveTarget - reserve));
        reserve += refill;
        excess -= refill;
        if (sweepAll) bal -= Math.min(bal, excess);
        else if (locked) trap += excess;
        else bal -= Math.min(bal, excess * deal.cashSweepPct);
      } else {
        let shortfall = ds - cf;
        const fromTrap = Math.min(trap, shortfall);
        trap -= fromTrap;
        shortfall -= fromTrap;
        if (reserve >= shortfall) {
          reserve -= shortfall;
          bal -= principalPay;
        } else {
          defaultMonth = t;
          ead = bal + interest;
          loss = workout(t, ead, reserve + trap);
          break;
        }
      }

      // Quarterly covenant tests on trailing three-month DSCR.
      if (t % 3 === 0) {
        const avg = (recent[0] + recent[1] + recent[2]) / 3;
        if (avg < deal.lockupDscr) {
          locked = true;
          everLocked = true;
        } else if (locked) {
          locked = false; // released to the sponsor after a passing test
          trap = 0;
        }
        belowTests = avg < deal.dscrCovenant ? belowTests + 1 : 0;
        if (belowTests >= 2 && t < T && N * rv(t) * (1 - deal.liquidationHaircut) + trap + reserve >= bal) {
          // Collateral still covers the debt: the lender cures with a full cash sweep and a margin
          // step-up instead of a forced sale.
          if (!sweepAll) {
            cures++;
            rate = r + CURE_STEP_UP / 12;
          }
          sweepAll = true;
          locked = false;
          bal -= Math.min(bal, trap);
          trap = 0;
          belowTests = 0;
        }
        if (belowTests >= 2 && t < T) {
          defaultMonth = t;
          byCovenant = true;
          ead = bal;
          loss = workout(t, ead, reserve + trap);
          break;
        }
      }

      if (t === T && bal > 1e-6) {
        // Balloon: repaid from trapped cash and reserves, or refinanced at 60% of the fleet's market value.
        const refi = 0.6 * N * rv(T);
        if (trap + reserve + refi < bal) {
          defaultMonth = T;
          ead = bal;
          loss = workout(T, ead, reserve + trap);
        }
      }
    }

    if (everLocked) lockups++;
    if (defaultMonth > 0) {
      defaultMonths.push(defaultMonth);
      defaultLosses.push(loss);
      defaultEads.push(ead);
      if (byCovenant) covenantDefaults++;
      for (let t = defaultMonth; t <= T; t++) defaultedBy[t - 1]++;
      // Defaulted paths stay in the coverage distribution at zero, so the bands are not survivor-biased.
      for (let t = defaultMonth + 1; t <= T; t++) dscrByMonth[t - 1].push(0);
    }
    losses.push(loss);
    lifeYears += principal > 0 ? balanceMonths / principal / 12 : 0;
  }

  const lossPct = losses.map((l) => l / principal).sort((a, b) => a - b);
  const expectedLoss = losses.reduce((a, b) => a + b, 0) / S;
  const sumEad = defaultEads.reduce((a, b) => a + b, 0);
  const realisedLife = lifeYears / S;
  const result: SimResult = {
    sims: S,
    principal,
    probDefault: defaultMonths.length / S,
    probPaymentDefault: (defaultMonths.length - covenantDefaults) / S,
    probCovenantAcceleration: covenantDefaults / S,
    probCure: cures / S,
    fullRecoveryShare: defaultLosses.length ? defaultLosses.filter((l) => l <= 0).length / defaultLosses.length : 0,
    probLockup: lockups / S,
    probLoss: losses.filter((l) => l > 0).length / S,
    expectedLoss,
    expectedLossPct: principal > 0 ? expectedLoss / principal : 0,
    lossGivenDefaultPct: sumEad > 0 ? defaultLosses.reduce((a, b) => a + b, 0) / sumEad : 0,
    exposureAtDefaultPct: defaultEads.length && principal > 0 ? sumEad / defaultEads.length / principal : 0,
    var99LossPct: quantile(lossPct, 0.99),
    walYears: realisedLife > 0 ? realisedLife : weightedAverageLife(deal),
    defaultMonths,
    defaultsAfterExpiryShare: defaultMonths.length ? defaultMonths.filter((m) => m > C).length / defaultMonths.length : 0,
    lossAfterExpiryShare:
      expectedLoss > 0 ? defaultLosses.filter((_, k) => defaultMonths[k] > C).reduce((a, b) => a + b, 0) / (expectedLoss * S) : 0,
    covenantDefaultShare: defaultMonths.length ? covenantDefaults / defaultMonths.length : 0,
    gpuPutPremiumTotal: putPremiumTotal,
    scheduledDebtService: schedDs,
  };

  if (opt.keepMonthly) {
    result.dscrQuantiles = dscrByMonth.map((vals, k) => {
      const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
      return { month: k + 1, p5: quantile(v, 0.05), p25: quantile(v, 0.25), p50: quantile(v, 0.5), p75: quantile(v, 0.75), p95: quantile(v, 0.95) };
    });
    result.cumulativeDefault = defaultedBy.map((d) => d / S);
  }
  return result;
}

/**
 * Coverage in a market that follows its expected path exactly: what the lender sees at closing.
 * Deterministic: the renewal branch is chosen explicitly, never drawn at random.
 */
export function projectedDscr(deal: Deal, mkt: Market, hedges: Hedges, renewal: 'always' | 'never'): number[] {
  // No reserve depletion or covenant default here: this is the coverage the lender sizes the loan on.
  const sizing = { ...deal, reserveMonths: 1e6, lockupDscr: -Infinity, dscrCovenant: -Infinity };
  const r = simulate(sizing, mkt, hedges, {
    sims: 1,
    seed: 1,
    keepMonthly: true,
    overrides: { freezeGpu: true, freezePower: true, freezeUtil: true, noOfftakerDefault: true, renewal },
  });
  return r.dscrQuantiles!.map((q) => q.p50);
}
