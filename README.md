# Halflife — credit risk for AI infrastructure debt

Prototype of a underwriting and stress-testing engine for loans backed by GPUs and data centers.
A lender enters the deal terms; Halflife simulates thousands of correlated market paths and returns
the probability of loss, expected loss, covenant breaches, named stress scenarios, where the loss
comes from, which structuring levers fix it, and a draft credit memo.

**Live demo:** https://mcardon436-byte.github.io/halflife/ — click "Play demo" for a narrated two-minute walkthrough.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Tests: `npm test` (or `npx vitest run`). Production build: `npm run build`
(static files in `dist/`, deployable to any static host — Vercel, Netlify, Cloudflare Pages).

## What the model does

- Monthly Monte Carlo (2,000 paths). One random stream per path with a fixed number of draws, so every
  scenario, structuring lever and attribution run sees the same markets (common random numbers).
- GPU rental price: mean-reverting log process around a declining trend, plus random new-generation shocks.
- Wholesale power: mean-reverting log process with spikes, lightly correlated with GPU prices.
- Anchor tenant: default hazard from its rating, higher when the contract is above the spot price
  (wrong-way risk); re-letting gap after a default; renewal at expiry at the spot price of the day,
  likelier when the market is tight; otherwise capacity goes merchant.
- Loan: straight-line or front-loaded amortisation, balloon, sponsor-funded reserve, cash sweep,
  quarterly DSCR tests with a cash lock-up and an event of default after two failed tests.
- Recovery: workout period with interest accruing, the lender collecting operating cash, legal costs,
  then a forced sale at a discount that widens when GPU prices have fallen.
- Outputs: probability of loss, default probability (PD × LGD × EAD = expected loss), annual expected loss,
  risk-adjusted margin and equivalent rating, projected DSCR at closing, five stress scenarios,
  a Shapley split of expected loss across risks (adds up to 100%), structuring levers flagged
  "not financeable" when the projected DSCR breaks the lock-up, and a draft credit memo.

Market parameters are illustrative, anchored on public 2026 indices (H100 rental around $1.70–2.63/GPU-hour,
wholesale power $70–137/MWh). They must be calibrated on real data before any credit decision.

## Demo script (about 90 seconds)

1. **Neocloud, startup tenant.** A $42M loan at 70% LTV against 2,000 H100s, 36 months, anchored by an
   unrated AI startup on a 24-month contract. The projected DSCR at closing is a comfortable 1.59x —
   what a spreadsheet shows. Halflife shows what the spreadsheet misses: coverage falls to 0.57x after
   month 24 if the tenant does not renew, and the loan loses money in about 1 in 4 simulated markets,
   mostly when the tenant stops paying. Expected loss about 2.4% a year, comparable to a B credit.
   Verdict: restructure.
2. **What fixes it.** Cutting the tenor to the contract would be safer but is flagged "not financeable"
   (DSCR 1.15x under the 1.30x sizing minimum). Front-loading amortisation into the contract with a
   100% cash sweep keeps the loan size, brings the loss odds to about 1 in 22 and moves the verdict to
   "approve with conditions". Fixing the power price changes nothing: power is a small cost for a neocloud.
3. **Where the loss comes from.** The Shapley split shows tenant credit at roughly three quarters of
   expected loss and GPU rental prices at about a fifth.
4. **GPU lease, hyperscaler tenant.** A 36-month AA lease matching the loan, power passed through: approve.
5. Copy the credit memo: the committee draft writes itself.

All figures come from the illustrative market parameters and change with them.

## Files

- `src/engine/` — simulation (`simulate.ts`), scenarios / attribution / max LTV (`analysis.ts`),
  report and memo (`report.ts`), defaults (`defaults.ts`), tests (`simulate.test.ts`).
- `src/main.ts`, `src/chart.ts`, `src/style.css` — interface (design tokens in `src/tokens.css`).
- `src/worker.ts` — runs simulations off the main thread.
