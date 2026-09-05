import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { POST as razorpayWebhook } from "@/app/api/webhooks/razorpay/route";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { createObligation } from "@/lib/engine";
import { createMerchant, resetDb } from "./helpers";

function webhookRequest(url: string, body: unknown) {
  return new NextRequest(url, { method: "POST", body: JSON.stringify(body) });
}

function razorpayPayload(paymentId: string, obligationReferenceId: string) {
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: `order_${paymentId}`,
          receipt: obligationReferenceId,
          amount: 100000,
          currency: "INR",
          error_code: "GATEWAY_TIMEOUT",
          error_description: "Request timed out",
        },
      },
    },
  };
}

function stripePayload(intentId: string, obligationReferenceId: string) {
  return {
    id: `evt_${intentId}`,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: intentId,
        amount: 100000,
        currency: "inr",
        metadata: { obligation_id: obligationReferenceId },
        last_payment_error: { code: "card_declined", message: "Card was declined by the issuing bank" },
      },
    },
  };
}

beforeEach(async () => {
  await resetDb();
});

describe("POST /api/webhooks/razorpay", () => {
  it("rejects a webhook with no merchant query param", async () => {
    const res = await razorpayWebhook(webhookRequest("http://localhost/api/webhooks/razorpay", { event: "order.paid", payload: {} }));
    expect(res.status).toBe(400);
  });

  it("ignores events that aren't payment.failed / payment.captured", async () => {
    const merchant = await createMerchant();
    const res = await razorpayWebhook(
      webhookRequest(`http://localhost/api/webhooks/razorpay?merchant=${merchant.id}`, { event: "order.paid", payload: {} })
    );
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(await db.paymentAttempt.count()).toBe(0);
  });

  it("normalizes a payment.failed event into a PaymentAttempt against the correlated obligation", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WH_1", amountPaise: 100000 });

    const res = await razorpayWebhook(
      webhookRequest(`http://localhost/api/webhooks/razorpay?merchant=${merchant.id}`, razorpayPayload("pay_abc", obligation.referenceId))
    );
    const json = await res.json();
    expect(json.status).toBe("processed");
    expect(await db.paymentAttempt.count()).toBe(1);
  });

  it("does not double-process a retried webhook delivery for the same provider event id", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WH_DUP", amountPaise: 100000 });
    const url = `http://localhost/api/webhooks/razorpay?merchant=${merchant.id}`;

    await razorpayWebhook(webhookRequest(url, razorpayPayload("pay_dup", obligation.referenceId)));
    const secondRes = await razorpayWebhook(webhookRequest(url, razorpayPayload("pay_dup", obligation.referenceId)));
    const secondJson = await secondRes.json();

    expect(secondJson.status).toBe("duplicate");
    expect(await db.paymentAttempt.count()).toBe(1);
  });

  it("scopes idempotency per merchant, so two merchants can independently report the same provider event id", async () => {
    const merchantA = await createMerchant();
    const merchantB = await createMerchant();
    await createObligation({ merchantId: merchantA.id, referenceType: "ORDER", referenceId: "ORDER_SHARED", amountPaise: 100000 });
    await createObligation({ merchantId: merchantB.id, referenceType: "ORDER", referenceId: "ORDER_SHARED", amountPaise: 100000 });

    const resA = await razorpayWebhook(
      webhookRequest(`http://localhost/api/webhooks/razorpay?merchant=${merchantA.id}`, razorpayPayload("pay_shared", "ORDER_SHARED"))
    );
    const resB = await razorpayWebhook(
      webhookRequest(`http://localhost/api/webhooks/razorpay?merchant=${merchantB.id}`, razorpayPayload("pay_shared", "ORDER_SHARED"))
    );

    expect((await resA.json()).status).toBe("processed");
    expect((await resB.json()).status).toBe("processed");
  });

  it("normalizes a refund.processed event into a refund on the correlated payment (not the non-existent 'payment.refunded')", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_REFUND_1", amountPaise: 100000 });
    const url = `http://localhost/api/webhooks/razorpay?merchant=${merchant.id}`;

    await razorpayWebhook(
      webhookRequest(url, {
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_refund_1", order_id: "order_pay_refund_1", receipt: obligation.referenceId, amount: 100000, currency: "INR" } } },
      })
    );

    const res = await razorpayWebhook(
      webhookRequest(url, {
        event: "refund.processed",
        payload: {
          refund: { entity: { id: "rfnd_1", payment_id: "pay_refund_1", amount: 100000, currency: "INR" } },
          payment: { entity: { id: "pay_refund_1", amount: 100000, amount_refunded: 100000, currency: "INR" } },
        },
      })
    );
    const json = await res.json();
    expect(json.result).toBe("refund_issued");

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("REFUNDED");
    expect(updated.refundedAmountPaise).toBe(100000);
  });
});

describe("POST /api/webhooks/stripe", () => {
  it("normalizes a completely different payload shape into the same PaymentAttempt model", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_STRIPE_1", amountPaise: 100000 });

    const res = await stripeWebhook(
      webhookRequest(`http://localhost/api/webhooks/stripe?merchant=${merchant.id}`, stripePayload("pi_abc", obligation.referenceId))
    );
    const json = await res.json();
    expect(json.status).toBe("processed");

    const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { obligationId: obligation.id } });
    expect(attempt.provider).toBe("stripe");
    expect(attempt.failureCategory).toBe("ISSUER_DECLINE");
  });
});
