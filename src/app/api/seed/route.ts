import crypto from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { createObligation, ingestProviderEvent } from "@/lib/engine";

// Dev-only: builds a demo merchant and a batch of obligations that exercise
// every part of the pipeline described in the PRD — two different provider
// payload shapes normalizing into the same model, the AI→Policy→Action
// loop, an approval-queue item, and the flagship cross-channel-resolution
// moment (PRD §28 Scenario 2): a customer whose Razorpay attempts keep
// failing, but who paid through another channel before the next reminder
// went out.
function razorpaySignature(rawBody: string) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return undefined;
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function razorpayFailedPayload(opts: {
  paymentId: string;
  obligationId: string;
  amountPaise: number;
  errorCode?: string;
  errorDescription?: string;
  method?: string;
  contact?: string;
}) {
  return JSON.stringify({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: opts.paymentId,
          order_id: `order_${opts.paymentId}`,
          receipt: opts.obligationId,
          amount: opts.amountPaise,
          currency: "INR",
          method: opts.method ?? "upi",
          contact: opts.contact,
          error_code: opts.errorCode,
          error_description: opts.errorDescription,
        },
      },
    },
  });
}

function stripeFailedPayload(opts: { intentId: string; obligationId: string; amountPaise: number; code?: string; message?: string }) {
  return JSON.stringify({
    id: `evt_${opts.intentId}`,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: opts.intentId,
        amount: opts.amountPaise,
        currency: "inr",
        metadata: { obligation_id: opts.obligationId },
        payment_method_types: ["card"],
        last_payment_error: { code: opts.code, message: opts.message },
      },
    },
  });
}

async function pushRazorpay(merchantId: string, body: string) {
  const headers = new Headers();
  const sig = razorpaySignature(body);
  if (sig) headers.set("x-razorpay-signature", sig);
  return ingestProviderEvent("razorpay", body, headers, merchantId);
}

async function pushStripe(merchantId: string, body: string) {
  return ingestProviderEvent("stripe", body, new Headers(), merchantId);
}

const FAILURE_SAMPLES: Array<{ errorCode?: string; errorDescription?: string; method?: string }> = [
  { errorCode: "GATEWAY_TIMEOUT", errorDescription: "Request timed out waiting on issuer response", method: "upi" },
  { errorCode: "NETWORK_ERROR", errorDescription: "Network error while connecting to issuer", method: "card" },
  { errorCode: "BAD_REQUEST_ERROR", errorDescription: "Gateway processing error", method: "netbanking" },
  { errorCode: "INSUFFICIENT_FUNDS", errorDescription: "Insufficient balance in account", method: "upi" },
  { errorCode: "CARD_DECLINED", errorDescription: "Card was declined by the issuing bank", method: "card" },
  { errorCode: "UNKNOWN_ERROR", errorDescription: "Payment could not be completed", method: "wallet" },
];

export async function POST() {
  const sessionMerchant = await getCurrentMerchant();
  if (!sessionMerchant) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  // Wide contact window so the demo isn't at the mercy of real wall-clock
  // time; the guardrail logic itself is still enforced and covered by unit
  // tests with a mocked clock.
  const merchant = await db.merchant.update({
    where: { id: sessionMerchant.id },
    data: { contactWindowStartHour: 0, contactWindowEndHour: 24 },
  });

  const created: string[] = [];
  const runId = Date.now();

  // --- Scenario 2 (the differentiator): two Razorpay failures, then the
  // customer pays through Stripe before the scheduled reminder fires.
  const flagship = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_FLAGSHIP_${runId}`,
    customerId: "cust_flagship",
    customerContact: "+919800000001",
    amountPaise: 999900,
  });
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_flagship_1_${runId}`,
      obligationId: flagship.referenceId,
      amountPaise: flagship.originalAmountPaise,
      errorCode: "GATEWAY_TIMEOUT",
      errorDescription: "Request timed out waiting on issuer response",
      contact: flagship.customerContact ?? undefined,
    })
  );
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_flagship_2_${runId}`,
      obligationId: flagship.referenceId,
      amountPaise: flagship.originalAmountPaise,
      errorCode: "GATEWAY_TIMEOUT",
      errorDescription: "Request timed out waiting on issuer response",
      contact: flagship.customerContact ?? undefined,
    })
  );
  // Customer pays through Stripe — a channel this merchant also accepts —
  // before whatever the agent scheduled next has a chance to fire.
  await pushStripe(
    merchant.id,
    stripeFailedPayload({ intentId: `pi_never_used_${runId}`, obligationId: "UNRELATED", amountPaise: 100 }) // no-op, proves unrelated events are ignored
  );
  await pushRazorpay(merchant.id, "{}"); // malformed/no-op, proves the pipeline doesn't choke on it
  const stripeSuccess = JSON.stringify({
    id: `evt_flagship_success_${runId}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_flagship_success_${runId}`,
        amount: flagship.originalAmountPaise,
        currency: "inr",
        metadata: { obligation_id: flagship.referenceId },
        payment_method_types: ["card"],
      },
    },
  });
  await pushStripe(merchant.id, stripeSuccess);
  created.push(flagship.id);

  // --- Scenario 1: a clean recovery via WAIT → GENERATE_PAYMENT_LINK,
  // left mid-flight so the dashboard's "advance" control has something to
  // demonstrate live.
  const liveDemo = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_LIVE_DEMO_${runId}`,
    customerId: "cust_live_demo",
    customerContact: "+919800000002",
    amountPaise: 500000,
  });
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_live_demo_1_${runId}`,
      obligationId: liveDemo.referenceId,
      amountPaise: liveDemo.originalAmountPaise,
      errorCode: "NETWORK_ERROR",
      errorDescription: "Network error while connecting to issuer",
      contact: liveDemo.customerContact ?? undefined,
    })
  );
  created.push(liveDemo.id);

  // --- A high-value case that lands in the approval queue.
  const highValue = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_HIGH_VALUE_${runId}`,
    customerId: "cust_high_value",
    customerContact: "+919800000003",
    amountPaise: 1_500_000, // ₹15,000 — over the ₹5,000 auto-approve ceiling
  });
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_high_value_1_${runId}`,
      obligationId: highValue.referenceId,
      amountPaise: highValue.originalAmountPaise,
      errorCode: "CARD_DECLINED",
      errorDescription: "Card was declined by the issuing bank",
      contact: highValue.customerContact ?? undefined,
    })
  );
  created.push(highValue.id);

  // --- A bulk batch of ordinary failures for volume on the dashboard.
  for (let i = 0; i < 25; i++) {
    const sample = FAILURE_SAMPLES[Math.floor(Math.random() * FAILURE_SAMPLES.length)];
    const amountPaise = Math.floor(Math.random() * 400_000) + 10_000;
    const referenceId = `ORDER_BULK_${runId}_${i}`;
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "ORDER",
      referenceId,
      customerId: `cust_bulk_${i}`,
      customerContact: `+9198${String(10000000 + i).slice(0, 8)}`,
      amountPaise,
    });
    const provider = i % 3 === 0 ? "stripe" : "razorpay";
    if (provider === "stripe") {
      await pushStripe(
        merchant.id,
        stripeFailedPayload({
          intentId: `pi_bulk_${runId}_${i}`,
          obligationId: obligation.referenceId,
          amountPaise: obligation.originalAmountPaise,
          code: sample.errorCode,
          message: sample.errorDescription,
        })
      );
    } else {
      await pushRazorpay(
        merchant.id,
        razorpayFailedPayload({
          paymentId: `pay_bulk_${runId}_${i}`,
          obligationId: obligation.referenceId,
          amountPaise: obligation.originalAmountPaise,
          errorCode: sample.errorCode,
          errorDescription: sample.errorDescription,
          method: sample.method,
          contact: obligation.customerContact ?? undefined,
        })
      );
    }
    created.push(obligation.id);
  }

  return NextResponse.json({ merchantId: merchant.id, created: created.length, flagshipObligationId: flagship.id, liveDemoObligationId: liveDemo.id });
}
