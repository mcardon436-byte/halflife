import '@phosphor-icons/web/regular/style.css';
import './tokens.css';
import './style.css';
import { renderDefaultChart, renderDscrChart } from './chart';
import { ANNUAL_PD } from './engine/defaults';
import type { Report } from './engine/report';
import type { Deal, Hedges, Market, Rating } from './engine/types';
import { PRESETS } from './presets';
import { startTour } from './tour';

type Target = 'deal' | 'market' | 'hedges';
interface Field {
  target: Target;
  key: string;
  label: string;
  kind: 'pct' | 'num' | 'select';
  unit?: string;
  step?: number;
  min?: number;
  max?: number;
  help?: string;
}

const SECTIONS: { title: string; fields: Field[]; advanced?: boolean }[] = [
  {
    title: 'The deal',
    fields: [
      { target: 'deal', key: 'gpuCount', label: 'GPUs financed', kind: 'num', step: 100, min: 1 },
      { target: 'deal', key: 'capexPerGpu', label: 'All-in cost per GPU', kind: 'num', unit: '$', step: 1000, min: 1000 },
      { target: 'deal', key: 'ltv', label: 'Loan-to-value', kind: 'pct', step: 1, min: 5, max: 100, help: 'Loan amount as a share of the GPUs’ cost.' },
      { target: 'deal', key: 'annualRate', label: 'Interest rate', kind: 'pct', step: 0.25, min: 0, max: 40 },
      { target: 'deal', key: 'tenorMonths', label: 'Loan length', kind: 'num', unit: 'months', step: 6, min: 6, max: 120 },
    ],
  },
  {
    title: 'Anchor tenant',
    fields: [
      { target: 'deal', key: 'contractedShare', label: 'Capacity under contract', kind: 'pct', step: 5, min: 0, max: 100 },
      { target: 'deal', key: 'contractPrice', label: 'Contract price', kind: 'num', unit: '$/GPU-h', step: 0.05, min: 0 },
      { target: 'deal', key: 'contractTenorMonths', label: 'Contract length', kind: 'num', unit: 'months', step: 6, min: 0, max: 120 },
      { target: 'deal', key: 'offtakerRating', label: 'Tenant credit', kind: 'select' },
    ],
  },
  {
    title: 'Loan structure',
    advanced: true,
    fields: [
      { target: 'deal', key: 'frontAmortPct', label: 'Repaid during the contract', kind: 'pct', step: 5, min: 0, max: 100, help: '0% means equal repayments over the whole loan.' },
      { target: 'deal', key: 'balloonPct', label: 'Balloon at maturity', kind: 'pct', step: 5, min: 0, max: 100, help: 'Principal left to refinance at the end.' },
      { target: 'deal', key: 'sizingDscr', label: 'Sized on a minimum DSCR of', kind: 'num', unit: 'x DSCR', step: 0.05, min: 0, max: 5, help: 'A change is financeable only if projected coverage stays above this.' },
      { target: 'deal', key: 'lockupDscr', label: 'Cash lock-up below', kind: 'num', unit: 'x DSCR', step: 0.05, min: 0, max: 5, help: 'DSCR = operating cash flow ÷ debt service, tested quarterly.' },
      { target: 'deal', key: 'dscrCovenant', label: 'Event of default below', kind: 'num', unit: 'x DSCR', step: 0.05, min: 0, max: 5, help: 'Two failed quarterly tests in a row.' },
      { target: 'deal', key: 'reserveMonths', label: 'Debt service reserve', kind: 'num', unit: 'months', step: 1, min: 0, max: 24, help: 'Funded by the sponsor at closing.' },
      { target: 'deal', key: 'cashSweepPct', label: 'Cash sweep', kind: 'pct', step: 5, min: 0, max: 100, help: 'Share of spare cash that prepays the loan.' },
      { target: 'deal', key: 'costOfFunds', label: 'Lender’s cost of funds', kind: 'pct', step: 0.25, min: 0, max: 30 },
    ],
  },
  {
    title: 'Tenant and site',
    advanced: true,
    fields: [
      { target: 'deal', key: 'renewalProbability', label: 'Renewal odds at expiry', kind: 'pct', step: 5, min: 0, max: 100, help: 'Renewals reprice at the spot rate of the day.' },
      { target: 'market', key: 'power0', label: 'Wholesale power', kind: 'num', unit: '$/MWh', step: 5, min: 1 },
      { target: 'deal', key: 'powerPassThrough', label: 'Power billed to tenant', kind: 'pct', step: 10, min: 0, max: 100 },
      { target: 'deal', key: 'opexPerGpuMonth', label: 'Other costs per GPU', kind: 'num', unit: '$/month', step: 10, min: 0, help: 'Colocation rent, staff, maintenance, insurance.' },
      { target: 'deal', key: 'ageAtCloseMonths', label: 'GPU age at closing', kind: 'num', unit: 'months', step: 1, min: 0 },
    ],
  },
  {
    title: 'Recovery',
    advanced: true,
    fields: [
      { target: 'deal', key: 'liquidationHaircut', label: 'Forced-sale discount', kind: 'pct', step: 5, min: 0, max: 95, help: 'Widens automatically when GPU prices have fallen.' },
      { target: 'deal', key: 'liquidationMonths', label: 'Time to sell after default', kind: 'num', unit: 'months', step: 1, min: 0, max: 36 },
      { target: 'deal', key: 'workoutCostPct', label: 'Legal and workout costs', kind: 'pct', step: 1, min: 0, max: 50 },
      { target: 'deal', key: 'releaseDelayMonths', label: 'Months to re-let after a tenant default', kind: 'num', unit: 'months', step: 1, min: 0, max: 24 },
    ],
  },
  {
    title: 'Hedges',
    advanced: true,
    fields: [
      { target: 'hedges', key: 'powerFixedShare', label: 'Power bought at a fixed price', kind: 'pct', step: 10, min: 0, max: 100 },
      { target: 'hedges', key: 'gpuPutShare', label: 'Fleet covered by a GPU rental put', kind: 'pct', step: 10, min: 0, max: 100 },
      { target: 'hedges', key: 'gpuPutStrike', label: 'Put strike', kind: 'pct', step: 5, min: 10, max: 150, help: 'As a share of today’s spot rental price.' },
    ],
  },
  {
    title: 'Market assumptions',
    advanced: true,
    fields: [
      { target: 'market', key: 'gpuSpot0', label: 'GPU spot rental today', kind: 'num', unit: '$/GPU-h', step: 0.05, min: 0.1 },
      { target: 'market', key: 'gpuDriftPerYear', label: 'Expected price decline', kind: 'pct', unit: '%/yr', step: 1, min: 0, max: 100 },
      { target: 'market', key: 'gpuVol', label: 'GPU price volatility', kind: 'pct', step: 5, min: 0, max: 200 },
      { target: 'market', key: 'genShockProbPerYear', label: 'New-generation shock odds', kind: 'pct', unit: '%/yr', step: 5, min: 0, max: 100 },
      { target: 'market', key: 'powerVol', label: 'Power price volatility', kind: 'pct', step: 5, min: 0, max: 200 },
      { target: 'market', key: 'merchantUtil', label: 'Utilisation without a contract', kind: 'pct', step: 5, min: 10, max: 100 },
      { target: 'market', key: 'rvHalfLifeMonths', label: 'Resale value half-life', kind: 'num', unit: 'months', step: 3, min: 6 },
    ],
  },
];

const RATINGS = Object.keys(ANNUAL_PD) as Rating[];

type State = { preset: string; deal: Deal; market: Market; hedges: Hedges };
let state: State = loadState();

function loadState(): State {
  const params = new URLSearchParams(location.hash.slice(1));
  const preset = PRESETS.find((p) => p.key === params.get('preset')) ?? PRESETS[0];
  const s: State = { preset: preset.key, deal: { ...preset.deal }, market: { ...preset.market }, hedges: { ...preset.hedges } };
  for (const sec of SECTIONS) {
    for (const f of sec.fields) {
      const v = params.get(f.key);
      if (v === null) continue;
      const n = Number(v);
      if (f.kind !== 'select' && !Number.isFinite(n)) continue;
      if (f.kind === 'select' && !RATINGS.includes(v as Rating)) continue;
      (s[f.target] as unknown as Record<string, unknown>)[f.key] = f.kind === 'select' ? v : n;
    }
  }
  return s;
}

let lastHash = '';
function saveState() {
  const preset = PRESETS.find((p) => p.key === state.preset)!;
  const params = new URLSearchParams({ preset: state.preset });
  for (const sec of SECTIONS) {
    for (const f of sec.fields) {
      const cur = (state[f.target] as unknown as Record<string, unknown>)[f.key];
      const ref = (preset[f.target] as unknown as Record<string, unknown>)[f.key];
      if (cur !== ref) params.set(f.key, String(cur));
    }
  }
  lastHash = `#${params.toString()}`;
  history.replaceState(null, '', lastHash);
}

const fmt = {
  pct: (x: number, d = 1) => `${(x * 100).toFixed(d)}%`,
  usd: (x: number) => (Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3).toLocaleString('en-US')}K`),
  x: (v: number) => `${v.toFixed(2)}x`,
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fieldValue(f: Field): string {
  const v = (state[f.target] as unknown as Record<string, unknown>)[f.key];
  if (f.kind === 'pct') return String(Math.round((v as number) * 10000) / 100);
  return String(v);
}

function renderField(f: Field): string {
  const id = `f-${f.target}-${f.key}`;
  const help = f.help ? `<p class="help" id="${id}-help">${esc(f.help)}</p>` : '';
  const described = f.help ? ` aria-describedby="${id}-help"` : '';
  if (f.kind === 'select') {
    const opts = RATINGS.map(
      (r) => `<option value="${r}" ${state.deal.offtakerRating === r ? 'selected' : ''}>${r} · ${fmt.pct(ANNUAL_PD[r], 2)} yearly default</option>`,
    ).join('');
    return `<div class="field"><label for="${id}">${esc(f.label)}</label><select id="${id}" data-target="${f.target}" data-key="${f.key}" data-kind="select"${described}>${opts}</select>${help}</div>`;
  }
  const unit = f.kind === 'pct' ? (f.unit ?? '%') : (f.unit ?? '');
  return `<div class="field"><label for="${id}">${esc(f.label)}</label>
    <div class="input-wrap"><input id="${id}" type="number" inputmode="decimal" step="${f.step ?? 'any'}" ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
      value="${fieldValue(f)}" data-target="${f.target}" data-key="${f.key}" data-kind="${f.kind}"${described} />${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</div>${help}
    <p class="field-error" role="alert" hidden><i class="ph ph-warning-circle" aria-hidden="true"></i><span></span></p></div>`;
}

function renderForm(): string {
  const core = SECTIONS.filter((s) => !s.advanced)
    .map((sec) => `<fieldset class="form-section"><legend class="caption">${esc(sec.title)}</legend><div class="fields">${sec.fields.map(renderField).join('')}</div></fieldset>`)
    .join('');
  const more = SECTIONS.filter((s) => s.advanced)
    .map(
      (sec) =>
        `<details class="form-section advanced"><summary><span class="caption">${esc(sec.title)}</span><i class="ph ph-caret-down" aria-hidden="true"></i></summary><div class="fields">${sec.fields.map(renderField).join('')}</div></details>`,
    )
    .join('');
  return `${core}<p class="caption more-title">More terms</p>${more}`;
}

function renderShell() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = `
  <header class="topbar">
    <div class="brand"><svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#A7001E"/><path d="M7 9c4 0 6 2 9 7s5 7 9 7" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg><span translate="no">Halflife</span><span class="brand-sub">Credit risk for AI infrastructure debt</span></div>
    <button type="button" class="btn tour-btn" id="play-tour"><i class="ph ph-play" aria-hidden="true"></i>Play demo</button>
  </header>
  <div class="layout">
    <aside class="panel" aria-label="Deal terms">
      <div class="panel-head">
        <p class="caption">Example deals</p>
        <div class="segmented" role="group" aria-label="Example deals">
          ${PRESETS.map((p) => `<button type="button" class="seg" data-preset="${p.key}" aria-pressed="${p.key === state.preset}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>
      <form id="deal-form" novalidate>${renderForm()}</form>
    </aside>
    <main id="results" class="results" tabindex="-1" aria-live="polite" aria-busy="true"></main>
  </div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      const p = PRESETS.find((x) => x.key === b.dataset.preset)!;
      state = { preset: p.key, deal: { ...p.deal }, market: { ...p.market }, hedges: { ...p.hedges } };
      saveState();
      lastReport = null;
      renderShell();
      run();
    }),
  );
  app.querySelector('#play-tour')!.addEventListener('click', () => startTour(() => lastReport));
  const form = app.querySelector<HTMLFormElement>('#deal-form')!;
  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', onInput);
}

function onInput(e: Event) {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (!el.dataset.key) return;
  const obj = state[el.dataset.target as Target] as unknown as Record<string, unknown>;
  const errorEl = el.closest('.field')?.querySelector<HTMLElement>('.field-error');
  if (el.dataset.kind === 'select') {
    obj[el.dataset.key] = el.value;
  } else {
    const raw = (el as HTMLInputElement).value.trim();
    const n = Number(raw);
    const min = el.getAttribute('min');
    const max = el.getAttribute('max');
    let msg = '';
    if (raw === '' || !Number.isFinite(n)) msg = 'Enter a number.';
    else if (min !== null && n < Number(min)) msg = `Use ${min} or more.`;
    else if (max !== null && n > Number(max)) msg = `Use ${max} or less.`;
    if (errorEl) {
      errorEl.hidden = !msg;
      errorEl.querySelector('span')!.textContent = msg;
    }
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) return;
    obj[el.dataset.key] = el.dataset.kind === 'pct' ? n / 100 : n;
  }
  saveState();
  scheduleRun();
}

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let lastId = 0;
let timer: number | undefined;
let lastReport: Report | null = null;
let autoTour = new URLSearchParams(location.search).has('demo');

function scheduleRun() {
  window.clearTimeout(timer);
  timer = window.setTimeout(run, 300);
}

function run() {
  const id = ++lastId;
  const results = document.querySelector<HTMLElement>('#results')!;
  results.setAttribute('aria-busy', 'true');
  if (!lastReport || !results.firstElementChild) results.innerHTML = skeleton();
  else results.classList.add('stale');
  worker.postMessage({ id, deal: state.deal, market: state.market, hedges: state.hedges });
}

worker.onmessage = (e: MessageEvent<{ id: number; report?: Report; error?: string }>) => {
  if (e.data.id !== lastId) return; // a newer run is in flight
  const results = document.querySelector<HTMLElement>('#results')!;
  results.classList.remove('stale');
  results.setAttribute('aria-busy', 'false');
  if (e.data.error || !e.data.report) {
    lastReport = null;
    results.innerHTML = `<div class="error-state"><i class="ph ph-warning-circle" aria-hidden="true"></i><div><h2>The simulation stopped</h2><p>${esc(e.data.error ?? 'Unknown error')}. Check the deal terms, then run it again.</p><button type="button" class="btn" id="retry">Run again</button></div></div>`;
    results.querySelector('#retry')?.addEventListener('click', run);
    return;
  }
  lastReport = e.data.report;
  renderResults(e.data.report);
  // ?demo in the address starts the narrated walkthrough once, for screen recordings.
  if (autoTour) {
    autoTour = false;
    window.setTimeout(() => startTour(() => lastReport), 800);
  }
};

window.addEventListener('hashchange', () => {
  if (location.hash === lastHash) return;
  state = loadState();
  lastReport = null;
  renderShell();
  run();
});

function skeleton(): string {
  return `<div class="skeleton" aria-hidden="true"><div class="sk sk-title"></div><div class="sk sk-verdict"></div><div class="sk-row">${'<div class="sk sk-stat"></div>'.repeat(5)}</div><div class="sk sk-chart"></div><div class="sk sk-table"></div></div>`;
}

const VERDICT = {
  approve: { label: 'Approve', icon: 'ph-check-circle', cls: 'ok' },
  conditions: { label: 'Approve with conditions', icon: 'ph-warning', cls: 'warn' },
  restructure: { label: 'Restructure', icon: 'ph-x-circle', cls: 'bad' },
} as const;

function renderResults(r: Report) {
  const results = document.querySelector<HTMLElement>('#results')!;
  const v = VERDICT[r.verdict];
  const b = r.base;
  const p = r.pricing;
  const attr = [...r.attribution.factors].sort((a, c) => c.share - a.share);

  results.innerHTML = `
  <section class="summary" aria-labelledby="deal-title">
    <p class="caption">Credit analysis</p>
    <h1 id="deal-title">${esc(r.deal.name)}</h1>
    <p class="verdict ${v.cls}"><i class="ph ${v.icon}" aria-hidden="true"></i><span><strong>${v.label}.</strong> ${esc(r.headline)}</span></p>
    <dl class="stats">
      <div><dt title="Share of simulated markets in which the lender does not get all its money back">Probability of loss</dt><dd>${fmt.pct(b.probLoss)}<span class="sub">±${fmt.pct(p.probLossCi)} · VaR 99% ${fmt.pct(b.var99LossPct)}</span></dd></div>
      <div><dt title="Expected loss divided by the loan's average life; the rating compares it with an idealised expected-loss table">Expected loss</dt><dd>${fmt.pct(p.annualExpectedLoss, 2)}<span class="sub">a year · ≈ ${esc(p.equivalentRating)}${p.ratingCapped ? ' (tenant cap)' : ''}</span></dd></div>
      <div><dt title="Spread over the lender's cost of funds, minus the expected loss a year">Risk-adjusted margin</dt><dd>${fmt.pct(p.riskAdjustedMargin, 2)}<span class="sub">spread ${fmt.pct(p.spread, 2)} − loss</span></dd></div>
      <div><dt title="Cash flow ÷ debt service in the expected market, lowest month">Projected DSCR</dt><dd>${fmt.x(r.coverage.contract)}<span class="sub">${
        r.coverage.tail !== null ? `in contract · <strong class="${r.coverage.tail < r.deal.dscrCovenant ? 'neg' : ''}">${fmt.x(r.coverage.tail)}</strong> after if not renewed` : 'lowest during the contract'
      }</span></dd></div>
      <div><dt title="Missed payment, or covenant breach the collateral cannot cure">Events of default</dt><dd>${fmt.pct(b.probDefault)}<span class="sub">${fmt.pct(b.fullRecoveryShare, 0)} recovered in full</span></dd></div>
    </dl>
    <p class="formula">Default ${fmt.pct(b.probDefault)} × loss given default ${fmt.pct(b.lossGivenDefaultPct)} × exposure at default ${fmt.pct(b.exposureAtDefaultPct, 0)} of principal = expected loss ${fmt.pct(b.expectedLossPct, 2)} of principal over a ${p.walYears.toFixed(1)}-year average life. ${
      b.probCure > 0 ? `Another ${fmt.pct(b.probCure)} of paths breach the covenant and are cured with a full cash sweep, because the GPUs still cover the debt. ` : ''
    }${
      r.maxLtv.binding
        ? `Highest LTV keeping expected loss under 1% a year with ${esc(r.maxLtv.structure)}: ${fmt.pct(r.maxLtv.ltv, 0)}.`
        : `Expected loss stays under 1% a year up to ${fmt.pct(r.maxLtv.ltv, 0)} LTV with ${esc(r.maxLtv.structure)}.`
    }</p>
  </section>

  <section aria-labelledby="dscr-title">
    <div class="section-head"><h2 id="dscr-title">Debt service coverage, month by month</h2>
    <p class="section-sub">Median path with 50% and 90% ranges across ${b.sims.toLocaleString('en-US')} simulated markets. Defaulted loans count as zero.</p></div>
    <div class="chart" id="dscr-chart"></div>
    <div class="chart chart-small" id="default-chart"></div>
  </section>

  <section aria-labelledby="lever-title">
    <div class="section-head"><h2 id="lever-title">What fixes it</h2>
    <p class="section-sub">Each change tested on the same simulated markets. A change is financeable when the projected DSCR during the contract stays at or above the ${fmt.x(r.deal.sizingDscr)} sizing minimum.</p></div>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Change</th><th scope="col" class="num">Projected DSCR</th><th scope="col" class="num">Loss odds</th><th scope="col" class="num">Expected loss a year</th><th scope="col">Verdict</th></tr></thead>
      <tbody>${r.levers
        .map((l, i) => {
          const best = r.bestLever && l.label === r.bestLever.label;
          const alt = r.upgrade && l.label === r.upgrade.label;
          const tag = best
            ? '<span class="badge best"><i class="ph ph-star" aria-hidden="true"></i>Recommended</span>'
            : alt
              ? '<span class="badge best"><i class="ph ph-arrow-down" aria-hidden="true"></i>Smaller loan</span>'
              : !l.financeable
                ? '<span class="badge no"><i class="ph ph-prohibit" aria-hidden="true"></i>Not financeable</span>'
                : '';
          const lv = VERDICT[l.verdict];
          const verdictCell = !l.financeable ? 'n/a' : `<span class="mini-verdict ${lv.cls}"><i class="ph ${lv.icon}" aria-hidden="true"></i>${lv.label}</span>`;
          const better = i > 0 && l.financeable && l.pricing.annualExpectedLoss < p.annualExpectedLoss;
          return `<tr class="${l.financeable ? '' : 'muted-row'}"><th scope="row"><span class="lever-name">${esc(l.label)}${tag}</span><span class="lever-detail">${esc(l.detail)}</span></th><td class="num">${fmt.x(l.coverage.contract)}</td><td class="num">${fmt.pct(l.result.probLoss)}</td><td class="num ${better ? 'better' : ''}">${fmt.pct(l.pricing.annualExpectedLoss, 2)}</td><td>${verdictCell}</td></tr>`;
        })
        .join('')}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="stress-title">
    <div class="section-head"><h2 id="stress-title">Stress scenarios</h2></div>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Scenario</th><th scope="col" class="num">Loss odds</th><th scope="col" class="num">Expected loss</th></tr></thead>
      <tbody>${r.scenarios
        .map((s) => `<tr><th scope="row"><span class="lever-name">${esc(s.label)}</span><span class="lever-detail">${esc(s.description)}</span></th><td class="num">${fmt.pct(s.result.probLoss)}</td><td class="num">${fmt.pct(s.result.expectedLossPct, 2)}</td></tr>`)
        .join('')}</tbody>
    </table></div>
  </section>

  <section aria-labelledby="attr-title">
    <div class="section-head"><h2 id="attr-title">Where the expected loss comes from</h2>
    <p class="section-sub">Shapley split across five risks, plus the loss the structure takes even in the expected market. The shares add up to 100% of expected loss; a risk that slightly reduces it shows as ≈ 0%.</p></div>
    ${
      b.expectedLoss > 0
        ? `<ul class="bars">${attr
            .map(
              (f) =>
                `<li><span class="bar-label">${esc(f.factor)}</span><span class="bar-track"><span class="bar" style="--w:${Math.max(0, Math.min(1, f.share)) * 100}%"></span></span><span class="bar-value">${f.share < 0.005 ? '≈ 0%' : fmt.pct(f.share, 0)}</span></li>`,
            )
            .join('')}</ul>`
        : '<p class="empty">No simulated market produces a loss, so there is nothing to split.</p>'
    }
  </section>

  <section aria-labelledby="memo-title" class="memo">
    <div class="section-head row"><h2 id="memo-title">Credit memo draft</h2>
      <div class="actions"><button type="button" class="btn" id="copy-memo"><i class="ph ph-copy" aria-hidden="true"></i>Copy memo</button><button type="button" class="btn" id="print-memo"><i class="ph ph-printer" aria-hidden="true"></i>Print</button></div></div>
    <article>${r.memo.map((s) => `<h3>${esc(s.heading)}</h3>${s.body.map((t) => `<p>${esc(t)}</p>`).join('')}`).join('')}</article>
  </section>
  <div class="toast" role="status" aria-live="polite" hidden></div>`;

  const contractEnd = r.deal.contractTenorMonths < r.deal.tenorMonths ? r.deal.contractTenorMonths : null;
  renderDscrChart(results.querySelector('#dscr-chart')!, b.dscrQuantiles!, { covenant: r.deal.dscrCovenant, lockup: r.deal.lockupDscr, contractEnd });
  renderDefaultChart(results.querySelector('#default-chart')!, b.cumulativeDefault!, { contractEnd });

  results.querySelector('#copy-memo')!.addEventListener('click', async () => {
    const text = r.memo.map((s) => `${s.heading}\n${s.body.join('\n')}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(`${r.deal.name}\n\n${text}`);
      toast('Memo copied');
    } catch {
      toast('The browser blocked copying. Select the text instead.');
    }
  });
  results.querySelector('#print-memo')!.addEventListener('click', () => window.print());
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = document.querySelector<HTMLElement>('.toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.classList.remove('show');
    window.setTimeout(() => (t.hidden = true), 260);
  }, 4000);
}

renderShell();
run();
