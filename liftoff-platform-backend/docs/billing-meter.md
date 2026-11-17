# Billing — the single Operating-Unit meter

> The rule is INV-PB-002 in invariants.md.
> The hard rules are docs/invariants.md. This file holds the detail.

## Billing — ONE Stripe meter exists; never invent more

There is exactly ONE Stripe meter in the Liftoff billing model: **`operating_unit_consumed`**. That meter is the only thing that ever becomes an invoice line item, for any cost source the platform incurs.

**What this means in practice:**

- Tenants pay in Operating Units. Never in vendor-specific units like "Composio calls", "LLM tokens", "web search queries", "embedding requests", "Anthropic dollars", etc. Those are inputs; OUs are the only output.
- Every cost source — LLM, web tools, Composio, embeddings, infra, ANY new source — funnels through the same boundary: `ingestEventWithBuckets` → OU drain across buckets (`included → precommit → reload`).
- A Stripe meter event fires once per customer-chargeable drain, with `event_name: 'operating_unit_consumed'`. The meter doesn't know or care which source caused the drain.

> **The meter is TELEMETRY, not a charge.** Its price is **$0.00**
> (`price_YOUR_STRIPE_ID`). The model is fully prepaid: `included` and
> `precommit` are covered by the base monthly fee — `included_ous ×
> included_rate` equals it to the cent on all three plans — and `reload` drains
> the customer's prepaid wallet. Money reaches Stripe through **subscription
> line items and wallet top-up invoices**, never through the meter dimension
> (see BILLING_RECONCILIATION.md). A
> priced meter bills a second time for consumption already paid for.
>
> **There is no `post_pay` bucket.** The `cost_bucket` CHECK allows
> only `included`, `precommit`, `reload`, `platform_overhead`,
> `byok_customer_funded` (migration 412), `x402_wallet_funded` (migration 440),
> `unknown`. `post_pay` is a billing *mode* on `billing_controls`, and every
> account runs the `pre_pay` default; a wallet that goes negative suspends the
> account rather than accruing post-paid usage.
>
> The two FUNDING buckets say whose money paid the VENDOR, and they charge in
> opposite directions: `byok_customer_funded` rows (the customer's own
> provider key paid) carry `customer_cost_usd = 0` and drain nothing, while
> `x402_wallet_funded` rows (the platform x402 wallet paid a per-call USDC
> micropayment — gloria premium, google_trends, browserbase_x402, kadec0)
> charge REAL Operating Units through `applyOuConsumption` exactly like the
> plain customer path, written as one row per call with `usage_quantity = 1`,
> `usage_unit = 'call'` so on-chain reconciliation can count calls and sum
> `cost_usd` against the wallet's settled USDC. Their ingestion path is the
> usage-ledger poll (`connector_call` events), which is also where their OU
> meter event fires — they have no real-time subscriber sibling.

> **The prepaid floor.** The drain suspends an account the moment
> a charge takes its reload balance below zero, but spend reaches the balance
> late (LLM tokens and sandbox time through the two-minute ingest run), and a
> run in flight keeps spending until its next admission check. So the served
> entitlement snapshot's `billing_suspended` is the STOP signal, not the stored
> flag alone: a pre-pay account past its allowance (included + precommit +
> referral bonus consumed) with a reload balance under `PREPAID_SPEND_FLOOR_USD`
> (default $2) reads as suspended, and every admission gate refuses new work.
> With auto-reload on, the account's floor is the lower of that and its
> threshold (`accountFloorUsd`): the drain is the only auto-reload
> trigger, so a workspace stopped at $2 with a $1 threshold would never reload.
> Every drain caller, ingester included, fires the claim post-commit. A
> workspace that spends a whole reload inside the drain's five-minute cooldown
> stops with no claim and makes no further charge, so `billing/auto-reload-sweep.ts`
> (every ingest interval, in-process, atomic claim under `FOR UPDATE SKIP LOCKED`)
> fires the reload for any pre-pay account past its allowance and at or under
> its threshold once the cooldown has passed. It skips a declined card
> (`auto_reload_failed`, retried on card attach), a fraud hold and every other
> suspension except `zero_prepaid_balance`.
> One predicate, `billing/prepaid-floor.ts`, is read by the snapshot queries and
> by `execution-guard`, so they cannot disagree. A crossing of zero or of the
> floor is published post-commit (`billing-suspension-publisher.ts`) as a
> republished snapshot for every tenant under the account, so the runtime hears
> in seconds rather than at its next refresh; so are the payment-failed,
> recovery, top-up and admin unsuspend paths.

**Hard rule when designing or reviewing any cost / billing / metering code or plan:**

- NEVER propose a new Stripe meter (`composio_calls_consumed`, `llm_tokens_consumed`, anything per-vendor).
- NEVER propose a new Pub/Sub topic whose job is metering a single vendor.
- NEVER propose a new subscriber whose job is firing a per-vendor `meter_events.create()`.
- NEVER phrase work as "Stripe meter for Composio" / "meter the LLM calls" / "fire a vendor meter". The meter is for OUs.

When a gap exists like "X cost reaches `ingestEventWithBuckets` but no meter fires for the overage portion", the fix is ALWAYS ~20 lines inline next to the existing `ingestEventWithBuckets` call that fires `event_name: 'operating_unit_consumed'` with the post-pay OU number. Reuse the spend-subscriber pattern. Lift into a shared `fireOuOverageMeter` helper if the same fragment now lives in 2+ places. No new meter. No new topic. No new subscriber.

**Canonical references in the codebase:**
- `src/billing/spend-subscriber.ts` — the reference implementation of OU drain + meter fire.
- `src/cost-attribution/repository.ts` (`ingestEventWithBuckets`) — the single cost-source boundary. (This was previously listed as `src/billing/ou-ingester.ts`, which does not exist.)
- `src/cost-attribution/composio-pricing.ts` — example of a per-source pricing constant feeding the boundary.

If you find yourself about to write the word "meter" outside of `operating_unit_consumed`, stop and re-read this section.


## The one exception: `billing_controls.billing_exempt`

`billing_exempt` (migration 333) marks an account that **never produces a Stripe
charge or a meter event**. It exists so the operator's own internal and test
accounts exercise the real system without being invoiced.

It is applied at exactly two points, both of which are where money leaves the
building — and nowhere else:

| Where | What is skipped |
|---|---|
| `billing/threshold-charge-service.ts` | the charge call. The threshold still **advances** — exempt counts as settled — so no `outstanding_balance_usd` accrues, no payment can fail, and nothing suspends. The would-have-charged amount is logged. |
| the `operating_unit_consumed` fire | `billing/spend-subscriber.ts` (LLM real-time path) and `cost-attribution/repository.ts ingestEventWithBuckets` (every other source, including the web-tool subscriber which delegates there). |

Everything upstream is untouched, and this is the point: OU buckets drain,
`cost_attribution_events` and `billing_spend_events` rows are written,
`current_period_spend_usd` accumulates, and the dashboards show real
consumption. Only the Stripe invoice line never appears.

**It is not an execution exemption.** `billing/execution-guard.ts` does not read
the flag: `billing_controls.suspended` still stops an exempt account dead,
because the operator hard stop has to work on every account without exception.
Admission is likewise unaffected — an exempt tenant passes the same gate a
paying one does, which is the whole reason an internal account is worth running.

**How it gets set.** Seeded from `accounts.is_internal` (migration 334), and
seeded again on INSERT by every writer that can create a `billing_controls`
row. It is never reset on conflict, so an exemption an operator sets by hand
(contractor, design partner, staff on a personal address) survives a re-init.
`src/billing/__tests__/billing-controls-insert-sites.test.ts` fails the build if
a new insert site appears without it.

**The gate is the flag, never the absence of a `stripe_customer_id`.** An exempt
account has a real subscription and a real Stripe customer; that is what makes
its metering realistic.
