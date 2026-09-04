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
  ref?: string; // payment link URL, email message id, etc.
  note: string; // human-readable, goes straight into the audit trail
};
