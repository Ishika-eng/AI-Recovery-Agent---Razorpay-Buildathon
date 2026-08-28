import crypto from "crypto";
import type { PaymentProviderAdapter } from "@/lib/providers/types";
import type { UniversalPaymentEvent } from "@/lib/types";
import { classifyFailure } from "@/lib/classifier";

// Razorpay's own shape for a payment.failed / payment.captured webhook.
// https://razorpay.com/docs/webhooks/payloads/payments/
type RazorpayEvent = {
  event: string;
  payload: {
    payment: {
      entity: {
        id: string;
        order_id?: string;
        amount: number;
        currency?: string;
        method?: string;
        contact?: string;
        email?: string;
        error_code?: string;
        error_description?: string;
        notes?: Record<string, string>;
        receipt?: string;
      };
    };
  };
};

// Razorpay documents at-least-once delivery and possible out-of-order
// events (PRD §6, §20 Problem 2) — the engine, not this adapter, is
// responsible for re-verifying obligation status before acting on this.
export class RazorpayAdapter implements PaymentProviderAdapter {
  readonly provider = "razorpay";

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return true; // no secret configured (dev/demo mode)

    const signature = headers.get("x-razorpay-signature");
    if (!signature) return false;

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    return (
      expected.length === signature.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    );
  }

  parseEvent(rawBody: string): RazorpayEvent {
    return JSON.parse(rawBody);
  }

  normalizeEvent(parsed: unknown, merchantId: string): UniversalPaymentEvent | null {
    const event = parsed as RazorpayEvent;
    const entity = event.payload?.payment?.entity;
    if (!entity) return null;

    // The merchant's own obligation reference travels through Razorpay as
    // either the order receipt or a `notes.obligation_id` — Priority-1
    // correlation per PRD §17. We never fall back to amount+customer.
    const obligationReferenceId = entity.notes?.obligation_id ?? entity.receipt ?? entity.order_id;
    if (!obligationReferenceId) return null;

    if (event.event === "payment.captured") {
      return {
        eventType: "PAYMENT_SUCCEEDED",
        provider: "razorpay",
        providerEventId: `rzp_${entity.id}_captured`,
        merchantId,
        obligationReferenceType: "ORDER",
        obligationReferenceId,
        paymentAttempt: {
          providerPaymentId: entity.id,
          amountPaise: entity.amount,
          currency: entity.currency ?? "INR",
          paymentMethod: entity.method,
          status: "SUCCEEDED",
        },
        customerContact: entity.contact ?? entity.email,
      };
    }

    if (event.event === "payment.failed") {
      const classification = classifyFailure({
        hadPaymentAttempt: true,
        errorCode: entity.error_code,
        errorDescription: entity.error_description,
      });
      return {
        eventType: "PAYMENT_FAILED",
        provider: "razorpay",
        providerEventId: `rzp_${entity.id}_failed`,
        merchantId,
        obligationReferenceType: "ORDER",
        obligationReferenceId,
        paymentAttempt: {
          providerPaymentId: entity.id,
          amountPaise: entity.amount,
          currency: entity.currency ?? "INR",
          paymentMethod: entity.method,
          status: "FAILED",
          failureCategory: classification.failureCategory,
          failureReason: classification.note,
        },
        customerContact: entity.contact ?? entity.email,
      };
    }

    return null; // event type this platform doesn't act on
  }

  supportsRetry() {
    return false; // no automated retry API — recovery uses a fresh payment link instead
  }

  supportsPaymentLinks() {
    return true;
  }
}
