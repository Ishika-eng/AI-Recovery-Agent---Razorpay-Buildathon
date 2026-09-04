import type { RecoveryCaseContext, ActionType } from "@/lib/types";

// PRD Problem 37: a merchant adopting this platform is almost always
// replacing a fixed-schedule dunning rule ("payment failed → send a
// reminder → wait a day → send a link → give up"), not nothing. Claiming
// the AI/policy layer is worth adopting requires being able to show,
// concretely, where and how often it actually decides differently than
// that naive baseline would — not just asserting it's "smarter." This is
// that baseline: the same fixed schedule every case would get with no
// customer-value calibration, no payment-method-lifecycle awareness, and
// no provider-outage detection. It is never executed — only ever recorded
// alongside the real decision (see runRecoveryCycle in engine.ts) so the
// two can be compared after the fact.
export function decideNaiveBaseline(context: RecoveryCaseContext): { action: ActionType; reason: string } {
  const { obligation, recoveryHistory } = context;

  if (obligation.status === "PAID") {
    return { action: "STOP_RECOVERY", reason: "Obligation already paid." };
  }

  if (recoveryHistory.messagesSent === 0) {
    return { action: "SEND_REMINDER", reason: "Fixed schedule: first touch is always a reminder." };
  }

  if (recoveryHistory.messagesSent === 1) {
    return { action: "GENERATE_PAYMENT_LINK", reason: "Fixed schedule: second touch is always a payment link." };
  }

  return { action: "ESCALATE_TO_HUMAN", reason: "Fixed schedule: give up after two automated touches." };
}
