import crypto from "crypto";
import type { PaymentProviderAdapter } from "@/lib/providers/types";
import type { UniversalPaymentEvent } from "@/lib/types";
import { classifyFailure } from "@/lib/classifier";

// A representative slice of Stripe's payment_intent webhook shape.
// https://stripe.com/docs/api/payment_intents/object
type StripeEvent = {
  type: string;
  id: string;
  data: {
    object: {
      id: string; // pi_xxx
      amount: number; // Stripe amounts are already the minor unit (cents/paise)
      currency: string;
      metadata?: Record<string, string>;
      payment_method_types?: string[];
      receipt_email?: string;
      last_payment_error?: {
        code?: string;
        message?: string;
      };
    };
  };
};

// Stripe recommends duplicate handling and asynchronous processing (PRD
// §6) — same idempotency/out-of-order concerns as Razorpay, handled by the
// engine's ExternalEvent ledger rather than duplicated per-adapter.
export class StripeAdapter implements PaymentProviderAdapter {
  readonly provider = "stripe";

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return true; // no secret configured (dev/demo mode)

    const signature = headers.get("stripe-signature");
    if (!signature) return false;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return (
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    );
  }

  parseEvent(rawBody: string): StripeEvent {
    return JSON.parse(rawBody);
  }

  normalizeEvent(parsed: unknown, merchantId: string): UniversalPaymentEvent | null {
    const event = parsed as StripeEvent;
    const intent = event.data?.object;
    if (!intent) return null;

    // Same Priority-1 correlation as Razorpay, just carried in Stripe's own
    // vocabulary: PaymentIntent metadata instead of notes/receipt.
    const obligationReferenceId = intent.metadata?.obligation_id;
    if (!obligationReferenceId) return null;

    if (event.type === "payment_intent.succeeded") {
      return {
        eventType: "PAYMENT_SUCCEEDED",
        provider: "stripe",
        providerEventId: event.id,
        merchantId,
        obligationReferenceType: "ORDER",
        obligationReferenceId,
        paymentAttempt: {
          providerPaymentId: intent.id,
          amountPaise: intent.amount,
          currency: (intent.currency ?? "inr").toUpperCase(),
          paymentMethod: intent.payment_method_types?.[0],
          status: "SUCCEEDED",
        },
        customerContact: intent.receipt_email,
      };
    }

    if (event.type === "payment_intent.payment_failed") {
      const classification = classifyFailure({
        hadPaymentAttempt: true,
        errorCode: intent.last_payment_error?.code,
        errorDescription: intent.last_payment_error?.message,
      });
      return {
        eventType: "PAYMENT_FAILED",
        provider: "stripe",
        providerEventId: event.id,
        merchantId,
        obligationReferenceType: "ORDER",
        obligationReferenceId,
        paymentAttempt: {
          providerPaymentId: intent.id,
          amountPaise: intent.amount,
          currency: (intent.currency ?? "inr").toUpperCase(),
          paymentMethod: intent.payment_method_types?.[0],
          status: "FAILED",
          failureCategory: classification.failureCategory,
          failureReason: classification.note,
        },
        customerContact: intent.receipt_email,
      };
    }

    return null;
  }

  supportsRetry() {
    return false;
  }

  supportsPaymentLinks() {
    return true;
  }
}
