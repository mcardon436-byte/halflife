import type { Report } from './engine/report';

interface Step {
  caption: string | (() => string); // a function is read when the step starts, after any live change
  target?: () => Element | null;
  before?: () => void; // e.g. open a folded section or change an input
  ms: number;
}

const oneIn = (p: number) => (p <= 0 ? 'none' : p >= 0.3 ? `${Math.round(p * 10)} in 10` : `about 1 in ${Math.round(1 / p)}`);
const verdictName = (v: Report['verdict']) => (v === 'restructure' ? 'restructure' : v === 'approve' ? 'approve' : 'approve with conditions');

function row(label: string): Element | null {
  return [...document.querySelectorAll('#results tbody tr')].find((tr) => tr.querySelector('th')?.textContent?.includes(label)) ?? null;
}

function section(title: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('#deal-form .form-section')].find(
      (s) => s.querySelector('legend, summary')?.textContent?.trim().startsWith(title),
    ) ?? null
  );
}

// Folded sections the tour opens, so it can fold them back when it ends.
const opened: HTMLDetailsElement[] = [];
function unfold(title: string) {
  const s = section(title);
  if (s instanceof HTMLDetailsElement && !s.open) {
    s.open = true;
    opened.push(s);
  }
}

function setInput(key: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`#deal-form [data-key="${key}"]`);
  if (!el) return;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Plain-English description of a structuring lever for the narration (the memo's phrasing is written for bankers). */
function plainFix(deal: Report['deal'], lever: NonNullable<Report['bestLever']>): string {
  const d = lever.deal;
  const parts: string[] = [];
  if (d.frontAmortPct > deal.frontAmortPct) parts.push(`repay ${Math.round(d.frontAmortPct * 100)}% of the loan while the contract still pays`);
  if (d.cashSweepPct >= 1 && deal.cashSweepPct < 1) parts.push('send all spare cash to the lender');
  else if (d.cashSweepPct > deal.cashSweepPct) parts.push(`send ${Math.round(d.cashSweepPct * 100)}% of spare cash to the lender`);
  if (!parts.length) return lever.label.toLowerCase();
  return parts.join(', and ');
}

/** Captions are built from the live report so the narration always matches the numbers on screen. */
function steps(r: Report, getReport: () => Report | null, liveLtv: number): Step[] {
  const d = r.deal;
  const tenant = r.attribution.factors.find((f) => f.factor === 'Tenant credit')?.share ?? 0;
  const gpu = r.attribution.factors.find((f) => f.factor === 'GPU rental price')?.share ?? 0;
  const matchTenor = r.levers.find((l) => l.label.startsWith('Match tenor'));
  const best = r.bestLever;
  const loan = `$${Math.round(r.base.principal / 1e6)}M`;
  const ltvNow = Math.round(d.ltv * 100);

  const out: Step[] = [
    { caption: 'Halflife — risk models for lenders who finance AI chips.', ms: 3500 },
    // The inputs: everything a lender can enter, section by section.
    { caption: 'A lender starts from an example deal, or enters their own.', target: () => document.querySelector('.panel-head'), ms: 4500 },
    {
      caption: 'The deal: number of GPUs, cost per GPU, loan-to-value, interest rate and loan length.',
      target: () => section('The deal'),
      ms: 6000,
    },
    {
      caption: "The customer: how much capacity it has under contract, at what price, for how long, and how creditworthy it is.",
      target: () => section('Anchor tenant'),
      ms: 6500,
    },
    {
      caption: "Loan structure: repayment profile, balloon, cash lock-up and default covenants, reserve, cash sweep and the lender's cost of funds.",
      before: () => unfold('Loan structure'),
      target: () => section('Loan structure'),
      ms: 7500,
    },
    {
      caption: 'Tenant and site: renewal odds, wholesale power price, power billed to the tenant, site costs and GPU age.',
      before: () => unfold('Tenant and site'),
      target: () => section('Tenant and site'),
      ms: 6500,
    },
    {
      caption: 'Recovery if things go wrong: forced-sale discount, time to sell, legal costs and time to re-let the GPUs.',
      before: () => unfold('Recovery'),
      target: () => section('Recovery'),
      ms: 6500,
    },
    {
      caption: 'Hedges: buy power at a fixed price, or a put option on GPU rental prices.',
      before: () => unfold('Hedges'),
      target: () => section('Hedges'),
      ms: 5000,
    },
    {
      caption: "Market assumptions: today's GPU rental price, how fast it falls, volatility, new-chip shocks, utilisation and resale value.",
      before: () => unfold('Market assumptions'),
      target: () => section('Market assumptions'),
      ms: 7000,
    },
    // The results for the example deal.
    {
      caption: `An illustrative deal: a ${loan} loan against ${d.gpuCount.toLocaleString('en-US')} GPUs, repaid from one customer's ${d.contractTenorMonths}-month rental contract.`,
      target: () => document.querySelector('#results .summary h1'),
      ms: 6500,
    },
    {
      caption: `Today, rent covers the loan payments ${r.coverage.contract.toFixed(2)} times. On a spreadsheet, it looks safe.`,
      target: () => document.querySelectorAll('#results .stats > div')[3] ?? null,
      ms: 6000,
    },
  ];
  if (r.coverage.tail !== null) {
    out.push({
      caption: `Halflife simulates ${r.base.sims.toLocaleString('en-US')} possible GPU markets. If the customer leaves when the contract ends, rent covers only ${Math.round(r.coverage.tail * 100)}% of the payments.`,
      target: () => document.querySelector('#dscr-chart'),
      ms: 8000,
    });
  }
  out.push({
    caption: `The lender loses money in ${oneIn(r.base.probLoss)} of those markets. Verdict: ${verdictName(r.verdict)}.`,
    target: () => document.querySelector('#results .verdict'),
    ms: 6500,
  });
  if (matchTenor && !matchTenor.financeable) {
    out.push({
      caption: `The obvious fix, a shorter loan, fails: payments jump and rent covers them only ${matchTenor.coverage.contract.toFixed(2)} times — below the ${d.sizingDscr.toFixed(2)} lenders require.`,
      target: () => row('Match tenor'),
      ms: 8000,
    });
  }
  if (best) {
    out.push({
      caption: `What works: ${plainFix(d, best)}. ${best.keepsLoanSize ? 'Same loan size; losses' : 'Losses'} drop to ${oneIn(best.result.probLoss)}.`,
      target: () => row(best.label),
      ms: 9000,
    });
  }
  if (tenant > 0) {
    out.push({
      caption: `Why: ${Math.round(tenant * 100)}% of the expected loss starts with the customer defaulting; ${Math.round(gpu * 100)}% comes from falling GPU rents.`,
      target: () => document.querySelector('#results .bars'),
      ms: 7000,
    });
  }
  // A live change: every number recomputes in about a second.
  out.push(
    {
      caption: `Change any term and everything recomputes in about a second. Here, loan-to-value goes from ${ltvNow}% to ${liveLtv}%.`,
      before: () => setInput('ltv', String(liveLtv)),
      target: () => document.querySelector('#deal-form [data-key="ltv"]')?.closest('.field') ?? null,
      ms: 6000,
    },
    {
      caption: () => {
        const now = getReport();
        if (!now || Math.round(now.deal.ltv * 100) !== liveLtv) return 'The verdict and every chart update with it.';
        return `At ${liveLtv}% loan-to-value, the lender loses money in ${oneIn(now.base.probLoss)} markets. Verdict: ${verdictName(now.verdict)}.`;
      },
      target: () => document.querySelector('#results .verdict'),
      ms: 6500,
    },
    { caption: 'Then Halflife drafts the credit memo for the investment committee.', target: () => document.querySelector('#results .memo article'), ms: 5500 },
    { caption: 'Illustrative market parameters — next step: calibrate on real deals with lenders. Halflife.', ms: 5500 },
  );
  return out;
}

let running = false;

/** Plays the narrated walkthrough used for the demo video. Esc stops it. */
export function startTour(getReport: () => Report | null) {
  if (running) return;
  const r = getReport();
  if (!r) return;
  running = true;
  document.body.classList.add('touring');
  const caption = document.createElement('div');
  caption.className = 'tour-caption';
  caption.setAttribute('role', 'status');
  caption.setAttribute('aria-live', 'polite');
  document.body.appendChild(caption);

  const originalLtv = Math.round(r.deal.ltv * 100);
  const liveLtv = originalLtv > 60 ? 60 : Math.min(80, originalLtv + 10);
  const list = steps(r, getReport, liveLtv);
  let i = 0;
  let timer: number | undefined;
  let focused: Element | null = null;

  const stop = () => {
    running = false;
    window.clearTimeout(timer);
    focused?.classList.remove('tour-focus');
    caption.remove();
    document.body.classList.remove('touring');
    window.removeEventListener('keydown', onKey);
    // Put the deal back as it was before the demo.
    while (opened.length) opened.pop()!.open = false;
    const now = getReport();
    if (now && Math.round(now.deal.ltv * 100) !== originalLtv) setInput('ltv', String(originalLtv));
    document.querySelector('.panel')?.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };
  window.addEventListener('keydown', onKey);

  const show = () => {
    if (!running) return;
    if (i >= list.length) return stop();
    const s = list[i];
    focused?.classList.remove('tour-focus');
    s.before?.();
    focused = s.target?.() ?? null;
    if (focused) {
      focused.classList.add('tour-focus');
      focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (i === 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    caption.classList.remove('show');
    void caption.offsetWidth;
    caption.innerHTML = `<span>${typeof s.caption === 'function' ? s.caption() : s.caption}</span>`;
    caption.classList.add('show');
    i++;
    timer = window.setTimeout(show, s.ms);
  };
  show();
}
