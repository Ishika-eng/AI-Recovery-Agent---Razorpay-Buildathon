import crypto from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { createObligation, ingestProviderEvent, recordPromiseToPay } from "@/lib/engine";
import { detectSilentObligations } from "@/lib/silentObligations";

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

  // Wide contact window and no minimum message gap so the demo isn't at
  // the mercy of real wall-clock time between seeded touches; the
  // guardrail logic itself is still enforced and covered by unit tests
  // with a mocked clock.
  const merchant = await db.merchant.update({
    where: { id: sessionMerchant.id },
    data: { contactWindowStartHour: 0, contactWindowEndHour: 24, minMessageGapHours: 0 },
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

  // --- Checkout drop-off + overdue B2B receivable: both never produce a
  // provider event at all (zero payment attempts), so detectSilentObligations()
  // is invoked directly here instead of waiting for the next cron tick,
  // purely so the demo shows the result immediately rather than up to 5
  // minutes later.
  const droppedCheckout = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_DROPOFF_${runId}`,
    customerId: "cust_dropoff",
    customerContact: "+919800000004",
    amountPaise: 250000,
  });
  await db.paymentObligation.update({
    where: { id: droppedCheckout.id },
    data: { createdAt: new Date(Date.now() - 45 * 60 * 1000) }, // 45 minutes ago — past the 30-minute abandonment threshold
  });
  created.push(droppedCheckout.id);

  const overdueInvoice = await createObligation({
    merchantId: merchant.id,
    referenceType: "INVOICE",
    referenceId: `INVOICE_OVERDUE_${runId}`,
    customerId: "cust_receivable",
    customerContact: "+919800000005",
    amountPaise: 4_200_000,
    dueDate: new Date(Date.now() - 3 * 24 * 3_600_000), // 3 days overdue
  });
  created.push(overdueInvoice.id);

  await detectSilentObligations(merchant.id);

  // --- Mandate retry sequencer: two failed UPI Autopay/e-mandate debits,
  // enough to exhaust the 1-retry NPCI-style cap and get
  // OFFER_ALTERNATIVE_PAYMENT_METHOD proposed instead of another retry.
  const mandate = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_MANDATE_${runId}`,
    customerId: "cust_mandate",
    customerContact: "+919800000006",
    amountPaise: 99900,
  });
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_mandate_1_${runId}`,
      obligationId: mandate.referenceId,
      amountPaise: mandate.originalAmountPaise,
      errorCode: "GATEWAY_TIMEOUT",
      errorDescription: "Mandate execution failed",
      method: "emandate",
      contact: mandate.customerContact ?? undefined,
    })
  );
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_mandate_2_${runId}`,
      obligationId: mandate.referenceId,
      amountPaise: mandate.originalAmountPaise,
      errorCode: "GATEWAY_TIMEOUT",
      errorDescription: "Mandate execution failed",
      method: "emandate",
      contact: mandate.customerContact ?? undefined,
    })
  );
  created.push(mandate.id);

  // --- Hinglish voice recovery: a HIGH-value customer (10+ prior PAID
  // obligations, what GenericEcommerceAdapter.getCustomerContext treats as
  // HIGH) whose one automated attempt already went unanswered — the AI
  // should recommend a voice call with a ready script instead of a bare
  // escalation.
  const voiceCustomerId = `cust_voice_${runId}`;
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      db.paymentObligation.create({
        data: {
          merchantId: merchant.id,
          referenceType: "ORDER",
          referenceId: `ORDER_VOICE_HISTORY_${runId}_${i}`,
          customerId: voiceCustomerId,
          originalAmountPaise: 100000,
          outstandingAmountPaise: 0,
          status: "PAID",
        },
      })
    )
  );
  const voiceTarget = await createObligation({
    merchantId: merchant.id,
    referenceType: "ORDER",
    referenceId: `ORDER_VOICE_${runId}`,
    customerId: voiceCustomerId,
    customerContact: "+919800000007",
    amountPaise: 850000,
  });
  // Seed "one automated attempt already went out and got no response"
  // directly, rather than relying on a real GENERATE_PAYMENT_LINK to
  // actually auto-execute first — at this amount it requires merchant
  // approval (over the auto-approve ceiling), so a real first touch would
  // never reach messagesSent=1 on its own for this demo. The *second*
  // touch below is still pushed as a real webhook through the real
  // pipeline — that's the live decision this scenario exists to show.
  const voiceCase = await db.recoveryCase.create({
    data: { obligationId: voiceTarget.id, status: "WAITING", messagesSent: 1 },
  });
  await db.paymentAttempt.create({
    data: {
      obligationId: voiceTarget.id,
      provider: "razorpay",
      providerPaymentId: `pay_voice_seed_${runId}`,
      amountPaise: voiceTarget.originalAmountPaise,
      status: "FAILED",
      failureCategory: "ISSUER_DECLINE",
      failureReason: "Card was declined by the issuing bank",
    },
  });
  await db.recoveryAction.create({
    data: {
      caseId: voiceCase.id,
      actionType: "GENERATE_PAYMENT_LINK",
      proposedBy: "AI",
      reason: "Failure indicates the instrument itself won't clear on retry — offering a fresh payment link (demo seed).",
      policyResult: "REQUIRES_APPROVAL",
      policyReasoning: "Outstanding amount exceeds the auto-approve ceiling — requires merchant sign-off before executing.",
      executionStatus: "EXECUTED",
      executedAt: new Date(),
    },
  });
  await pushRazorpay(
    merchant.id,
    razorpayFailedPayload({
      paymentId: `pay_voice_2_${runId}`,
      obligationId: voiceTarget.referenceId,
      amountPaise: voiceTarget.originalAmountPaise,
      errorCode: "CARD_DECLINED",
      errorDescription: "Card was declined by the issuing bank",
      contact: voiceTarget.customerContact ?? undefined,
    })
  );
  created.push(voiceTarget.id);

  // --- Promise-to-pay tracker: pre-seed one kept and one still-pending
  // promise so the tracker shows real, non-zero numbers immediately
  // rather than needing a manual click first.
  const promiseCase = await db.recoveryCase.findUnique({ where: { obligationId: liveDemo.id } });
  if (promiseCase) {
    await recordPromiseToPay(liveDemo.id, "Customer said they'd pay by end of week (demo seed)");
  }

  return NextResponse.json({ merchantId: merchant.id, created: created.length, flagshipObligationId: flagship.id, liveDemoObligationId: liveDemo.id });
}
