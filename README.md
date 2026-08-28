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
npx prisma migrate dev
npm run dev
```

Visit the app, click **Get started**, create an account, and accept the
onboarding terms — you'll land on an empty dashboard scoped to your new
account. From there, click **Load demo batch**. It seeds your merchant and
pushes real webhook-shaped payloads through the actual `/api/webhooks/*`
routes (not internal shortcuts) to build:

- a **flagship cross-channel scenario** — two Razorpay failures, then a
  Stripe success for the same obligation, cancelling the scheduled recovery
  step and showing up as a "Recovery Action Prevented" audit entry,
- a **live in-progress case** you can click through with the dashboard's
  **Advance** control (steps the state machine forward — WAIT → re-verify →
  generate a payment link) and **Simulate paid elsewhere** control (fires
  the same cross-channel resolution path on demand),
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

## Testing

```bash
npm test        # vitest — spins up a throwaway SQLite DB per run
npm run lint
npx tsc --noEmit
```

Tests cover provider-agnostic correlation, idempotency (including that it's
scoped per merchant, not global), AI proposal + policy gating, the mandatory
pre-action verification path, and the cross-channel resolution scenario
end to end.

## Known limitations

The PRD's "real-world problems" checklist is broader than what's wired up
end to end. Guardrails for **dispute holds** and **customer opt-out** exist
in `src/lib/policy.ts` and are enforced whenever their flag is set, but
nothing currently ingests a dispute webhook or an opt-out request to set
that flag. **Partial payments** and **refunds** have schema support
(`PARTIALLY_PAID`, `REFUNDED`, `outstandingAmountPaise`) but no code path
exercises them yet — resolution today is all-or-nothing. There's no
provider-outage anomaly detection, and outbound provider/merchant API calls
aren't modeled (everything is webhook-driven), so failure handling for
those calls doesn't apply yet.
