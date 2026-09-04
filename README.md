# Universal AI Payment Recovery & Reconciliation Platform

Built for Razorpay Buildathon.

A provider-agnostic, **obligation-centric** payment recovery platform. Most
failed-payment tools think "payment failed → recover payment." This one
thinks "payment attempt failed → what obligation does this belong to → is
that obligation still unpaid → has the customer already paid some other
way?" — and only acts if the answer is still no, re-verifying immediately
before every customer-facing step.

That distinction is the whole product: a customer whose Razorpay payment
fails and who then pays via Stripe (or any other channel) must never get a
reminder for money they've already paid. The platform tracks the **Payment
Obligation** ("Order #789 owes ₹5,000"), not the individual transaction —
and the moment any channel resolves it, every scheduled recovery action
against it is cancelled atomically.

## Architecture

```
Razorpay / Stripe webhooks
        │  (provider-specific payloads)
        ▼
  Provider Adapters            src/lib/providers/*.ts
        │  normalize into the Universal Payment Event Model
        ▼
  Correlation                  src/lib/engine.ts
        │  match the merchant-owned obligation reference (never amount+customer)
        ▼
  Payment Obligation / Attempt  prisma schema
        │
        ▼
  Recovery Cycle (per obligation, re-run on every trigger)
        │  1. VERIFY obligation status fresh — stop if already PAID
        │  2. AI proposes one action from an allowed set    src/lib/ai.ts
        │  3. Policy Engine gates it — guardrails always win  src/lib/policy.ts
        │  4. Execute (or park for merchant approval)        src/lib/engine.ts
        ▼
  Cross-channel resolution
        any provider success, or a merchant/external push (/api/webhooks/external),
        atomically cancels scheduled actions + closes the case + logs why
```

Merchant-side data (orders, customers) goes through the same pattern via a
`MerchantAdapter` (`src/lib/merchants/`) — the recovery engine never assumes
a specific business vocabulary, only a normalized `ObligationContext`.

## Why it's built this way

- **Provider-agnostic**: `PaymentProviderAdapter` is one interface; Razorpay
  and Stripe adapters both normalize wildly different webhook shapes into
  the same `UniversalPaymentEvent`. Adding Adyen/Cashfree is one new file.
- **Obligation-centric, not transaction-centric**: `PaymentObligation` is
  the unit the system reasons about. `PaymentAttempt` rows accumulate under
  it from any provider; only the obligation's own status can declare
  "resolved."
- **Mandatory pre-action verification**: every recovery cycle re-reads the
  obligation's live status before proposing or executing anything — a
  stale AI decision, delayed success webhook, or duplicate delivery can
  never push a paid obligation through a customer-facing action.
- **AI proposes, Policy decides**: the AI layer (`src/lib/ai.ts`) returns a
  structured `{action, reason}` from a fixed action set — it cannot execute
  anything itself. The Policy Engine (`src/lib/policy.ts`) is deterministic
  and enforces per-merchant guardrails (retry caps, message caps, minimum
  contact gap, contact-window hours, dispute holds, opt-outs, an
  auto-approve amount ceiling) that nothing downstream can bypass.
- **Idempotent by construction**: every inbound provider event is recorded
  in an `ExternalEvent` ledger keyed on `(merchantId, provider,
  providerEventId)` before it's acted on — retried webhook deliveries
  (which providers explicitly document) are a no-op, not a second recovery
  cycle, and two merchants' provider accounts can't collide with each other.

See `src/lib/engine.ts` for the full recovery-cycle orchestration, or
[`docs/architecture.html`](docs/architecture.html) for a diagrammed walkthrough
of the request flow, the data model, and the auth/tenancy gate.

## Product access

This isn't a single-tenant demo — it's multi-tenant behind real
authentication:

- **Landing page** (`/`) — public marketing page; no data is shown here.
- **Sign up / Sign in** (`/signup`, `/login`) — email + password, hashed
  with bcrypt. Sessions are stateless signed JWT cookies
  (`src/lib/session.ts`), verified on every request through a Data Access
  Layer (`src/lib/dal.ts`) per Next.js's own authentication guidance.
- **Onboarding** (`/onboarding`) — a new merchant must explicitly accept
  what the agent is authorized to do (retry caps, contact windows, approval
  thresholds) before the dashboard becomes reachable.
- **Dashboard** (`/dashboard`) — gated twice: `src/proxy.ts` (the
  Next.js 16 replacement for `middleware.ts`) does an optimistic
  cookie-only redirect for unauthenticated requests, and the page itself
  re-verifies the session and terms-acceptance server-side before querying
  any data.
- Every merchant-scoped API route (approve/reject an action, advance a
  case, seed demo data) checks both that a session exists **and** that the
  resource being acted on actually belongs to that session's merchant —
  not just that *some* merchant is logged in.

## Stack

- Next.js (App Router) + TypeScript
- Prisma + SQLite (swap `DATABASE_URL` for Postgres in production)
- Razorpay SDK (test mode) + webhook signature verification
- bcryptjs + jose for authentication (no external auth provider required)

## Getting started

```bash
npm install
cp .env.example .env
# then set SESSION_SECRET in .env — see the comment in .env.example for
# a one-liner to generate one. DATABASE_URL already points at a local
# SQLite file; everything else in .env.example is optional.
npx prisma migrate dev
npm run dev
```

In a second terminal, start the scheduler — without it, `WAIT` and
`SCHEDULE_FOLLOW_UP` cases only ever advance when a webhook happens to
arrive or someone clicks **Advance** by hand:

```bash
npm run scheduler
```

Visit the app, click **Get started**, create an account, and accept the
onboarding terms — you'll land on an empty dashboard scoped to your new
account. From there, click **Load demo batch**. It seeds your merchant and
pushes real webhook-shaped payloads through the actual `/api/webhooks/*`
routes (not internal shortcuts) to build:

- a **flagship cross-channel scenario** — two Razorpay failures, then a
  Stripe success for the same obligation, cancelling the scheduled recovery
  step and showing up as a "Recovery Action Prevented" audit entry,
- a **live in-progress case** — with `npm run scheduler` running, watch it
  advance on its own (WAIT → re-verify → generate a payment link) with no
  clicks at all, or force it forward immediately with the dashboard's
  **Advance** control. **Simulate paid elsewhere** fires the cross-channel
  resolution path on demand,
- a **high-value case** parked in the approval queue (above the
  auto-approve ceiling),
- a bulk batch of ordinary failures across both providers for volume.

To wire up real test-mode events instead of the synthetic batch, set
`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` (and
`STRIPE_WEBHOOK_SECRET`, if used) in `.env` and point provider webhooks at
the URLs shown on your dashboard — `/api/webhooks/razorpay?merchant=<your
id>` and `/api/webhooks/stripe?merchant=<your id>`. A merchant, or any
provider without a dedicated adapter yet, can report an out-of-band payment
via `POST /api/webhooks/external?merchant=<your id>`.

## Autonomous scheduling

Next.js route handlers only run in response to a request — nothing runs on
a timer by itself. Without something calling `/api/cron/tick` on a
schedule, a case sitting in `WAITING` with nobody watching the dashboard
and no new webhook arriving would never advance, which is most of what
this agent exists to do (recovering the "customer might pay if nudged"
middle ground, not just the cases someone happens to be watching).

- **Locally**: `npm run scheduler` polls `/api/cron/tick` every 15s
  (`scripts/tick-loop.mjs`).
- **In production**: `vercel.json` registers the same route as a Vercel
  Cron job (every 5 minutes); Vercel automatically sends
  `Authorization: Bearer $CRON_SECRET` when that env var is set. Any other
  scheduler (GitHub Actions, plain cron) works the same way — `POST` or
  `GET` the route with that header.

`processDueCases()` (`src/lib/engine.ts`) finds every `WAITING` case whose
`nextActionAt` has passed, across every merchant, and re-runs the recovery
cycle for each — except a case already sitting in the approval queue, which
it explicitly skips rather than risk re-proposing on top of an unresolved
human decision.

## Real customer contact (the Action Adapter Layer)

Deciding to nudge a customer only matters if the nudge actually reaches
them. `src/lib/actions/` is what turns a decided action into a real
external effect instead of a log line:

- **`GENERATE_PAYMENT_LINK` / `OFFER_ALTERNATIVE_PAYMENT_METHOD`** create a
  real Razorpay Payment Link via the `razorpay` SDK
  (`src/lib/actions/paymentLink.ts`), using the `RAZORPAY_KEY_ID` /
  `RAZORPAY_KEY_SECRET` already in `.env`. The link carries
  `notes.obligation_id` and `reference_id`, so when a customer actually
  pays it, the resulting `payment.captured` / `payment_link.paid` webhook
  correlates straight back to the obligation through the same Priority-1
  path every other event uses — no special case.
- **`SEND_REMINDER`** sends a real email through whatever SMTP account is
  configured (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`
  in `.env`) via `src/lib/actions/email.ts`, when the obligation's contact
  looks like an email address.
- **When a real channel is used, the engine stops guessing.** The
  probabilistic "did they pay" simulation only ever runs when
  `deliverAction()` reports `simulated: true` — no keys configured, no SMTP
  configured, or a phone-number-only contact with no email channel to use.
  Once a real payment link exists, resolution comes from an actual webhook,
  the same as any other channel, never a coin flip.
- Every `RecoveryAction` now records `deliveryChannel` and `deliveryRef` —
  the real payment link URL or email message id, when there is one.

Leave the Razorpay keys and SMTP vars blank and the platform behaves
exactly as it did before — fully demoable with zero external credentials.
Fill them in and the same decision loop starts having real-world effects.

## Terminal states — closing a case, not just escalating it

Escalation (`ESCALATE_TO_HUMAN`) puts a case in the approval queue, which
is a real human decision point. But before, nothing actually *closed* a
case — rejecting one proposed action just left it `ESCALATED` again, so a
stuck case could sit there indefinitely with no way to mark it done.

**Write off** (`src/lib/engine.ts` `writeOffObligation`, the "Write off"
button on any active case) is that missing terminal state: a deliberate,
human decision to stop pursuing an obligation, distinct from
`resolveObligation()` (money actually arrived) and `STOP_RECOVERY` (the AI
proposed pausing — not the same as a person giving up on it). It sets the
obligation and case to `CANCELLED`, cancels anything still pending, and is
idempotent — write-off never overrides a real resolution that already
landed, and calling it twice doesn't double-log. Written-off obligations
show up in the dashboard's "Recently closed" section alongside actual
payments, with a distinct "Written off" badge, and correctly drag down
(rather than inflate) the recovery-rate stat.

## Attribution — proving the AI actually caused a recovery

"₹ recovered" is an easy number to overclaim: an obligation resolving after
a recovery case exists doesn't mean the recovery *caused* it — the customer
might have paid regardless. Before this, every `RecoveryAction` had a
`recoveredPaise` field that only ever got set in the simulated demo path;
a real, webhook-driven resolution never credited anything.

Now, when `createPaymentLink()` (`src/lib/actions/paymentLink.ts`) makes a
real Razorpay Payment Link, its durable id is stored on the
`RecoveryAction.deliveryRef` that generated it. When Razorpay's
`payment_link.paid` webhook later arrives carrying that same id,
`resolveObligation()` credits that *specific* action — not "the obligation
got paid, somehow." Any other resolution (a customer retrying normally, a
cross-channel payment, `resolveExternalPayment`) still resolves the
obligation exactly as before, but is honestly logged as unattributed.

The dashboard shows both numbers side by side: **₹ recovered** (every
obligation currently `PAID`) and **Attributed to AI action** (the strictly
smaller subset actually traced back to something this platform did) — the
gap between them is itself an honest, useful number.

**Known gap**: `SEND_REMINDER` has no durable, trackable reference the way
a payment link does, so a recovery that followed a reminder (rather than a
generated link) can't be rigorously attributed yet — it resolves correctly,
just without credit.

## Refunds and chargebacks reverse the metrics, not just the money

A payment already counted as recovered can still come back — a refund or a
chargeback. Razorpay's `payment.refunded` / Stripe's `charge.refunded` now
correlate to the obligation the same way disputes do (through the refunded
payment's provider id against the `PaymentAttempt` already on record, since
a refund payload doesn't carry the merchant's own reference either). A full
refund flips the obligation to `REFUNDED` — which removes it from "₹
recovered" and "Attributed to AI action" automatically, since both are
computed from obligations currently `PAID` — and a partial refund reduces
the recovered total without changing status. Deliberately does **not**
auto-restart recovery: a refund is usually a deliberate business decision
(a return, a cancellation), not something to re-chase. `RecoveryAction`
history is never rewritten — the historical fact "this action caused a
₹5,000 payment" stays true even after a later refund; the dashboard nets it
out going forward instead.

## Partial payment and overpayment — resolution isn't all-or-nothing

A payment doesn't have to match what's owed exactly. `resolveObligation()`
now compares the amount actually paid against `outstandingAmountPaise` and
branches three ways:

- **Less than owed** — the obligation moves to `PARTIALLY_PAID`,
  `outstandingAmountPaise` shrinks by the paid amount, and the recovery
  case stays open (never auto-closed) so the platform keeps chasing the
  remainder. A follow-up payment for the rest resolves it normally.
- **Exactly what's owed** — resolves as before.
- **More than owed** — still fully resolves (`PAID`,
  `outstandingAmountPaise: 0`), but the excess is recorded on
  `excessPaidAmountPaise` and logged as `OVERPAYMENT_DETECTED` for human
  review — never silently folded into "₹ recovered." Attribution, when
  present, still only credits the action for what was actually owed, not
  the excess.

Both `PAYMENT_SUCCEEDED` webhooks (via a real amount on the payment) and
`resolveExternalPayment()` (an optional `amountPaise` argument, also
exposed on `POST /api/webhooks/external`) support this — a bank transfer
or other externally-reported payment can be partial too. The dashboard
flags any resolved obligation with excess paid via an amber "Overpaid by
₹X" badge next to its resolution source.

## Payment-method lifecycle — a dead card isn't the same failure as a busy one

Not every failure means "try again later." A card that has expired can
never clear, no matter how many times it's retried or how long the
platform waits — but before this, `classifyFailure()` folded that into the
same `ISSUER_DECLINE` bucket as a temporary decline, and the AI responded
identically to both: generate a fresh payment link and hope. A payment
link still defaults back to the same saved card, so that "fix" was really
just a slower way of doing nothing.

`EXPIRED_CARD` is now its own failure category (checked before the generic
decline/gateway patterns, so it wins on overlap), and the AI layer treats
it as a genuinely different problem:

- It skips straight to `OFFER_ALTERNATIVE_PAYMENT_METHOD` — explicitly
  asking for a different instrument — rather than `GENERATE_PAYMENT_LINK`,
  and skips any wait window entirely, since nothing about time changes an
  expired card's outcome.
- On a `SUBSCRIPTION` obligation specifically, an expired card isn't a
  one-off failure — the identical charge will fail again on every future
  renewal until the card is replaced. After one automated attempt, this
  escalates to a human immediately rather than working through the
  customer-value-scaled message budget that a normal case gets, since more
  automated attempts against a dead instrument only delay a failure that
  automation can't fix.

**Known gap**: provider adapters currently hardcode `obligationReferenceType`
to `"ORDER"` on every webhook (see `src/lib/providers/razorpay.ts` and
`stripe.ts`) — they don't yet read back the merchant's own reference type
from the provider payload. This means an obligation actually stored as
`SUBSCRIPTION` won't correlate through a real webhook unless queried by an
`ORDER`-typed reference, so the subscription-specific fast-escalation path
above is fully covered by unit tests (`tests/ai.test.ts`) but not yet
exercised by a live Razorpay/Stripe webhook end to end.

## Provider-outage detection — a systemic failure isn't this customer's problem

A timeout or gateway error from a single obligation's point of view looks
exactly like "try again shortly," which is what the AI already does for a
transient failure. But if the *same* provider produces that *same*
transient failure across several *different* obligations within a short
window at once, that isn't several independent card problems — it's the
provider itself being down, and nudging each affected customer ("please
retry") is actively misleading when nothing on their end is wrong.

`detectProviderOutage()` (`src/lib/outage.ts`) checks, per provider, per
merchant: how many *distinct* obligations hit a transient failure
(`TIMEOUT`, `NETWORK_ERROR`, or `GATEWAY_ERROR`) on that provider in the
last 15 minutes. At 3+ distinct obligations, an outage is suspected, and
`runRecoveryCycle` threads that into the AI's context as `providerHealth`.
The AI then:

- **Waits twice as long** as the usual customer-value-calibrated window
  before doing anything customer-facing, instead of retrying on the normal
  schedule.
- **Escalates to a human** rather than waiting a second time or contacting
  the customer, if the suspected outage is still ongoing after that
  extended wait — automation shouldn't hold a case in limbo forever.
- **Never suppresses a genuine instrument problem** — a hard decline or an
  expired card is handled exactly as it would be otherwise, regardless of
  what else is happening to the provider, since that failure has nothing
  to do with the provider's health.

The dashboard surfaces this as an amber banner ("Possible provider outage
detected...") whenever a recent AI decision cited a suspected outage,
rather than leaving it buried in the audit trail.

## AI vs. rules — proving the calibration layer earns its complexity

A merchant adopting this platform is almost always replacing a fixed-
schedule dunning rule ("payment failed → reminder → wait a day → link →
give up"), not nothing. Claiming the AI/policy layer is worth it needs to
be demonstrable, not just asserted — so `decideNaiveBaseline()`
(`src/lib/baseline.ts`) is exactly that fixed schedule, with none of the
customer-value calibration, payment-method-lifecycle awareness, or
provider-outage detection described above. It is **never executed** —
every real AI decision also records what this baseline would have done
instead (`RecoveryAction.baselineAction`), purely for comparison.

The dashboard's "AI vs. a fixed-schedule rule" section shows the
divergence rate (what fraction of decisions the AI made differently than
the naive rule would have) and a breakdown of exactly what changed — e.g.
"Rule would SEND_REMINDER — AI instead WAIT" when a failure looks
transient, or "Rule would GENERATE_PAYMENT_LINK — AI instead
OFFER_ALTERNATIVE_PAYMENT_METHOD" on an expired card. A 0% divergence rate
would be an honest signal the calibration isn't earning its keep; this
makes that claim checkable instead of asserted.

## Suspected-fraud detection — card testing isn't a struggling customer

A genuine customer fails a payment once, maybe twice — a wrong CVV, an
expired card, a bank decline. Five or more distinct payment attempts
against the *same* obligation within 10 minutes looks like something
else: card testing, someone iterating through stolen card numbers
against a single order to find one that clears.

`detectSuspiciousVelocity()` (`src/lib/fraud.ts`) checks this on every
recovery cycle, the same way outage detection does — not just at
ingestion. Once the threshold is crossed, the case's `riskLevel` becomes
`FRAUD_SUSPECTED`, every pending action is blocked, and the Policy Engine
now refuses *everything* customer-facing for that case (mirroring how an
active dispute is handled) — because generating another payment link for
a case under card testing would just hand the attacker more attempts. It
takes an explicit human review to move the case forward again. The
dashboard flags this with a red "Suspected fraud" badge next to the case
status.

## Testing

```bash
npm test        # vitest — spins up a throwaway SQLite DB per run
npm run lint
npx tsc --noEmit
```

Tests cover provider-agnostic correlation, idempotency (including that it's
scoped per merchant, not global), AI proposal + policy gating, the mandatory
pre-action verification path, and the cross-channel resolution scenario
end to end. The two cross-obligation detectors (provider-outage,
suspected-fraud) are tested at their exact trigger boundary (one below
threshold vs. at threshold), not just an obvious "clearly not" case — and
outage detection specifically has a test proving one merchant's failures
can't trigger a false outage flag on a different merchant sharing the
same provider.

Three further edge cases are covered, one of which turned up a real bug:

- **Negative/zero-amount payments.** `UniversalPaymentEvent`'s zod schema
  declares `amountPaise` positive, but provider adapters build that object
  as a plain TypeScript literal that's never actually run through
  `.parse()` — so a malformed provider payload could reach
  `resolveObligation` with a zero or negative amount. It's now guarded
  explicitly: a non-positive amount is logged as `INVALID_PAYMENT_AMOUNT`
  and the obligation is left untouched, rather than silently reducing (or
  worse, *increasing*) the outstanding balance.
- **Two payments racing for the same obligation.** Writing this test
  (`Promise.all` of two concurrent successful payments for one
  obligation) actually caught a real, pre-existing TOCTOU race in
  `resolveObligation`: both calls could read `status != PAID` before
  either had written, and both would proceed to resolve — double-crediting
  attribution and writing two `OBLIGATION_RESOLVED` audit entries for a
  single payment. Confirmed with 8 consecutive failing runs before the
  fix, then 15 consecutive clean runs after it. Fixed with an optimistic
  concurrency guard: the status-changing update is now conditioned on the
  status still matching what was originally read (`updateMany` with a
  `status` filter, checked via the affected row count) — the loser of the
  race backs off and returns the current state instead of repeating the
  resolution side effects.
- **Both detectors firing on the same obligation at once.** A case that's
  simultaneously part of a suspected provider outage *and* over the fraud
  velocity threshold is blocked on fraud grounds — the Policy Engine's
  `FRAUD_SUSPECTED` check is unconditional, so it wins regardless of what
  the AI's own (outage-driven) reasoning says. Neither signal is silently
  dropped from the audit trail; only the blocking decision is decided in
  fraud's favor.

## Known limitations

The PRD's "real-world problems" checklist is broader than what's wired up
end to end. **Refunds**, **partial payments/overpayment**, **payment-
method lifecycle** (expired cards), **provider-outage detection**,
**AI-vs-rules defensibility metrics**, and **suspected-fraud detection**
are now handled (see "Refunds and chargebacks", "Partial payment and
overpayment", "Payment-method lifecycle", "Provider-outage detection",
"AI vs. rules", and "Suspected-fraud detection" above — the payment-
method lifecycle section has one known gap around subscription
correlation, noted there). The fraud signal is deliberately narrow
(rapid repeated attempts on one obligation) — it doesn't model stolen-
card reuse across different obligations/customers, since no card
fingerprint is captured anywhere in this system. Outbound
provider/merchant API calls aren't modeled (everything is webhook-
driven), so failure handling for those calls doesn't apply yet.

**Dispute holds** and **customer opt-out** are no longer guardrails
without a trigger:

- A **dispute/chargeback** (Razorpay `payment.dispute.created`, Stripe
  `charge.dispute.created`) correlates through the disputed payment's
  provider id — looked up against the `PaymentAttempt` already recorded for
  it, since a dispute payload doesn't carry the merchant's own obligation
  reference the way a payment event does (see `handleDisputeOpened` in
  `src/lib/engine.ts`). It sets `riskLevel: DISPUTE_ACTIVE`, escalates the
  case, and cancels anything still pending — the Policy Engine's existing
  dispute guardrail now has something that actually sets it.
- **Customer opt-out** has two real triggers: every real email this
  platform sends carries a working, signed unsubscribe link
  (`src/app/api/optout/route.ts`, no login required — the link itself is
  the credential), and a merchant can mark a case opted-out by hand from
  the dashboard for a customer who said so on a call. Either one sets
  `contactOptedOut`, which the Policy Engine already enforced — it just had
  nothing to check before.

**Customer-value calibration** (`src/lib/ai.ts`): `RecoveryCaseContext`'s
customer-value tier (derived from prior successful payments — see
`GenericEcommerceAdapter.getCustomerContext`) now actually changes the
decision, not just the reasoning text. A HIGH-value, long-tenured customer
gets a longer wait before the first nudge (30 min vs. 2 min for a brand-new
one — more patience for a relationship worth protecting) and escalates to a
human after just one unanswered automated attempt instead of three. This is
still a two-lever calibration (wait duration, escalation threshold), not a
full re-weighting of every decision — the choice *between* SEND_REMINDER /
GENERATE_PAYMENT_LINK / OFFER_ALTERNATIVE_PAYMENT_METHOD is still driven
purely by failure category, and the Policy Engine's amount ceiling remains
the only thing sensitive to the payment's absolute size.

Real delivery (see "Real customer contact" above) covers payment links and
email. There's still no SMS/WhatsApp channel, so a customer whose only
contact on file is a phone number can't currently be reached for a plain
`SEND_REMINDER` — a real Razorpay Payment Link's own `notify.sms` will
still text them when a phone number was provided at creation, but the
platform doesn't yet send its own SMS/WhatsApp messages independently of
that.
