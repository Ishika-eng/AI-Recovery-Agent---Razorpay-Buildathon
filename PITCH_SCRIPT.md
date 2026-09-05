# Pitch video script — Universal Payment Recovery & Reconciliation

Target length: ~5 minutes. Timestamps are approximate — pace to what feels
natural when you actually say it out loud, don't rush to hit a number.

Record the demo screen capture first (steps in brackets), then narrate over
it, or narrate live while screen-recording — whichever you're more
comfortable delivering without sounding read-off-a-page.

---

## 1. Cold open + the problem (0:00–0:50)

**[Screen: cold open directly on the app — no title card, no talking-head
intro. Have a case already sitting in "Active recovery cases" before you
hit record. Click "Simulate paid elsewhere" as the very first thing the
viewer sees.]**

> [as the case vanishes from the list] Watch that. A customer whose
> payment just failed on Razorpay... paid anyway, through a completely
> different channel. And the system didn't send them another reminder.
>
> [switch to the History tab, point at the RECOVERY_ACTION_PREVENTED entry]
> It cancelled one that was already scheduled. Most payment recovery tools
> would've messaged this person anyway — because most of them don't
> actually know that happened.

**[Cut to you on camera, or stay on the app — your call.]**

> Here's why that's harder than it sounds. Most failed-payment recovery
> tools think in one step: payment failed, retry the payment. That breaks
> constantly. The customer above paid through a different provider than
> the one that failed. Somewhere else, a card is simply expired — no
> amount of retrying will ever clear it. A provider itself goes down, and
> every "declined" in that window looks like the customer's fault when
> it's not. A payment lands for less than what was owed. And somewhere,
> the same card is being retried five times in ten minutes — that's not a
> struggling customer, that's someone testing a stolen one.
>
> Five real situations, and a single-step retry loop can't tell any of
> them apart. This platform is built around one idea that represents all
> five at once: track the **payment obligation** — "Order #789 owes
> ₹5,000" — not the individual transaction. Let me show you the rest of
> it.

---

## 2. Live demo (0:50–3:20)

**[Screen: navigate to the signed-up dashboard, or sign up live if you want
the full flow on camera. Click "Load demo batch."]**

> Let me show you, not just tell you.
>
> [as data loads] This just seeded a batch of realistic failures across
> Razorpay and Stripe — card declines, timeouts, a UPI mandate failure, an
> overdue invoice, an abandoned checkout. Nothing here is staged after the
> fact — everything you're about to see is the platform reacting to this
> data live.

**[Point at the outage banner if one appears, or trigger it by loading a
big enough batch.]**

> See this banner — "possible provider outage detected." That's not
> scripted. The bulk failure batch genuinely crossed a real threshold: this
> many transient failures on one provider in this short a window looks
> like the provider's problem, not the customer's — so the platform is
> holding off contacting anyone until it clears, instead of blasting
> confused customers with "please retry" messages that would be wrong.

**[Scroll to the approval queue. Pick the highest-value case.]**

> This case is above the auto-approve ceiling, so it's sitting here for a
> human — me — to sign off on, not executing on its own. That's a real
> guardrail, not a suggestion: the deterministic Policy Engine sits between
> every AI proposal and execution, and it cannot be bypassed regardless of
> how confident the AI is.

**[Click Approve. Point at the ₹ Recovered / Recovery Rate tiles moving.]**

> And there it is — ₹ recovered and the recovery rate just moved, live,
> from a real action I just approved.

**[Click "Simulate paid elsewhere" on any active case.]**

> This is the flagship scenario: a customer paying through a completely
> different channel than the one that just failed them. Watch what
> happens — [pause] — that case just disappeared from active recovery, and
> if you check the audit trail —

**[Switch to History tab, point at a RECOVERY_ACTION_PREVENTED entry.]**

> — it explicitly logged that it *cancelled* a scheduled reminder instead
> of sending it, because the customer had already paid elsewhere. A naive
> retry-loop tool would have messaged them anyway.

**[Optional, if you have time and it's set up: show the real Razorpay
payment link / webhook proof — screenshot or live click-through of
approving a case, showing the real rzp.io link, and the obligation
resolving.]**

> And this isn't simulated end to end either — this specific case just
> created a real Razorpay test-mode payment link, and when it's paid, a
> real webhook comes back to this app, gets signature-verified, and
> resolves the obligation. I've tested this exact loop live with real test
> payments, not just mocked data.

---

## 3. Why it's trustworthy, not just automated (3:20–4:35)

**[Screen: stay on dashboard, or switch to code / architecture.html if you
want a visual.]**

> Here's the part that actually matters for a platform that touches money:
> where the AI is, and where it deliberately isn't.
>
> The decision layer — "what should we do next for this case" — is a
> deterministic rules engine today, not an LLM call. That's not a
> limitation I'm hiding; it's a deliberate choice, and it's documented in
> the code. Every decision it makes is also compared against a naive,
> fixed-schedule baseline — no customer-value calibration, no outage
> awareness — and the dashboard shows the live divergence rate. Right now
> it's diverging on the vast majority of decisions, which is the honest,
> falsifiable version of "the AI is adding value," not a slide claiming it.
>
> Where a real LLM *is* wired in is customer-facing text — the Hinglish
> voice-call script, the reminder email tone. That's a task an LLM is
> genuinely good at that a template structurally can't do — adapting to
> who the customer is. And even there, the model never touches the
> money-critical facts: the amount, the payment link, the unsubscribe line
> are always inserted by code, never generated.
>
> And nothing here is a black box. Every AI proposal, every policy
> decision, every execution gets written to an audit log a merchant can
> actually read — not a debug log.

---

## 4. Close (4:35–5:00)

> This started from one modeling decision — track the obligation, not the
> transaction — and everything else falls out of getting that right:
> cross-channel resolution, partial payments, dead cards, provider
> outages, card testing, all representable at once.
>
> It's live on Vercel right now, running against a real Postgres database,
> with a real Razorpay integration I've verified end to end, 118 passing
> tests, and an honest account — in the README — of every real bug found
> along the way and exactly how it got fixed. Thanks for watching.

---

## Notes for recording

- If you're short on time, cut the "real Razorpay webhook" bullet in
  section 2 rather than rushing through the trust section in 3 — the
  policy-engine/audit-trail story is the more differentiating point for
  judges than proving the plumbing works.
- Don't read this word-for-word on camera — say it in your own words once
  you've internalized the beats. A slightly rougher, clearly-genuine
  delivery reads better than a stiff recitation.
- The exact numbers you'll see live (₹ recovered, divergence %) will differ
  from any example above since they're computed live from real DB state —
  that's the point, don't worry about matching a specific number.
