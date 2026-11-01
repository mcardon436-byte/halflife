import { DEFAULT_DEAL, DEFAULT_MARKET, NO_HEDGES } from './engine/defaults';
import type { Deal, Hedges, Market } from './engine/types';

export interface Preset {
  key: string;
  label: string;
  deal: Deal;
  market: Market;
  hedges: Hedges;
}

export const PRESETS: Preset[] = [
  {
    key: 'atlas',
    label: 'Neocloud, startup tenant',
    deal: DEFAULT_DEAL,
    market: DEFAULT_MARKET,
    hedges: NO_HEDGES,
  },
  {
    key: 'meridian',
    label: 'GPU lease, hyperscaler tenant',
    deal: {
      ...DEFAULT_DEAL,
      name: 'Project Meridian — 4,000 H100, hyperscaler lease',
      gpuCount: 4000,
      ltv: 0.75,
      annualRate: 0.085,
      contractedShare: 0.95,
      contractPrice: 2.0,
      contractTenorMonths: 36,
      offtakerRating: 'AA',
      powerPassThrough: 1,
    },
    market: DEFAULT_MARKET,
    hedges: NO_HEDGES,
  },
  {
    key: 'icarus',
    label: 'Aggressive bridge loan',
    deal: {
      ...DEFAULT_DEAL,
      name: 'Project Icarus — 1,000 B200, 12-month offtake',
      gpuCount: 1000,
      capexPerGpu: 45000,
      ageAtCloseMonths: 0,
      kwPerGpu: 1.9,
      ltv: 0.85,
      annualRate: 0.14,
      balloonPct: 0.3,
      contractTenorMonths: 12,
      contractPrice: 3.4,
      offtakerRating: 'CCC',
    },
    market: { ...DEFAULT_MARKET, gpuSpot0: 3.2 },
    hedges: NO_HEDGES,
  },
];
