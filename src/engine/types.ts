export type Rating = 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'Unrated AI startup' | 'CCC';

export interface Deal {
  name: string;
  gpuCount: number;
  capexPerGpu: number; // $ all-in per GPU (server, networking, install)
  ageAtCloseMonths: number;
  // Loan
  ltv: number; // loan / capex
  annualRate: number; // all-in coupon
  costOfFunds: number; // lender's own funding cost, to judge the risk-adjusted margin
  tenorMonths: number;
  frontAmortPct: number; // share of principal repaid while the anchor contract runs (0 = straight-line)
  balloonPct: number; // share of principal left at maturity
  sizingDscr: number; // minimum projected DSCR a lender sizes the loan on (financeability test)
  lockupDscr: number; // below this trailing-3-month DSCR, excess cash is trapped
  dscrCovenant: number; // below this at two consecutive quarterly tests: event of default
  reserveMonths: number; // debt service reserve funded by the sponsor at close, in months of debt service
  cashSweepPct: number; // share of excess cash used to prepay when not locked up
  // Offtake
  contractedShare: number;
  contractPrice: number; // $/GPU-hour
  contractTenorMonths: number;
  offtakerRating: Rating;
  releaseDelayMonths: number; // months of zero revenue after a tenant default
  renewalProbability: number; // base chance the anchor tenant renews at expiry, at the then-current spot price
  powerPassThrough: number; // share of the contracted capacity's power cost billed to the tenant (colocation-style)
  // Site
  kwPerGpu: number; // IT load per GPU incl. server overhead
  pue: number;
  idleLoadShare: number; // power drawn by an idle GPU, as share of full load
  opexPerGpuMonth: number; // $ non-power opex (colocation rent, staff, maintenance, insurance)
  // Recovery
  liquidationHaircut: number; // forced-sale discount to the GPUs' market value
  liquidationMonths: number; // time from event of default to sale
  workoutCostPct: number; // legal and workout costs, share of exposure
}

export interface Market {
  gpuSpot0: number; // $/GPU-hour today
  gpuDriftPerYear: number; // expected log decline of rental prices per year (new generations)
  gpuVol: number; // annual volatility
  gpuMeanReversion: number; // per year
  genShockProbPerYear: number; // probability of a new-generation price shock per year
  genShockSize: number; // log size of that shock (negative)
  merchantUtil: number; // base utilisation of uncontracted capacity
  utilPriceBeta: number; // utilisation sensitivity to log GPU price
  power0: number; // $/MWh
  powerVol: number;
  powerMeanReversion: number;
  powerSpikeProbPerMonth: number;
  powerSpikeSize: number; // log size
  powerGpuCorrelation: number;
  wrongWay: number; // tenant hazard elasticity to (contract price / spot): an above-market contract is a default risk
  renewalTightness: number; // renewal odds sensitivity to how tight the market is at expiry
  forcedSaleSensitivity: number; // extra haircut per unit of log price drop (everyone sells at once)
  rvHalfLifeMonths: number;
  rvPriceElasticity: number;
}

export interface Hedges {
  powerFixedShare: number; // share of energy bought at a fixed price
  powerFixedPremium: number; // fixed price = power0 * (1 + premium)
  gpuPutShare: number; // share of fleet covered by a put on the GPU rental index
  gpuPutStrike: number; // strike as share of gpuSpot0
  gpuPutLoading: number; // premium = fair value * (1 + loading)
}

/** Deterministic overrides used by named stress scenarios and risk attribution. */
export interface Overrides {
  freezeGpu?: boolean;
  freezePower?: boolean;
  noOfftakerDefault?: boolean;
  freezeUtil?: boolean;
  gpuShock?: { month: number; logSize: number };
  powerMultiplier?: { from: number; to: number; factor: number };
  forceOfftakerDefaultMonth?: number;
  renewal?: 'always' | 'never'; // force the renewal branch (deterministic projections)
  freezeRenewal?: boolean; // renew the expected share of capacity instead of a coin flip
}

export interface SimOptions {
  sims: number;
  seed: number;
  overrides?: Overrides;
  keepMonthly?: boolean;
}

export interface SimResult {
  sims: number;
  principal: number;
  probDefault: number; // event of default: payment default or covenant acceleration
  probPaymentDefault: number; // reserve exhausted or balloon not refinanced
  probCovenantAcceleration: number; // covenant breach with collateral too thin to cure
  probCure: number; // covenant breach cured by a full cash sweep and a margin step-up
  fullRecoveryShare: number; // share of defaults where the lender gets everything back
  probLockup: number; // cash trapped at least once
  probLoss: number; // probability the lender does not get all its money back
  expectedLoss: number;
  expectedLossPct: number; // of original principal
  lossGivenDefaultPct: number; // total loss / total exposure at default, over defaulted paths
  exposureAtDefaultPct: number; // average exposure at default, % of original principal (PD × LGD × EAD = EL)
  var99LossPct: number;
  walYears: number; // realised average life of the loan across paths (prepayments and defaults included)
  defaultMonths: number[];
  defaultsAfterExpiryShare: number;
  lossAfterExpiryShare: number; // share of total loss from defaults after the anchor contract ends
  covenantDefaultShare: number; // share of defaults triggered by the covenant rather than a missed payment
  dscrQuantiles?: { month: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  cumulativeDefault?: number[]; // share of paths in default by month
  gpuPutPremiumTotal: number;
  scheduledDebtService: number[];
}
