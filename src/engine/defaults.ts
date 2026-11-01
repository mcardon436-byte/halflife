import type { Deal, Hedges, Market, Rating } from './types';

// Long-run one-year default rates, rounded (order of magnitude of S&P / Moody's corporate studies).
// "Unrated AI startup" is an assumption: venture-funded tenants without a rating.
export const ANNUAL_PD: Record<Rating, number> = {
  AAA: 0.0001,
  AA: 0.0002,
  A: 0.0006,
  BBB: 0.0018,
  BB: 0.007,
  B: 0.03,
  'Unrated AI startup': 0.06,
  CCC: 0.25,
};

// Approximate three-year cumulative expected loss by rating, rounded from the order of magnitude of
// Moody's idealised expected-loss table (mid-notch of each letter grade). Ratings measure loss, not
// technical defaults, so the equivalent rating is read off expected loss. To verify before external use.
export const CUMULATIVE_EL_3Y: [Rating, number][] = [
  ['AAA', 0.0001],
  ['AA', 0.0006],
  ['A', 0.0025],
  ['BBB', 0.0105],
  ['BB', 0.05],
  ['B', 0.12],
  ['CCC', 0.25],
];

export const DEFAULT_DEAL: Deal = {
  name: 'Project Atlas — 2,000 H100 neocloud facility',
  gpuCount: 2000,
  capexPerGpu: 30000,
  ageAtCloseMonths: 6,
  ltv: 0.7,
  annualRate: 0.11,
  costOfFunds: 0.055,
  tenorMonths: 36,
  frontAmortPct: 0,
  balloonPct: 0,
  sizingDscr: 1.3,
  lockupDscr: 1.15,
  dscrCovenant: 1.0,
  reserveMonths: 3,
  cashSweepPct: 0,
  contractedShare: 0.8,
  contractPrice: 2.2,
  contractTenorMonths: 24,
  offtakerRating: 'Unrated AI startup',
  releaseDelayMonths: 3,
  renewalProbability: 0.6,
  powerPassThrough: 0,
  kwPerGpu: 1.4,
  pue: 1.3,
  idleLoadShare: 0.3,
  opexPerGpuMonth: 150,
  liquidationHaircut: 0.3,
  liquidationMonths: 6,
  workoutCostPct: 0.05,
};

// Illustrative market parameters, anchored on public 2026 figures: H100 rental indices around
// $1.70–2.63/GPU-hour (Silicon Data, Ornn); wholesale power from ~$70/MWh (ERCOT averages) to ~$137/MWh
// (PJM, Q1 2026), so $95 is a blended delivered price. Volatilities and shocks are assumptions to calibrate.
export const DEFAULT_MARKET: Market = {
  gpuSpot0: 2.1,
  gpuDriftPerYear: 0.15,
  gpuVol: 0.35,
  gpuMeanReversion: 1.0,
  genShockProbPerYear: 0.3,
  genShockSize: -0.15,
  merchantUtil: 0.7,
  utilPriceBeta: 0.25,
  power0: 95,
  powerVol: 0.45,
  powerMeanReversion: 3,
  powerSpikeProbPerMonth: 0.05,
  powerSpikeSize: 0.7,
  powerGpuCorrelation: 0.1,
  wrongWay: 1.0,
  renewalTightness: 2,
  forcedSaleSensitivity: 0.3,
  rvHalfLifeMonths: 30,
  rvPriceElasticity: 1,
};

export const NO_HEDGES: Hedges = {
  powerFixedShare: 0,
  powerFixedPremium: 0.08,
  gpuPutShare: 0,
  gpuPutStrike: 0.75,
  gpuPutLoading: 0.15,
};
