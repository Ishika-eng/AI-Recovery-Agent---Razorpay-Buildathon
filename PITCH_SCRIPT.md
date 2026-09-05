# Pitch video script — Universal Payment Recovery & Reconciliation

Target length: **under 5:00**. Every section below is trimmed to a real
word-count budget for that timing — read it at a natural pace (roughly
150 words/minute) and it lands under the line with a few seconds to
spare. This is recordable in one continuous take by switching between
three already-open browser tabs.

---

## Before you hit record — setup checklist

Do all of this *before* you start recording, so the take is a clean
switch-tab-and-talk with no dead air:

1. **Tab 1 — the intro card.** Open your published intro page
   (`https://claude.ai/code/artifact/41347b72-b2d6-4e04-b0e8-7c9305201384`)
   and leave it ready to go full-screen.
2. **Tab 2 — the architecture doc.** Open `docs/architecture.html` from
   your project folder directly in a browser tab (drag the file in, or
   `open docs/architecture.html` from the project root). It's local, not
   deployed on Vercel.
3. **Tab 3 — the live app.** Sign in to a merchant account, click **Load
   demo batch**, and confirm before recording that:
   - the outage banner is showing,
   - the **approval queue** has at least one case citing "exceeds the
     auto-approve ceiling" *and* at least one citing an escalation —
     reload the batch if you only have one type,
   - there's an untouched case in **Active recovery cases** for the
     "Simulate paid elsewhere" moment.
4. **Rehearse the tab order once**, unrecorded: Tab 1 → Tab 2 → Tab 3,
   then the in-app switch from Overview to History. Know exactly which
   click or shortcut gets you there instantly.
5. Full-screen your browser — hide bookmarks, other tabs, notifications.

Once that's true, hit record and don't stop until the close.

---

## 1. The intro card (0:00–0:55)

**[Tab 1 — the intro card, full-screen. One beat of silence before you
start talking.]**

> Track the obligation. Not the transaction.
>
> Five different situations get one identical response from most payment
> recovery tools: a customer pays elsewhere, a card is expired, a
> provider goes down, a payment lands short, someone's testing a stolen
> card. A single-step retry loop can't tell any of them apart.
>
> [point at the stats row] Twenty to forty percent of subscription churn
> is involuntary — not customers leaving, a failed payment nobody
> recovered. About nine percent of monthly recurring revenue is lost this
> way. And fifty to eighty-five percent of it is recoverable, if the
> recovery logic actually understands why the payment failed.
>
> That nine percent isn't lost revenue. It's earned revenue, sitting
> behind a retry loop that never learned why the payment actually failed.
>
> Let me show you how this platform knows the difference.

**[Switch to Tab 2 now.]**

---

## 2. Architecture, briefly (0:55–1:30)

**[Tab 2 — architecture.html. One continuous slow scroll through all four
diagrams while you say this.]**

> Thirty seconds on how this works — every box here is a real file, not
> an aspirational diagram. Every provider webhook normalizes into one
> shape, then the AI proposes one action from a fixed set, a separate
> deterministic Policy Engine gates it, and only then does anything
> execute — the AI can't bypass that or invent its own action. It's built
> around obligations, not transactions, which is what makes cross-channel
> resolution and partial payments representable at all. And it's
> deployed for real — Vercel, a real Postgres database, a real Razorpay
> integration tested end to end. Let's see it live.

**[Switch to Tab 3 now.]**

---

## 3. Live demo (1:30–4:05)

### 3a. Overview — the proof it's real (1:30–2:00)

**[Tab 3 — the live dashboard, Overview tab, already loaded with demo
data.]**

> This is the live, deployed app — every number here is computed from a
> real database right now.

**[Point at the outage banner.]**

> This banner isn't scripted — the demo batch genuinely crossed a real
> failure threshold, so the platform is holding off contacting anyone
> until it clears.

**[Point at the "AI vs. Fixed Rules" tile.]**

> And this tile is the falsifiable one: how often the calibrated AI
> genuinely chose differently than a naive fixed-schedule rule would
> have. A zero here would be an honest signal the AI isn't earning its
> complexity.

### 3b. Approval queue — two different guardrails (2:00–2:40)

**[Scroll to the approval queue. Point at the case citing the auto-approve
ceiling.]**

> Two cases here, two different guardrails. This one's held because its
> amount exceeds the auto-approve ceiling — a human has to sign off
> before it executes. That's the deterministic Policy Engine, live, not a
> diagram.

**[Click Approve. Point at the ₹ Recovered / Recovery Rate tiles
changing.]**

> And there — recovered and recovery rate just moved, from the action I
> just approved.

**[Point at the escalation-type case.]**

> This other one's held for a completely different reason — an outright
> escalation, independent of amount. Every customer-facing action gets
> checked against several independent guardrails, not just one.

### 3c. The flagship cross-channel moment (2:40–3:15)

**[Scroll to Active recovery cases. Click "Simulate paid elsewhere" on an
untouched case.]**

> Now the scenario this whole platform is built around — a customer
> paying through a completely different channel than the one that just
> failed them. Watch — that case just disappeared from active recovery.

**[Switch to the History tab. Point straight at the
RECOVERY_ACTION_PREVENTED entry.]**

> And here's the receipt: it explicitly logged that it *cancelled* a
> reminder already scheduled, because the customer had paid elsewhere. A
> naive retry-loop tool would have messaged them anyway, with no record
> of why that was wrong.

### 3d. It's really deployed (3:15–3:35)

**[Switch to the Setup tab. Point at the webhook URLs.]**

> One more thing — these are the real webhook URLs Razorpay and Stripe
> hit in production. I've tested that loop end to end too: a real
> Razorpay payment link, a real webhook, signature-verified, resolving
> the obligation for real.

---

## 4. Why it's trustworthy, not just automated (3:35–4:25)

**[Stay on Tab 3, talking-head style is fine here too.]**

> What matters most here: where the AI is, and where it deliberately
> isn't. The decision layer is a deterministic rules engine today, not an
> LLM call — documented, not hidden — and it's benchmarked live against a
> naive fixed-schedule baseline, diverging on the vast majority of
> decisions right now. That's the honest, falsifiable version of "the AI
> adds value," not a slide claiming it.
>
> Where a real LLM *is* wired in is customer-facing text — the voice
> script, the reminder tone — genuinely something an LLM is good at that
> a template isn't. Even there, it never touches the money-critical
> facts — those are always inserted by code, never generated.
>
> And nothing here is a black box — every proposal, every policy verdict,
> every execution writes to an audit log a merchant can actually read.

---

## 5. Close (4:25–4:50)

> One modeling decision — track the obligation, not the transaction — and
> everything else follows: cross-channel resolution, partial payments,
> dead cards, provider outages, card testing, all at once.
>
> It's live on Vercel right now, against a real Postgres database, with a
> real Razorpay integration verified end to end, a hundred and eighteen
> passing tests, and an honest account of every real bug found along the
> way and exactly how it got fixed. Thanks for watching.

---

## Notes for recording

- **This is already the trimmed cut** — don't add material back in
  without removing something else, or you'll go back over 5:00.
- **Don't read this word-for-word.** Internalize each beat and say it in
  your own words — especially section 1, where you're narrating text the
  viewer can also read for themselves.
- **The live numbers will differ from any example above** — that's the
  point. Describe what you genuinely see when you record, don't chase a
  specific figure.
- **Practice the tab switches** (Tab 1→2 at ~0:55, Tab 2→3 at ~1:30, plus
  the in-app Overview→History→Setup switches in section 3) a couple of
  times unrecorded first — a smooth switch mid-sentence reads as
  confident; a fumbled one is the most likely reason to want a retake.
- **If you still run long**, the safest cut is 3d (the webhook-URLs beat)
  — fold its one real claim ("I've tested the real webhook loop end to
  end") into a single clause inside section 4 instead. Don't cut section
  4 itself, or the approval-queue/cross-channel beats in 3b/3c — those are
  the most differentiating material for judges.
- **Want the fuller ~8-minute version back** — the one that walks every
  tab (Insights included) in full detail — just ask; it's easy to
  regenerate from this session.
