// Every delivery attempt — a real payment link created, a real email sent,
// or a graceful fallback because a channel isn't configured — reports back
// in this shape. `simulated: false` is a claim the caller can act on: don't
// guess whether the customer paid, wait for the webhook that channel will
// eventually produce. `simulated: true` means nothing actually reached the
// customer, so the engine falls back to its existing probabilistic demo
// outcome instead of pretending a real one is pending.
export type DeliveryResult = {
  channel: "razorpay_payment_link" | "email" | "simulated" | "not_configured";
  simulated: boolean;
  // The durable identifier for this delivery — a Razorpay payment link id,
  // an email message id, etc. This is what makes attribution possible: when
  // a payment_link.paid webhook later arrives carrying this same id,
  // engine.ts can credit the specific RecoveryAction that generated it,
  // instead of just noting "the obligation got paid somehow."
  ref?: string;
  // The actual URL/address handed to the customer, when there is one —
  // separate from `ref` because a payment link's durable id and its
  // customer-facing short URL are two different strings.
  customerUrl?: string;
  note: string; // human-readable, goes straight into the audit trail
};
