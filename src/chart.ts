interface Q {
  month: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

const W = 720;
const M = { top: 16, right: 16, bottom: 36, left: 44 };

function attachHover(
  el: HTMLElement,
  svg: SVGSVGElement,
  n: number,
  x: (m: number) => number,
  y: (m: number) => number,
  H: number,
  tipHtml: (m: number) => string | null,
) {
  const iw = W - M.left - M.right;
  const cursor = svg.querySelector<SVGGElement>('.cursor')!;
  const tip = el.querySelector<HTMLDivElement>('.tooltip')!;
  const hit = svg.querySelector('.hit')!;
  hit.addEventListener('pointermove', ((ev: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    const m = Math.max(1, Math.min(n, Math.round(((sx - M.left) / iw) * (n - 1)) + 1));
    const html = tipHtml(m);
    if (!html) return;
    cursor.removeAttribute('hidden');
    const line = cursor.querySelector('line')!;
    line.setAttribute('x1', String(x(m)));
    line.setAttribute('x2', String(x(m)));
    const dot = cursor.querySelector('circle')!;
    dot.setAttribute('cx', String(x(m)));
    dot.setAttribute('cy', String(y(m)));
    tip.hidden = false;
    tip.innerHTML = html;
    const px = (x(m) / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 190, Math.max(0, px + 12))}px`;
    tip.style.top = `${(M.top / H) * rect.height}px`;
  }) as EventListener);
  hit.addEventListener('pointerleave', () => {
    cursor.setAttribute('hidden', '');
    tip.hidden = true;
  });
}

/** DSCR fan chart: one series (the deal), so bands use ink tints rather than categorical hues. */
export function renderDscrChart(el: HTMLElement, q: Q[], opts: { covenant: number; lockup: number; contractEnd: number | null }) {
  const H = 280;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const finite = q.filter((d) => Number.isFinite(d.p5) && Number.isFinite(d.p95));
  const yMax = Math.ceil(Math.max(opts.lockup * 1.5, ...finite.map((d) => Math.min(d.p95, 6))) * 2) / 2;
  const yMin = 0;
  const n = q.length;
  const x = (m: number) => M.left + ((m - 1) / Math.max(1, n - 1)) * iw;
  const y = (v: number) => M.top + (1 - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * ih;

  const area = (lo: keyof Q, hi: keyof Q) =>
    finite.map((d, i) => `${i ? 'L' : 'M'}${x(d.month).toFixed(1)},${y(d[hi]).toFixed(1)}`).join('') +
    [...finite].reverse().map((d) => `L${x(d.month).toFixed(1)},${y(d[lo]).toFixed(1)}`).join('') +
    'Z';
  const line = finite.map((d, i) => `${i ? 'L' : 'M'}${x(d.month).toFixed(1)},${y(d.p50).toFixed(1)}`).join('');
  const step = yMax > 4 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let v = yMin; v <= yMax + 1e-9; v += step) ticks.push(Math.round(v * 10) / 10);
  const xticks = q.filter((d) => d.month === 1 || d.month % 6 === 0).map((d) => d.month);
  const ce = opts.contractEnd;

  el.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="dscr-desc" preserveAspectRatio="xMidYMid meet">
    <desc id="dscr-desc">Debt service coverage ratio by month. ${finite
      .filter((d) => d.month % 6 === 0)
      .map((d) => `Month ${d.month}: median ${d.p50.toFixed(2)}x, worst 5% ${d.p5.toFixed(2)}x`)
      .join('. ')}.</desc>
    <g class="grid">${ticks.map((t) => `<line x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"/><text x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}x</text>`).join('')}</g>
    <g class="xaxis">${xticks.map((m) => `<text x="${x(m)}" y="${H - 14}" text-anchor="middle">M${m}</text>`).join('')}</g>
    ${ce ? `<g class="marker"><line x1="${x(ce + 0.5)}" x2="${x(ce + 0.5)}" y1="${M.top}" y2="${M.top + ih}"/><text x="${x(ce + 0.5) + 6}" y="${M.top + 12}">Anchor contract ends</text></g>` : ''}
    <path class="band90" d="${area('p5', 'p95')}"/>
    <path class="band50" d="${area('p25', 'p75')}"/>
    <path class="median" d="${line}"/>
    <g class="threshold lockup"><line x1="${M.left}" x2="${W - M.right}" y1="${y(opts.lockup)}" y2="${y(opts.lockup)}"/><text x="${M.left + 6}" y="${y(opts.lockup) - 6}">Lock-up ${opts.lockup.toFixed(2)}x</text></g>
    <g class="threshold covenant"><line x1="${M.left}" x2="${W - M.right}" y1="${y(opts.covenant)}" y2="${y(opts.covenant)}"/><text x="${W - M.right}" y="${y(opts.covenant) + 14}" text-anchor="end">Default ${opts.covenant.toFixed(2)}x</text></g>
    <g class="cursor" hidden><line y1="${M.top}" y2="${M.top + ih}"/><circle r="4"/></g>
    <rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}"/>
  </svg>
  <div class="tooltip" hidden></div>
  <ul class="legend" aria-hidden="true"><li><span class="sw median-sw"></span>Median</li><li><span class="sw band50-sw"></span>Middle 50%</li><li><span class="sw band90-sw"></span>90% of paths</li></ul>`;

  attachHover(el, el.querySelector('svg')!, n, x, (m) => y(q[m - 1].p50), H, (m) => {
    const d = q[m - 1];
    if (!d || !Number.isFinite(d.p50)) return null;
    // A zero median means more than half the loans are in default by then, not a coverage of 0.00x.
    const median = d.p50 <= 0 ? '<span>More than half the loans in default</span>' : `<span>Median <b>${d.p50.toFixed(2)}x</b></span>`;
    const band = d.p25 <= 0 ? '' : `<span>Middle 50% <b>${d.p25.toFixed(2)}–${d.p75.toFixed(2)}x</b></span>`;
    const worst = d.p5 <= 0 ? '<span>Worst 5%: in default</span>' : `<span>Worst 5% <b>${d.p5.toFixed(2)}x</b></span>`;
    return `<strong>Month ${d.month}</strong>${median}${band}${worst}`;
  });
}

/** Cumulative share of loans in default: a separate chart, never a second axis on the DSCR chart. */
export function renderDefaultChart(el: HTMLElement, cum: number[], opts: { contractEnd: number | null }) {
  const H = 150;
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const n = cum.length;
  const top = Math.max(0.05, Math.ceil((Math.max(...cum) + 0.0001) * 10) / 10);
  const x = (m: number) => M.left + ((m - 1) / Math.max(1, n - 1)) * iw;
  const y = (v: number) => M.top + (1 - v / top) * ih;
  const pts = cum.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`);
  const area = `M${x(1)},${y(0)}L${pts.join('L')}L${x(n)},${y(0)}Z`;
  const ticks = [0, top / 2, top];
  const xticks = cum.map((_, i) => i + 1).filter((m) => m === 1 || m % 6 === 0);
  const ce = opts.contractEnd;
  el.innerHTML = `
  <p class="chart-title">Loans in default, cumulative</p>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="def-desc" preserveAspectRatio="xMidYMid meet">
    <desc id="def-desc">Share of simulated loans in default by month. ${cum
      .map((v, i) => [i + 1, v] as const)
      .filter(([m]) => m % 6 === 0)
      .map(([m, v]) => `Month ${m}: ${(v * 100).toFixed(1)}%`)
      .join('. ')}.</desc>
    <g class="grid">${ticks.map((t) => `<line x1="${M.left}" x2="${W - M.right}" y1="${y(t)}" y2="${y(t)}"/><text x="${M.left - 8}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text>`).join('')}</g>
    <g class="xaxis">${xticks.map((m) => `<text x="${x(m)}" y="${H - 14}" text-anchor="middle">M${m}</text>`).join('')}</g>
    ${ce ? `<g class="marker"><line x1="${x(ce + 0.5)}" x2="${x(ce + 0.5)}" y1="${M.top}" y2="${M.top + ih}"/></g>` : ''}
    <path class="default-area" d="${area}"/>
    <path class="median" d="M${pts.join('L')}"/>
    <g class="cursor" hidden><line y1="${M.top}" y2="${M.top + ih}"/><circle r="4"/></g>
    <rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}"/>
  </svg>
  <div class="tooltip" hidden></div>`;
  attachHover(el, el.querySelector('svg')!, n, x, (m) => y(cum[m - 1]), H, (m) => `<strong>Month ${m}</strong><span>In default <b>${(cum[m - 1] * 100).toFixed(1)}%</b></span>`);
}
