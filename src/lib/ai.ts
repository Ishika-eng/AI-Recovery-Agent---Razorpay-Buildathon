import type { RecoveryCaseContext, AIDecision } from "@/lib/types";

// Calibration by customer value — this is what "decide the best next action
// ... calibrated to who this customer is" actually means in code. Before
// this, customerValue was gathered into context and only ever printed into
// a reasoning string; it never changed which action got picked. Now it
// sets two real levers:
//
// - How long to wait before the first nudge. A new/low-value customer is
//   still mid-purchase-intent — nudge them fast. A long-tenured, high-value
//   customer isn't going anywhere; pinging them within minutes reads as
//   robotic, not helpful, so they get more patience.
// - How many automated touches happen before a human gets involved. A
//   high-value relationship is worth a human's attention quickly rather
//   than risking over-automating it; a low-value, low-relationship case can
//   absorb more automated attempts before that cost is justified.
const WAIT_MINUTES_BY_VALUE: Record<RecoveryCaseContext["customer"]["customerValue"], number> = {
  LOW: 2,
  STANDARD: 10,
  HIGH: 30,
};

const ESCALATE_AFTER_MESSAGES: Record<RecoveryCaseContext["customer"]["customerValue"], number> = {
  LOW: 3,
  STANDARD: 2,
  HIGH: 1,
};

// The AI Recovery decision layer (PRD §18). It receives a structured,
// pre-normalized RecoveryCaseContext — never a raw provider payload — and
// must return a structured decision picked from `allowedActions` only. It
// never executes anything itself; the Policy Engine (src/lib/policy.ts) has
// the final word on whether the proposal is allowed to run.
//
// This implementation is a deterministic, transparent stand-in for an LLM
// call: same input shape, same output contract (AIDecision), same
// "propose, don't execute" boundary. Swapping in a real model means
// replacing the body of this function — nothing else in the pipeline
// changes, because the contract is already the seam.
export function decideRecoveryAction(context: RecoveryCaseContext): AIDecision {
  const { obligation, customer, paymentHistory, recoveryHistory, allowedActions } = context;

  const propose = (decision: AIDecision): AIDecision => {
    if (allowedActions.includes(decision.action)) return decision;
    return { action: "ESCALATE_TO_HUMAN", reason: "Preferred action is outside the allowed set for this case." };
  };

  if (obligation.status === "PAID") {
    return propose({ action: "STOP_RECOVERY", reason: "Obligation is already paid — nothing left to recover." });
  }

  const waitMinutes = WAIT_MINUTES_BY_VALUE[customer.customerValue];
  const escalateAfter = ESCALATE_AFTER_MESSAGES[customer.customerValue];
  const customerDescriptor = `${customer.customerValue.toLowerCase()}-value, ${customer.relationshipAgeDays}-day customer (${customer.successfulPayments} prior successful payment${customer.successfulPayments === 1 ? "" : "s"})`;

  const lastFailure = paymentHistory[paymentHistory.length - 1];
  const transientFailure =
    lastFailure?.failureCategory === "TIMEOUT" ||
    lastFailure?.failureCategory === "NETWORK_ERROR" ||
    lastFailure?.failureCategory === "GATEWAY_ERROR";

  // Hard decline / insufficient funds: retrying the same instrument won't
  // help, so go straight to offering a different one — no point waiting.
  const hardDecline = paymentHistory.some(
    (a) => a.failureCategory === "ISSUER_DECLINE" || a.failureCategory === "INSUFFICIENT_FUNDS"
  );
  if (hardDecline && recoveryHistory.messagesSent === 0) {
    return propose({
      action: "GENERATE_PAYMENT_LINK",
      reason: `Failure indicates the instrument itself won't clear on retry — offering a fresh payment link for an alternate method to a ${customerDescriptor}.`,
    });
  }

  // First failure, looks transient: give the payment a window to land on
  // its own (e.g. a delayed payment.captured per PRD §15) before doing
  // anything customer-facing. How long that window is depends on who's
  // waiting on the other end of it.
  if (!recoveryHistory.waitedAlready && recoveryHistory.messagesSent === 0 && transientFailure) {
    return propose({
      action: "WAIT",
      waitMinutes,
      reason: `First failure (${lastFailure?.failureCategory}) looks transient for a ${customerDescriptor} — waiting ${waitMinutes} minute${waitMinutes === 1 ? "" : "s"} before contacting them (${customer.customerValue === "HIGH" ? "more patience for a valuable relationship" : customer.customerValue === "LOW" ? "moving fast while purchase intent is still hot" : "a standard window"}).`,
    });
  }

  // We've already waited and it's still unpaid: prompt the customer
  // directly instead of waiting again.
  if (recoveryHistory.waitedAlready && recoveryHistory.messagesSent === 0) {
    return propose({
      action: "GENERATE_PAYMENT_LINK",
      reason: `Wait window elapsed with no successful payment — generating a payment link for a ${customerDescriptor}.`,
    });
  }

  if (recoveryHistory.messagesSent >= escalateAfter) {
    return propose({
      action: "ESCALATE_TO_HUMAN",
      reason: `${recoveryHistory.messagesSent} automated attempt${recoveryHistory.messagesSent === 1 ? "" : "s"} made for a ${customerDescriptor} — that's this tier's limit (${escalateAfter}), handing off to the merchant rather than risking ${customer.customerValue === "HIGH" ? "over-automating a valuable relationship" : "further unproductive contact"}.`,
    });
  }

  if (recoveryHistory.messagesSent >= 1) {
    return propose({
      action: "SCHEDULE_FOLLOW_UP",
      reason: `Previous attempt sent with no response yet, and this ${customerDescriptor} has room for another automated touch before escalating (limit: ${escalateAfter}) — scheduling a follow-up rather than messaging again immediately.`,
    });
  }

  return propose({
    action: "SEND_REMINDER",
    reason: `Outstanding balance ₹${(obligation.outstandingAmountPaise / 100).toFixed(2)} with no recent contact — sending a reminder to a ${customerDescriptor}.`,
  });
}
