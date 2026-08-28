import type { RecoveryCaseContext, AIDecision } from "@/lib/types";

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
      reason: "Failure indicates the instrument itself won't clear on retry — offering a fresh payment link for an alternate method.",
    });
  }

  // First failure, looks transient, customer has a track record: give the
  // payment a short window to land on its own (e.g. a delayed
  // payment.captured per PRD §15) before doing anything customer-facing.
  if (!recoveryHistory.waitedAlready && recoveryHistory.messagesSent === 0 && transientFailure) {
    return propose({
      action: "WAIT",
      waitMinutes: 2,
      reason: `First failure (${lastFailure?.failureCategory}) looks transient for a ${customer.customerValue.toLowerCase()}-value, ${customer.relationshipAgeDays}-day customer — waiting briefly in case the payment settles on retry before contacting them.`,
    });
  }

  // We've already waited and it's still unpaid: prompt the customer
  // directly instead of waiting again.
  if (recoveryHistory.waitedAlready && recoveryHistory.messagesSent === 0) {
    return propose({
      action: "GENERATE_PAYMENT_LINK",
      reason: "Wait window elapsed with no successful payment — generating a payment link and nudging the customer to complete it.",
    });
  }

  if (recoveryHistory.messagesSent === 1) {
    return propose({
      action: "SCHEDULE_FOLLOW_UP",
      reason: "One reminder already sent with no response yet — scheduling a follow-up rather than messaging again immediately.",
    });
  }

  if (recoveryHistory.messagesSent >= 2) {
    return propose({
      action: "ESCALATE_TO_HUMAN",
      reason: "Multiple reminders sent without resolution — handing this off to the merchant rather than continuing to message the customer.",
    });
  }

  return propose({
    action: "SEND_REMINDER",
    reason: `Outstanding balance ₹${(obligation.outstandingAmountPaise / 100).toFixed(2)} with no recent contact — sending a reminder.`,
  });
}
