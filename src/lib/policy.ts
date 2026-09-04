import type { ActionType } from "@/lib/types";

export type PolicyVerdict = {
  result: "ALLOWED" | "BLOCKED" | "REQUIRES_APPROVAL";
  reasoning: string;
};

export type PolicyContext = {
  obligationStatus: string; // freshly re-read at decision time — see engine.ts VERIFY_OBLIGATION_STATUS
  outstandingAmountPaise: number;
  contactOptedOut: boolean;
  riskLevel: "STANDARD" | "HIGH_VALUE" | "DISPUTE_ACTIVE" | "FRAUD_SUSPECTED";
  messagesSentToday: number; // across the merchant, not just this case — avoids over-messaging at scale
  messagesSentThisCase: number;
  retryCount: number;
  hourOfDay: number;
  lastActionAt: Date | null;
  merchant: {
    maxAutoRetries: number;
    maxMessagesPerCase: number;
    minMessageGapHours: number;
    autoApproveUnderPaise: number;
    contactWindowStartHour: number;
    contactWindowEndHour: number;
  };
};

const CUSTOMER_FACING_ACTIONS: ActionType[] = [
  "SEND_REMINDER",
  "GENERATE_PAYMENT_LINK",
  "OFFER_ALTERNATIVE_PAYMENT_METHOD",
  // A recommended voice call is still customer contact, even though this
  // platform doesn't place the call itself — opt-out and DND-window
  // guardrails apply to it exactly the same as an automated message.
  "RECOMMEND_VOICE_OUTREACH",
];

// The Policy Engine (PRD §19) is deterministic and sits between the AI's
// proposal and execution. It cannot be bypassed — every action, however the
// AI arrived at it, is re-checked here before anything customer-facing or
// state-changing happens.
export function evaluatePolicy(action: ActionType, ctx: PolicyContext): PolicyVerdict {
  // Mandatory pre-action verification (PRD §15) — this must be the very
  // first check. A stale AI decision, a delayed success event, or a
  // duplicate webhook must never push an already-resolved obligation
  // through a customer-facing action.
  if (ctx.obligationStatus === "PAID") {
    return { result: "BLOCKED", reasoning: "Obligation status re-checked immediately before action: already PAID. Recovery must stop." };
  }
  if (ctx.obligationStatus === "CANCELLED" || ctx.obligationStatus === "EXPIRED" || ctx.obligationStatus === "REFUNDED") {
    return { result: "BLOCKED", reasoning: `Obligation status is ${ctx.obligationStatus} — no recovery action applies.` };
  }

  if (ctx.riskLevel === "DISPUTE_ACTIVE") {
    return { result: "BLOCKED", reasoning: "An active dispute/chargeback is open on this obligation — automated recovery must stop; the AI must not pressure a customer mid-dispute." };
  }

  if (ctx.riskLevel === "FRAUD_SUSPECTED") {
    return { result: "BLOCKED", reasoning: "Suspected fraud (rapid repeated failed payment attempts against this obligation) — automated recovery must stop; generating another payment link would only give an attacker more attempts. A human must review before anything further happens." };
  }

  if (action === "STOP_RECOVERY" || action === "WAIT" || action === "VERIFY_PAYMENT" || action === "RECORD_PROMISE_TO_PAY") {
    return { result: "ALLOWED", reasoning: "Non-customer-facing action with no guardrail implications." };
  }

  if (CUSTOMER_FACING_ACTIONS.includes(action)) {
    if (ctx.contactOptedOut) {
      return { result: "BLOCKED", reasoning: "Customer has opted out of contact — all automated communication stops." };
    }
    if (ctx.messagesSentThisCase >= ctx.merchant.maxMessagesPerCase) {
      return { result: "BLOCKED", reasoning: `Case message cap reached (${ctx.messagesSentThisCase}/${ctx.merchant.maxMessagesPerCase}) — escalate instead of messaging again.` };
    }
    if (
      ctx.lastActionAt &&
      Date.now() - ctx.lastActionAt.getTime() < ctx.merchant.minMessageGapHours * 3_600_000
    ) {
      const hoursLeft = (
        ctx.merchant.minMessageGapHours - (Date.now() - ctx.lastActionAt.getTime()) / 3_600_000
      ).toFixed(1);
      return { result: "BLOCKED", reasoning: `Minimum message gap (${ctx.merchant.minMessageGapHours}h) not yet elapsed — ${hoursLeft}h remaining before another customer-facing action is allowed.` };
    }
    if (ctx.hourOfDay < ctx.merchant.contactWindowStartHour || ctx.hourOfDay >= ctx.merchant.contactWindowEndHour) {
      return { result: "BLOCKED", reasoning: `Outside the configured contact window (${ctx.merchant.contactWindowStartHour}:00–${ctx.merchant.contactWindowEndHour}:00) — holding to avoid violating DND rules.` };
    }
  }

  if (action === "GENERATE_PAYMENT_LINK" && ctx.retryCount >= ctx.merchant.maxAutoRetries) {
    return { result: "REQUIRES_APPROVAL", reasoning: `Recovery-link cap reached (${ctx.retryCount}/${ctx.merchant.maxAutoRetries} attempts) — a human should review before another is generated.` };
  }

  if (action === "ESCALATE_TO_HUMAN") {
    // Escalation only means something if a human actually sees it.
    return { result: "REQUIRES_APPROVAL", reasoning: "Escalations always require merchant review, independent of amount." };
  }

  if (action === "RECOMMEND_VOICE_OUTREACH") {
    // A phone call is a bigger commitment than an automated message —
    // a human should decide whether to actually place it, not have this
    // platform silently mark it done.
    return { result: "REQUIRES_APPROVAL", reasoning: "A recommended voice call always requires merchant review — a human decides whether to actually place it." };
  }

  if (ctx.riskLevel === "HIGH_VALUE" || ctx.outstandingAmountPaise > ctx.merchant.autoApproveUnderPaise) {
    return { result: "REQUIRES_APPROVAL", reasoning: `Outstanding amount ₹${(ctx.outstandingAmountPaise / 100).toFixed(2)} exceeds the auto-approve ceiling — requires merchant sign-off before executing.` };
  }

  return { result: "ALLOWED", reasoning: "Within all configured guardrails — safe to execute automatically." };
}
