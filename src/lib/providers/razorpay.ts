import crypto from "crypto";
import type { PaymentProviderAdapter } from "@/lib/providers/types";
import type { UniversalPaymentEvent } from "@/lib/types";
import { classifyFailure } from "@/lib/classifier";

// Razorpay's own shape for payment.failed / payment.captured /
// payment_link.paid webhooks.
// https://razorpay.com/docs/webhooks/payloads/payments/
// https://razorpay.com/docs/webhooks/payloads/payment-links/
type RazorpayEvent = {
  event: string;
  payload: {
    payment?: {
      entity: {
        id: string;
        order_id?: string;
        amount: number;
        amount_refunded?: number;
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
    payment_link?: {
      entity: {
        id: string;
        reference_id?: string;
        amount: number;
        amount_paid?: number;
        currency?: string;
        notes?: Record<string, string>;
        customer?: { contact?: string; email?: string };
      };
    };
    dispute?: {
      entity: {
        id: string;
        payment_id: string;
        amount: number;
        currency?: string;
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

    // Payment Links (src/lib/actions/paymentLink.ts) complete via their own
    // event, distinct from a plain order/payment flow — Razorpay recommends
    // listening to this one specifically for link completion rather than
    // relying solely on payment.captured. Same Priority-1 correlation:
    // notes.obligation_id, falling back to the link's own reference_id.
    if (event.event === "payment_link.paid") {
      const linkEntity = event.payload.payment_link?.entity;
      if (!linkEntity) return null;
      const linkObligationRef = linkEntity.notes?.obligation_id ?? linkEntity.reference_id;
      if (!linkObligationRef) return null;

      const paymentEntity = event.payload.payment?.entity;
      return {
        eventType: "PAYMENT_SUCCEEDED",
        provider: "razorpay",
        providerEventId: `rzp_${linkEntity.id}_link_paid`,
        merchantId,
        obligationReferenceType: "ORDER",
        obligationReferenceId: linkObligationRef,
        // The link's own id — lets engine.ts credit the specific
        // RecoveryAction that generated this link (attribution), instead
        // of crediting "the obligation got paid, cause unknown."
        paymentLinkId: linkEntity.id,
        paymentAttempt: {
          providerPaymentId: paymentEntity?.id ?? linkEntity.id,
          amountPaise: paymentEntity?.amount ?? linkEntity.amount_paid ?? linkEntity.amount,
          currency: linkEntity.currency ?? "INR",
          paymentMethod: paymentEntity?.method,
          status: "SUCCEEDED",
        },
        customerContact: linkEntity.customer?.contact ?? linkEntity.customer?.email,
      };
    }

    // PRD Problem 26: a payment that was already counted as recovered can
    // still be refunded or charged back — the dashboard must not keep
    // claiming that revenue forever. Same correlation pattern as disputes:
    // a refund carries the refunded payment's id, not the merchant's own
    // reference, so it's matched against the PaymentAttempt already on
    // record for it.
    if (event.event === "payment.refunded") {
      const refundedEntity = event.payload.payment?.entity;
      if (!refundedEntity) return null;
      return {
        eventType: "REFUND_ISSUED",
        provider: "razorpay",
        providerEventId: `rzp_${refundedEntity.id}_refunded_${refundedEntity.amount_refunded ?? refundedEntity.amount}`,
        merchantId,
        refundedPaymentId: refundedEntity.id,
        refundAmountPaise: refundedEntity.amount_refunded ?? refundedEntity.amount,
      };
    }

    // PRD Problem 9: a disputed payment must stop automated collection and
    // go to a human, not keep getting reminders while it's contested. A
    // dispute payload carries the disputed payment's id, not the merchant's
    // own obligation reference — engine.ts correlates it via that id
    // against the PaymentAttempt already recorded for it.
    if (event.event === "payment.dispute.created") {
      const disputeEntity = event.payload.dispute?.entity;
      if (!disputeEntity) return null;
      return {
        eventType: "DISPUTE_OPENED",
        provider: "razorpay",
        providerEventId: `rzp_${disputeEntity.id}_dispute`,
        merchantId,
        disputedPaymentId: disputeEntity.payment_id,
      };
    }

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
