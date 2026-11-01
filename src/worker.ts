import { buildReport } from './engine/report';
import type { Deal, Hedges, Market } from './engine/types';

// Simulations run off the main thread so the form stays responsive while typing.
self.onmessage = (e: MessageEvent<{ id: number; deal: Deal; market: Market; hedges: Hedges }>) => {
  const { id, deal, market, hedges } = e.data;
  try {
    self.postMessage({ id, report: buildReport(deal, market, hedges) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
