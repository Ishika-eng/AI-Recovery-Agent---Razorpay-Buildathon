import type { UniversalPaymentEvent } from "@/lib/types";

// PaymentProviderAdapter — every payment provider (Razorpay, Stripe, PayPal,
// Adyen, Cashfree, ...) gets its own adapter implementing this contract. The
// core platform never depends on a provider's payload shape, delivery
// semantics, or vocabulary — only on capabilities declared here.
//
// Not every provider supports every capability (PRD §7) — `supportsRetry`
// lets the engine ask before assuming.
export interface PaymentProviderAdapter {
  readonly provider: string;

  /** Verifies the webhook signature. Returns false to reject untrusted input. */
  verifyWebhook(rawBody: string, headers: Headers): boolean;

  /** Parses a raw webhook body into this provider's own event shape. */
  parseEvent(rawBody: string): unknown;

  /**
   * Normalizes a parsed provider event into the Universal Payment Event
   * Model. Returns null for event types this platform doesn't act on
   * (e.g. a Stripe `charge.dispute.created` before dispute handling exists).
   */
  normalizeEvent(parsed: unknown, merchantId: string): UniversalPaymentEvent | null;

  supportsRetry(): boolean;
  supportsPaymentLinks(): boolean;
}
