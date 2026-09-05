import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  advanceCase,
  approveAction,
  createObligation,
  ingestProviderEvent,
  optOutCustomer,
  processDueCases,
  recordPromiseToPay,
  rejectAction,
  resolveExternalPayment,
  runRecoveryCycle,
  writeOffObligation,
} from "@/lib/engine";
import { detectSilentObligations } from "@/lib/silentObligations";
import { createMerchant, resetDb } from "./helpers";

function razorpayFailedBody(opts: { paymentId: string; obligationId: string; amountPaise: number; errorCode?: string; errorDescription?: string; method?: string }) {
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
          error_code: opts.errorCode,
          error_description: opts.errorDescription,
        },
      },
    },
  });
}

function stripeSucceededBody(opts: { intentId: string; obligationId: string; amountPaise: number }) {
  return JSON.stringify({
    id: `evt_${opts.intentId}`,
    type: "payment_intent.succeeded",
    data: {
      object: { id: opts.intentId, amount: opts.amountPaise, currency: "inr", metadata: { obligation_id: opts.obligationId } },
    },
  });
}

async function pushRazorpayFailure(merchantId: string, opts: Parameters<typeof razorpayFailedBody>[0]) {
  return ingestProviderEvent("razorpay", razorpayFailedBody(opts), new Headers(), merchantId);
}

function razorpayDisputeBody(opts: { disputeId: string; paymentId: string; amountPaise: number }) {
  return JSON.stringify({
    event: "payment.dispute.created",
    payload: {
      dispute: {
        entity: { id: opts.disputeId, payment_id: opts.paymentId, amount: opts.amountPaise, currency: "INR" },
      },
    },
  });
}

async function pushRazorpayDispute(merchantId: string, opts: Parameters<typeof razorpayDisputeBody>[0]) {
  return ingestProviderEvent("razorpay", razorpayDisputeBody(opts), new Headers(), merchantId);
}

function razorpayPaymentLinkPaidBody(opts: { linkId: string; obligationId: string; amountPaise: number }) {
  return JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: { id: opts.linkId, reference_id: opts.obligationId, amount: opts.amountPaise, amount_paid: opts.amountPaise, currency: "INR" },
      },
      payment: { entity: { id: `pay_via_${opts.linkId}`, amount: opts.amountPaise, method: "upi" } },
    },
  });
}

async function pushRazorpayPaymentLinkPaid(merchantId: string, opts: Parameters<typeof razorpayPaymentLinkPaidBody>[0]) {
  return ingestProviderEvent("razorpay", razorpayPaymentLinkPaidBody(opts), new Headers(), merchantId);
}

// "payment.refunded" isn't a real Razorpay event (see providers/razorpay.ts) —
// the real one is refund.processed, carried under payload.refund.entity.
function razorpayRefundedBody(opts: { paymentId: string; amountPaise: number; amountRefundedPaise: number }) {
  return JSON.stringify({
    event: "refund.processed",
    payload: {
      refund: { entity: { id: `rfnd_${opts.paymentId}`, payment_id: opts.paymentId, amount: opts.amountRefundedPaise, currency: "INR" } },
      payment: { entity: { id: opts.paymentId, amount: opts.amountPaise, amount_refunded: opts.amountRefundedPaise, currency: "INR" } },
    },
  });
}

async function pushRazorpayRefund(merchantId: string, opts: Parameters<typeof razorpayRefundedBody>[0]) {
  return ingestProviderEvent("razorpay", razorpayRefundedBody(opts), new Headers(), merchantId);
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("provider-agnostic correlation", () => {
  it("routes a normalized Razorpay failure to the obligation via the merchant-owned reference", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "ORDER",
      referenceId: "ORDER_1",
      amountPaise: 100000,
    });

    const result = await pushRazorpayFailure(merchant.id, {
      paymentId: "pay_1",
      obligationId: obligation.referenceId,
      amountPaise: 100000,
      errorCode: "GATEWAY_TIMEOUT",
    });

    expect(result.status).toBe("processed");
    const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { obligationId: obligation.id } });
    expect(attempt.provider).toBe("razorpay");
    expect(attempt.failureCategory).toBe("TIMEOUT");
  });

  it("routes to manual review instead of guessing when the obligation reference is unknown", async () => {
    const merchant = await createMerchant();
    const result = await pushRazorpayFailure(merchant.id, {
      paymentId: "pay_unknown",
      obligationId: "ORDER_DOES_NOT_EXIST",
      amountPaise: 100000,
      errorCode: "GATEWAY_TIMEOUT",
    });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.correlated).toBe(false);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "CORRELATION_FAILED" } });
    expect(log.reasoning).toMatch(/manual review/i);
  });

  it("does not double-process a retried webhook delivery for the same provider event id", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_DUP", amountPaise: 100000 });
    const opts = { paymentId: "pay_dup", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" };

    const first = await pushRazorpayFailure(merchant.id, opts);
    const second = await pushRazorpayFailure(merchant.id, opts);

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(await db.paymentAttempt.count({ where: { obligationId: obligation.id } })).toBe(1);
  });
});

describe("AI proposal + policy gating", () => {
  it("waits on a first transient failure, then generates a payment link once the wait has already happened", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WAIT", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    let recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(lastAction.actionType).toBe("WAIT");
    expect(lastAction.executionStatus).toBe("EXECUTED");
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT");

    vi.spyOn(Math, "random").mockReturnValue(0.99); // force "not recovered" so the chain is deterministic
    await advanceCase(recoveryCase.id);

    recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const linkAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id, actionType: "GENERATE_PAYMENT_LINK" } });
    expect(linkAction.executionStatus).toBe("EXECUTED");
  });

  it("skips straight to a payment link on a hard decline, without waiting", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_DECLINE", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const firstAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "asc" } });
    expect(firstAction.actionType).toBe("GENERATE_PAYMENT_LINK");
  });

  it("requires approval once the outstanding amount exceeds the merchant's auto-approve ceiling", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 500000 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_HIGH", amountPaise: 1500000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 1500000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("GENERATE_PAYMENT_LINK");
    expect(action.executionStatus).toBe("PENDING_APPROVAL");
  });

  it("blocks a customer-facing action outside the configured contact window", async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 23, 0, 0)); // 23:00
    const merchant = await createMerchant({ contactWindowStartHour: 9, contactWindowEndHour: 20 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WINDOW", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.executionStatus).toBe("POLICY_BLOCKED");
    expect(action.policyReasoning).toMatch(/contact window/i);
  });
});

describe("mandatory pre-action verification and cross-channel resolution", () => {
  it("stops recovery and does not act when the obligation is already PAID at cycle start", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PAID", amountPaise: 100000 });
    await db.paymentObligation.update({ where: { id: obligation.id }, data: { status: "PAID" } });

    const result = await runRecoveryCycle(obligation.id);
    expect(result).toMatchObject({ skipped: true });
    expect(await db.recoveryAction.count()).toBe(0);
  });

  it("cancels a scheduled action and closes the case when the customer pays through another channel (the flagship scenario)", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "ORDER",
      referenceId: "ORDER_FLAGSHIP",
      amountPaise: 500000,
    });

    // Two Razorpay failures — first triggers WAIT (scheduling VERIFY_PAYMENT).
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 500000, errorCode: "GATEWAY_TIMEOUT" });
    let recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT");

    // Customer pays through Stripe before that scheduled step fires.
    const result = await ingestProviderEvent(
      "stripe",
      stripeSucceededBody({ intentId: "pi_1", obligationId: obligation.referenceId, amountPaise: 500000 }),
      new Headers(),
      merchant.id
    );
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.result).toBe("resolved");

    const resolved = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(resolved.status).toBe("PAID");
    expect(resolved.resolutionSource).toBe("stripe");

    recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.status).toBe("RESOLVED");
    expect(recoveryCase.nextAction).toBeNull();

    const preventedLog = await db.auditLog.findFirstOrThrow({ where: { action: "RECOVERY_ACTION_PREVENTED" } });
    expect(preventedLog.reasoning).toMatch(/already paid/i);

    // The Razorpay side never learns of any of this — a later, duplicate or
    // delayed Razorpay failure for the same obligation must not reopen it.
    await runRecoveryCycle(obligation.id);
    const stillResolved = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(stillResolved.status).toBe("PAID");
  });

  it("resolveExternalPayment is idempotent against an already-resolved obligation", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_EXT", amountPaise: 100000 });

    await resolveExternalPayment(obligation.id, "ext_1");
    await resolveExternalPayment(obligation.id, "ext_2");

    const resolved = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(resolved.status).toBe("PAID");
    expect(resolved.resolutionSource).toBe("external"); // first resolution wins, second is a no-op
  });
});

describe("approve / reject flow", () => {
  it("approving a pending action executes it", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 }); // force approval required
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_APPROVE", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(pending.executionStatus).toBe("PENDING_APPROVAL");

    vi.spyOn(Math, "random").mockReturnValue(0); // force recovery outcome
    const approved = await approveAction(pending.id);
    expect(approved.executionStatus).toBe("EXECUTED");

    const resolved = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(resolved.status).toBe("PAID");
  });

  it("rejecting a pending action escalates the case instead of executing it", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_REJECT", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });

    await rejectAction(pending.id);

    const updated = await db.recoveryAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(updated.executionStatus).toBe("REJECTED");
    const updatedCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(updatedCase.status).toBe("ESCALATED");
  });

  it("skips execution when the obligation was resolved between proposal and approval", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_RACE", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });

    await resolveExternalPayment(obligation.id, "ext_race");
    const approved = await approveAction(pending.id);

    expect(approved.executionStatus).toBe("SKIPPED_ALREADY_PAID");
  });
});

describe("autonomous scheduling (processDueCases)", () => {
  it("advances a WAIT case on its own once nextActionAt has passed, with no manual trigger", async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0)); // inside default 0-24 contact window
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SCHED_WAIT", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    let recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT"); // WAIT already executed, scheduled a re-check

    // Not due yet — a tick right now must not touch it.
    const tooEarly = await processDueCases(new Date(2026, 0, 1, 12, 0, 30));
    expect(tooEarly.dueCount).toBe(0);
    recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT");

    // Past the WAIT window (10 minutes for this obligation's STANDARD-tier
    // customer — see WAIT_MINUTES_BY_VALUE in src/lib/ai.ts) — the
    // scheduler, not a human, moves it forward.
    const due = await processDueCases(new Date(2026, 0, 1, 12, 11, 0));
    expect(due.dueCount).toBe(1);

    const generateLinkAction = await db.recoveryAction.findFirstOrThrow({
      where: { caseId: recoveryCase.id, actionType: "GENERATE_PAYMENT_LINK" },
    });
    expect(generateLinkAction.executionStatus).toBe("EXECUTED");
  });

  it("never re-proposes on top of an action already sitting in the approval queue", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SCHED_PENDING", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({
      data: { obligationId: obligation.id, status: "WAITING", nextAction: "SEND_REMINDER", nextActionAt: new Date(Date.now() - 1000) },
    });
    await db.recoveryAction.create({
      data: { caseId: recoveryCase.id, actionType: "SEND_REMINDER", reason: "test fixture", executionStatus: "PENDING_APPROVAL" },
    });

    const before = await db.recoveryAction.count({ where: { caseId: recoveryCase.id } });
    const result = await processDueCases();
    const after = await db.recoveryAction.count({ where: { caseId: recoveryCase.id } });

    expect(result.results[0]).toMatchObject({ caseId: recoveryCase.id, skipped: "pending_approval" });
    expect(after).toBe(before); // no duplicate proposal created
  });

  it("gives a time-blocked case a real nextActionAt so the scheduler can pick it back up", async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 23, 0, 0)); // outside a 9-20 contact window
    const merchant = await createMerchant({ contactWindowStartHour: 9, contactWindowEndHour: 20 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SCHED_BLOCKED", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextActionAt).not.toBeNull(); // not left to poll forever with no clock

    // Move into the contact window and past that check time — the same
    // scheduler tick that would run in production now clears the hold.
    vi.setSystemTime(new Date(2026, 0, 2, 10, 0, 0));
    const result = await processDueCases();
    expect(result.dueCount).toBe(1);

    const action = await db.recoveryAction.findFirstOrThrow({
      where: { caseId: recoveryCase.id, actionType: "GENERATE_PAYMENT_LINK" },
      orderBy: { createdAt: "desc" },
    });
    expect(action.executionStatus).toBe("EXECUTED");
  });
});

describe("customer opt-out — the real trigger, not just an unused guardrail", () => {
  it("stops any future customer-facing proposal once a customer opts out", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_OPTOUT", amountPaise: 100000 });
    // Transient failure — WAIT executes deterministically (no delivery
    // attempt, no simulated-outcome dice roll, no auto-chain), so the
    // obligation and case land in a known state before opting out.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT");

    const updated = await optOutCustomer(obligation.id, "test: customer said stop");
    expect(updated?.contactOptedOut).toBe(true);

    const optOutLog = await db.auditLog.findFirstOrThrow({ where: { action: "CUSTOMER_OPTED_OUT" } });
    expect(optOutLog.reasoning).toMatch(/opted out/i);

    // A later cycle must not send anything further — the guardrail blocks
    // it, and doesn't get rescheduled hourly since it's a permanent hold.
    await runRecoveryCycle(obligation.id);
    const blocked = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(blocked.executionStatus).toBe("POLICY_BLOCKED");
    expect(blocked.policyReasoning).toMatch(/opted out/i);

    const caseAfter = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(caseAfter.nextActionAt).toBeNull();
  });

  it("blocks a still-pending approval-queue action retroactively", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_OPTOUT_PENDING", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(pending.executionStatus).toBe("PENDING_APPROVAL");

    await optOutCustomer(obligation.id, "test: customer said stop");

    const updated = await db.recoveryAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(updated.executionStatus).toBe("POLICY_BLOCKED");
  });
});

describe("dispute handling — the real trigger, not just an unused guardrail", () => {
  it("correlates a dispute to its obligation via the disputed payment id, stops recovery, and escalates", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_DISPUTE", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_disputed", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.nextAction).toBe("VERIFY_PAYMENT"); // WAIT scheduled — this is what a dispute must cancel

    const result = await pushRazorpayDispute(merchant.id, { disputeId: "disp_1", paymentId: "pay_disputed", amountPaise: 100000 });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.result).toBe("dispute_opened");

    const updatedCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(updatedCase.riskLevel).toBe("DISPUTE_ACTIVE");
    expect(updatedCase.status).toBe("ESCALATED");

    const disputeLog = await db.auditLog.findFirstOrThrow({ where: { action: "DISPUTE_OPENED" } });
    expect(disputeLog.reasoning).toMatch(/dispute/i);

    // A subsequent trigger must not pressure the customer while it's contested.
    await runRecoveryCycle(obligation.id);
    const blocked = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(blocked.executionStatus).toBe("POLICY_BLOCKED");
    expect(blocked.policyReasoning).toMatch(/dispute/i);
  });

  it("blocks a still-pending action retroactively when a dispute opens on that obligation", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_DISPUTE_PENDING", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_disputed_2", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(pending.executionStatus).toBe("PENDING_APPROVAL");

    await pushRazorpayDispute(merchant.id, { disputeId: "disp_2", paymentId: "pay_disputed_2", amountPaise: 100000 });

    const updated = await db.recoveryAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(updated.executionStatus).toBe("POLICY_BLOCKED");
  });

  it("routes to manual review instead of guessing when the disputed payment id has no matching attempt", async () => {
    const merchant = await createMerchant();
    const result = await pushRazorpayDispute(merchant.id, { disputeId: "disp_unknown", paymentId: "pay_never_seen", amountPaise: 100000 });

    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.correlated).toBe(false);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "CORRELATION_FAILED" } });
    expect(log.reasoning).toMatch(/manual review/i);
  });
});

describe("write-off — the terminal state a stuck case had no way to reach", () => {
  it("closes the obligation and case permanently, cancelling any pending action", async () => {
    const merchant = await createMerchant({ autoApproveUnderPaise: 0 });
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WRITEOFF", amountPaise: 100000 });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_1", obligationId: obligation.referenceId, amountPaise: 100000, errorDescription: "Card was declined by the issuing bank" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const pending = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(pending.executionStatus).toBe("PENDING_APPROVAL");

    const result = await writeOffObligation(obligation.id, "test: merchant gave up");
    expect(result.status).toBe("CANCELLED");

    const updatedCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(updatedCase.status).toBe("CANCELLED");
    expect(updatedCase.nextAction).toBeNull();

    const updatedAction = await db.recoveryAction.findUniqueOrThrow({ where: { id: pending.id } });
    expect(updatedAction.executionStatus).toBe("POLICY_BLOCKED");

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "WRITE_OFF" } });
    expect(log.actor).toBe("MERCHANT");
    expect(log.reasoning).toMatch(/wrote off/i);
  });

  it("is idempotent and never overrides a real resolution", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WRITEOFF_PAID", amountPaise: 100000 });

    await resolveExternalPayment(obligation.id, "ext_1");

    const result = await writeOffObligation(obligation.id, "test: too late, already paid");
    expect(result.status).toBe("PAID"); // a real payment always wins — write-off never undoes it
  });

  it("does not create duplicate audit entries when called twice", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_WRITEOFF_TWICE", amountPaise: 100000 });

    await writeOffObligation(obligation.id, "first");
    const countAfterFirst = await db.auditLog.count({ where: { action: "WRITE_OFF" } });
    await writeOffObligation(obligation.id, "second");
    const countAfterSecond = await db.auditLog.count({ where: { action: "WRITE_OFF" } });

    expect(countAfterFirst).toBe(1);
    expect(countAfterSecond).toBe(1); // second call is a no-op, already CANCELLED
  });
});

describe("attribution — crediting the action that actually caused a recovery", () => {
  it("credits the specific RecoveryAction whose payment link was paid", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_ATTR_1", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    const action = await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "GENERATE_PAYMENT_LINK",
        reason: "test fixture",
        executionStatus: "EXECUTED",
        executedAt: new Date(),
        deliveryChannel: "razorpay_payment_link",
        deliveryRef: "plink_test_attr_1", // what a real createPaymentLink() call would have stored
      },
    });

    const result = await pushRazorpayPaymentLinkPaid(merchant.id, {
      linkId: "plink_test_attr_1",
      obligationId: obligation.referenceId,
      amountPaise: 100000,
    });
    expect(result.status).toBe("processed");

    const updatedObligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updatedObligation.status).toBe("PAID");

    const updatedAction = await db.recoveryAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(updatedAction.recoveredPaise).toBe(100000);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "OBLIGATION_RESOLVED" } });
    expect(log.reasoning).toMatch(/confirmed attributable/i);
  });

  it("does not attribute a resolution to an unrelated action's link id", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_ATTR_2", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    const action = await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "GENERATE_PAYMENT_LINK",
        reason: "test fixture",
        executionStatus: "EXECUTED",
        executedAt: new Date(),
        deliveryChannel: "razorpay_payment_link",
        deliveryRef: "plink_never_paid",
      },
    });

    // Customer paid through a *different* link — e.g. one from another
    // channel entirely — never one this platform generated for this case.
    await pushRazorpayPaymentLinkPaid(merchant.id, {
      linkId: "plink_completely_unrelated",
      obligationId: obligation.referenceId,
      amountPaise: 100000,
    });

    const updatedObligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updatedObligation.status).toBe("PAID"); // still resolves — just honestly, not attributed

    const unchangedAction = await db.recoveryAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(unchangedAction.recoveredPaise).toBeNull();

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "OBLIGATION_RESOLVED" } });
    expect(log.reasoning).toMatch(/not attributed/i);
  });

  it("never attributes a cross-channel (external) resolution to any action", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_ATTR_3", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    const action = await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "GENERATE_PAYMENT_LINK",
        reason: "test fixture",
        executionStatus: "EXECUTED",
        deliveryChannel: "razorpay_payment_link",
        deliveryRef: "plink_irrelevant",
      },
    });

    await resolveExternalPayment(obligation.id, "ext_ref_1");

    const unchangedAction = await db.recoveryAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(unchangedAction.recoveredPaise).toBeNull();
  });
});

describe("refunds and chargebacks — the metrics must reverse, not just the money", () => {
  it("marks an obligation REFUNDED on a full refund, which removes it from the recovered total", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_REFUND_FULL", amountPaise: 100000 });
    await db.paymentAttempt.create({
      data: { obligationId: obligation.id, provider: "razorpay", providerPaymentId: "pay_refund_full", amountPaise: 100000, status: "SUCCEEDED" },
    });
    await db.paymentObligation.update({ where: { id: obligation.id }, data: { status: "PAID", outstandingAmountPaise: 0, resolvedAt: new Date() } });

    const result = await pushRazorpayRefund(merchant.id, { paymentId: "pay_refund_full", amountPaise: 100000, amountRefundedPaise: 100000 });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.result).toBe("refund_issued");

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("REFUNDED");
    expect(updated.refundedAmountPaise).toBe(100000);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "REFUND_ISSUED" } });
    expect(log.reasoning).toMatch(/no longer counts toward recovered revenue/i);
  });

  it("a partial refund reduces the recovered amount without changing status", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_REFUND_PARTIAL", amountPaise: 100000 });
    await db.paymentAttempt.create({
      data: { obligationId: obligation.id, provider: "razorpay", providerPaymentId: "pay_refund_partial", amountPaise: 100000, status: "SUCCEEDED" },
    });
    await db.paymentObligation.update({ where: { id: obligation.id }, data: { status: "PAID", outstandingAmountPaise: 0, resolvedAt: new Date() } });

    await pushRazorpayRefund(merchant.id, { paymentId: "pay_refund_partial", amountPaise: 100000, amountRefundedPaise: 30000 });

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID"); // not fully reversed
    expect(updated.refundedAmountPaise).toBe(30000);
  });

  it("routes to manual review instead of guessing when the refunded payment id has no matching attempt", async () => {
    const merchant = await createMerchant();
    const result = await pushRazorpayRefund(merchant.id, { paymentId: "pay_never_seen", amountPaise: 100000, amountRefundedPaise: 100000 });

    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.correlated).toBe(false);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "CORRELATION_FAILED" } });
    expect(log.reasoning).toMatch(/manual review/i);
  });
});

describe("partial payment and overpayment — a payment doesn't have to match what's owed exactly", () => {
  it("a partial payment reduces outstanding and keeps the case open, not resolved", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PARTIAL_1", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    const result = await pushRazorpayPaymentLinkPaid(merchant.id, {
      linkId: "plink_partial_1",
      obligationId: obligation.referenceId,
      amountPaise: 40000,
    });
    expect(result.status).toBe("processed");

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PARTIALLY_PAID");
    expect(updated.outstandingAmountPaise).toBe(60000);

    const unchangedCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(unchangedCase.status).toBe("WAITING"); // never auto-closed by a partial payment

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "PARTIAL_PAYMENT_RECEIVED" } });
    expect(log.reasoning).toMatch(/still outstanding/i);
  });

  it("a follow-up payment for the remainder fully resolves the obligation", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PARTIAL_2", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_partial_2a", obligationId: obligation.referenceId, amountPaise: 40000 });
    const result = await pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_partial_2b", obligationId: obligation.referenceId, amountPaise: 60000 });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.result).toBe("resolved");

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID");
    expect(updated.outstandingAmountPaise).toBe(0);
  });

  it("an overpayment fully resolves the obligation and flags the excess instead of counting it as recovered", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_OVERPAY_1", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    const result = await pushRazorpayPaymentLinkPaid(merchant.id, {
      linkId: "plink_overpay_1",
      obligationId: obligation.referenceId,
      amountPaise: 120000,
    });
    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    expect(result.result).toBe("resolved");

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID");
    expect(updated.outstandingAmountPaise).toBe(0);
    expect(updated.excessPaidAmountPaise).toBe(20000);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "OVERPAYMENT_DETECTED" } });
    expect(log.reasoning).toMatch(/flagged for human review/i);
  });

  it("an attributed overpayment credits the action only for what was actually owed, not the excess", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_OVERPAY_2", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    const action = await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "GENERATE_PAYMENT_LINK",
        reason: "test fixture",
        executionStatus: "EXECUTED",
        deliveryChannel: "razorpay_payment_link",
        deliveryRef: "plink_overpay_2",
      },
    });

    await pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_overpay_2", obligationId: obligation.referenceId, amountPaise: 150000 });

    const updatedAction = await db.recoveryAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(updatedAction.recoveredPaise).toBe(100000); // not 150000
  });

  it("resolveExternalPayment supports an explicit partial amount", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_EXT_PARTIAL", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await resolveExternalPayment(obligation.id, "ext_partial_1", 25000);

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PARTIALLY_PAID");
    expect(updated.outstandingAmountPaise).toBe(75000);
  });
});

describe("provider-outage detection — a systemic transient failure isn't this customer's problem (PRD Problem 11)", () => {
  it("waits longer instead of contacting the customer once enough other obligations hit the same transient failure on the same provider", async () => {
    const merchant = await createMerchant();
    const obligations = await Promise.all(
      ["ORDER_OUTAGE_1", "ORDER_OUTAGE_2", "ORDER_OUTAGE_3"].map((referenceId) =>
        createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId, amountPaise: 100000 })
      )
    );

    // First two failures: not enough distinct obligations yet to suspect an
    // outage (threshold is 3), so these still get normal single-obligation
    // treatment.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_outage_1", obligationId: obligations[0].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_outage_2", obligationId: obligations[1].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    // Third distinct obligation crosses the threshold — this one should
    // see the outage and respond differently.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_outage_3", obligationId: obligations[2].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const caseThree = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligations[2].id } });
    const actionThree = await db.recoveryAction.findFirstOrThrow({ where: { caseId: caseThree.id }, orderBy: { createdAt: "desc" } });
    expect(actionThree.actionType).toBe("WAIT");
    expect(actionThree.reason).toMatch(/outage/i);
  });

  it("does not suspect an outage from a single isolated transient failure", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_OUTAGE_ISOLATED", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_isolated", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("WAIT");
    expect(action.reason).not.toMatch(/outage/i);
  });

  it("still treats a hard decline as a genuine instrument problem even while a suspected outage is ongoing", async () => {
    const merchant = await createMerchant();
    const obligations = await Promise.all(
      ["ORDER_OUTAGE_HD_1", "ORDER_OUTAGE_HD_2", "ORDER_OUTAGE_HD_3", "ORDER_OUTAGE_HD_4"].map((referenceId) =>
        createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId, amountPaise: 100000 })
      )
    );

    for (let i = 0; i < 3; i++) {
      await pushRazorpayFailure(merchant.id, {
        paymentId: `pay_outage_hd_${i}`,
        obligationId: obligations[i].referenceId,
        amountPaise: 100000,
        errorCode: "GATEWAY_TIMEOUT",
      });
    }

    // A 4th obligation, but with a genuine hard decline rather than a
    // transient failure — the suspected outage must not suppress this.
    await pushRazorpayFailure(merchant.id, {
      paymentId: "pay_outage_hd_decline",
      obligationId: obligations[3].referenceId,
      amountPaise: 100000,
      errorCode: "CARD_DECLINED",
      errorDescription: "Card was declined",
    });

    const declineCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligations[3].id } });
    const declineAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: declineCase.id } });
    expect(declineAction.actionType).toBe("GENERATE_PAYMENT_LINK");
  });

  it("does not suspect an outage at exactly one below the threshold (2 distinct obligations)", async () => {
    const merchant = await createMerchant();
    const obligations = await Promise.all(
      ["ORDER_OUTAGE_BOUNDARY_1", "ORDER_OUTAGE_BOUNDARY_2"].map((referenceId) =>
        createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId, amountPaise: 100000 })
      )
    );

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_boundary_1", obligationId: obligations[0].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_boundary_2", obligationId: obligations[1].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const caseTwo = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligations[1].id } });
    const actionTwo = await db.recoveryAction.findFirstOrThrow({ where: { caseId: caseTwo.id }, orderBy: { createdAt: "desc" } });
    expect(actionTwo.reason).not.toMatch(/outage/i);
  });

  it("does not let one merchant's failures trigger an outage flag on a different merchant's case", async () => {
    const merchantA = await createMerchant();
    const merchantB = await createMerchant();

    // Three distinct obligations on merchant A, same provider, same
    // transient category — enough to cross the threshold on its own.
    const obligationsA = await Promise.all(
      ["ORDER_OUTAGE_TENANT_A1", "ORDER_OUTAGE_TENANT_A2", "ORDER_OUTAGE_TENANT_A3"].map((referenceId) =>
        createObligation({ merchantId: merchantA.id, referenceType: "ORDER", referenceId, amountPaise: 100000 })
      )
    );
    for (let i = 0; i < 3; i++) {
      await pushRazorpayFailure(merchantA.id, { paymentId: `pay_tenant_a_${i}`, obligationId: obligationsA[i].referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });
    }

    // Merchant B has only one obligation with a single transient failure
    // on the very same provider — nowhere near its own threshold, and
    // must not inherit merchant A's outage.
    const obligationB = await createObligation({ merchantId: merchantB.id, referenceType: "ORDER", referenceId: "ORDER_OUTAGE_TENANT_B1", amountPaise: 100000 });
    await pushRazorpayFailure(merchantB.id, { paymentId: "pay_tenant_b_1", obligationId: obligationB.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const caseB = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligationB.id } });
    const actionB = await db.recoveryAction.findFirstOrThrow({ where: { caseId: caseB.id } });
    expect(actionB.reason).not.toMatch(/outage/i);
  });
});

describe("AI-vs-rules baseline recording (PRD Problem 37)", () => {
  it("records the naive fixed-schedule baseline alongside every AI decision, without executing it", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_BASELINE_1", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_baseline_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });

    // The AI waits on a first-looking-transient failure; the naive
    // baseline always sends a reminder on the first touch — a genuine
    // divergence, and neither the executionStatus nor deliveryChannel
    // should show any sign the baseline itself ever ran.
    expect(action.baselineAction).toBe("SEND_REMINDER");
    expect(action.actionType).toBe("WAIT");
    expect(action.deliveryChannel).toBeNull();
  });

  it("agrees with the baseline on a first-touch reminder when nothing calibrated applies", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_BASELINE_2", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "OPEN", recoveryAttempts: 1, messagesSent: 0 } });
    await db.paymentAttempt.create({
      data: { obligationId: obligation.id, provider: "razorpay", providerPaymentId: "pay_baseline_2", amountPaise: 100000, status: "FAILED", failureCategory: "UNKNOWN" },
    });

    await runRecoveryCycle(obligation.id);

    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("SEND_REMINDER");
    expect(action.baselineAction).toBe("SEND_REMINDER");
  });
});

describe("suspected-fraud detection — rapid repeated failed attempts, not a struggling customer (PRD Problem 30)", () => {
  it("flags suspected fraud and blocks automated recovery once enough failed attempts land on the same obligation", async () => {
    // Force "not recovered" on every simulated dice roll — otherwise the
    // very first hard-decline push has a real chance of auto-resolving
    // the obligation to PAID (55% simulated recovery rate on
    // GENERATE_PAYMENT_LINK), which short-circuits every later cycle
    // before it ever reaches the fraud check.
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_1", amountPaise: 100000 });

    for (let i = 0; i < 5; i++) {
      await pushRazorpayFailure(merchant.id, {
        paymentId: `pay_fraud_${i}`,
        obligationId: obligation.referenceId,
        amountPaise: 100000,
        errorCode: "CARD_DECLINED",
        errorDescription: "Card was declined",
      });
    }

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.riskLevel).toBe("FRAUD_SUSPECTED");

    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(lastAction.policyResult).toBe("BLOCKED");
    expect(lastAction.policyReasoning).toMatch(/fraud/i);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "SUSPECTED_FRAUD" } });
    expect(log.reasoning).toMatch(/card testing/i);
  });

  it("does not flag fraud from a normal handful of retries below the threshold", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_2", amountPaise: 100000 });

    for (let i = 0; i < 2; i++) {
      await pushRazorpayFailure(merchant.id, {
        paymentId: `pay_normal_${i}`,
        obligationId: obligation.referenceId,
        amountPaise: 100000,
        errorCode: "GATEWAY_TIMEOUT",
      });
    }

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.riskLevel).toBe("STANDARD");
  });

  it("re-evaluates policy against the case's current risk level, not a stale one, once fraud is suspected mid-cycle", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_3", amountPaise: 100000 });

    for (let i = 0; i < 5; i++) {
      await pushRazorpayFailure(merchant.id, {
        paymentId: `pay_fraud3_${i}`,
        obligationId: obligation.referenceId,
        amountPaise: 100000,
        errorCode: "GATEWAY_TIMEOUT",
      });
    }

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.riskLevel).toBe("FRAUD_SUSPECTED");

    // A fresh cycle run after the fact must still see FRAUD_SUSPECTED and
    // block, not fall back to STANDARD guardrails.
    await runRecoveryCycle(obligation.id);
    const latestAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(latestAction.policyResult).toBe("BLOCKED");
  });

  it("does not flag fraud at exactly one below the threshold (4 attempts)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_BOUNDARY", amountPaise: 100000 });

    for (let i = 0; i < 4; i++) {
      await pushRazorpayFailure(merchant.id, {
        paymentId: `pay_boundary4_${i}`,
        obligationId: obligation.referenceId,
        amountPaise: 100000,
        errorCode: "CARD_DECLINED",
        errorDescription: "Card was declined",
      });
    }

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    expect(recoveryCase.riskLevel).toBe("STANDARD");
  });

  it("does not count another obligation's failed attempts toward this obligation's velocity, even for the same merchant and provider", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const targetObligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_ISOLATION_TARGET", amountPaise: 100000 });
    const otherObligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_FRAUD_ISOLATION_OTHER", amountPaise: 100000 });

    // 4 failures on a different obligation for the same merchant/provider
    // — this is exactly the pattern provider-outage detection cares
    // about, but it must never feed into fraud velocity, which is
    // strictly per-obligation.
    for (let i = 0; i < 4; i++) {
      await pushRazorpayFailure(merchant.id, { paymentId: `pay_isolation_other_${i}`, obligationId: otherObligation.referenceId, amountPaise: 100000, errorCode: "CARD_DECLINED", errorDescription: "Card was declined" });
    }
    // Just one failure on the actual target obligation.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_isolation_target_1", obligationId: targetObligation.referenceId, amountPaise: 100000, errorCode: "CARD_DECLINED", errorDescription: "Card was declined" });

    const targetCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: targetObligation.id } });
    expect(targetCase.riskLevel).toBe("STANDARD");
  });
});

describe("negative/zero-amount payments — a non-positive amount is a data problem, not a transaction", () => {
  it("ignores a zero-amount webhook payment instead of corrupting the outstanding balance", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_ZERO_AMOUNT", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_zero", obligationId: obligation.referenceId, amountPaise: 0 });

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("UNPAID");
    expect(updated.outstandingAmountPaise).toBe(100000);

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "INVALID_PAYMENT_AMOUNT" } });
    expect(log.reasoning).toMatch(/non-positive/i);
  });

  it("ignores a negative-amount webhook payment instead of inflating the outstanding balance", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_NEGATIVE_AMOUNT", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_negative", obligationId: obligation.referenceId, amountPaise: -50000 });

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("UNPAID");
    // A naive "outstanding - paidAmount" without the guard would have
    // INCREASED outstanding to 150000 for a negative payment.
    expect(updated.outstandingAmountPaise).toBe(100000);
  });

  it("resolveExternalPayment ignores a non-positive amount and creates no attempt record for it", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_EXT_ZERO", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await resolveExternalPayment(obligation.id, "ext_zero_1", 0);

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("UNPAID");
    expect(updated.outstandingAmountPaise).toBe(100000);
    expect(await db.paymentAttempt.count({ where: { obligationId: obligation.id } })).toBe(0);
  });
});

describe("concurrency — two events racing for the same obligation", () => {
  it("resolves an obligation exactly once when two successful payments race for it", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_RACE_SUCCESS", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await Promise.all([
      pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_race_a", obligationId: obligation.referenceId, amountPaise: 100000 }),
      pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_race_b", obligationId: obligation.referenceId, amountPaise: 100000 }),
    ]);

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID");

    // Both payments were individually real and get recorded as attempts,
    // but only one of them may actually be credited as *the* resolution.
    const resolvedLogs = await db.auditLog.findMany({ where: { merchantId: merchant.id, action: "OBLIGATION_RESOLVED" } });
    expect(resolvedLogs.length).toBe(1);
  });

  it("resolves an obligation exactly once when an external payment and a provider webhook race for it", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_RACE_MIXED", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });

    await Promise.all([
      resolveExternalPayment(obligation.id, "ext_race_mixed"),
      pushRazorpayPaymentLinkPaid(merchant.id, { linkId: "plink_race_mixed", obligationId: obligation.referenceId, amountPaise: 100000 }),
    ]);

    const updated = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID");

    const resolvedLogs = await db.auditLog.findMany({ where: { merchantId: merchant.id, action: "OBLIGATION_RESOLVED" } });
    expect(resolvedLogs.length).toBe(1);
  });
});

describe("combined detection signals — outage and fraud on the same obligation at once", () => {
  it("blocks the action on fraud grounds even when the AI's own reasoning is driven by a suspected outage", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    const merchant = await createMerchant();
    const [obligationA, obligationB, target] = await Promise.all(
      ["ORDER_COMBINED_A", "ORDER_COMBINED_B", "ORDER_COMBINED_TARGET"].map((referenceId) =>
        createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId, amountPaise: 100000 })
      )
    );

    // Two other obligations each take one transient hit — enough, combined
    // with the target's own failures below, to cross the outage threshold.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_combined_a", obligationId: obligationA.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_combined_b", obligationId: obligationB.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });

    // Five transient failures on the target obligation itself: each one
    // also counts toward the merchant-wide outage signal (crossed after
    // the very first of these), and together they cross the target's own
    // fraud-velocity threshold.
    for (let i = 0; i < 5; i++) {
      await pushRazorpayFailure(merchant.id, { paymentId: `pay_combined_target_${i}`, obligationId: target.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT" });
    }

    const targetCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: target.id } });
    expect(targetCase.riskLevel).toBe("FRAUD_SUSPECTED");

    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: targetCase.id }, orderBy: { createdAt: "desc" } });
    // The AI's own proposal is still visibly driven by the outage signal...
    expect(lastAction.reason).toMatch(/outage/i);
    // ...but the policy layer blocks it on fraud grounds regardless —
    // neither signal silently suppresses the other in the audit trail,
    // and fraud wins the actual blocking decision.
    expect(lastAction.policyResult).toBe("BLOCKED");
    expect(lastAction.policyReasoning).toMatch(/fraud/i);
  });
});

describe("silent obligations — checkout drop-off and overdue B2B receivables never produce a provider event", () => {
  it("detects and recovers an abandoned checkout with zero payment attempts", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SILENT_CHECKOUT", amountPaise: 100000 });
    // Backdate creation past the 30-minute abandonment threshold — a
    // fresh checkout must never be flagged as abandoned.
    await db.paymentObligation.update({ where: { id: obligation.id }, data: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } });

    const result = await detectSilentObligations(merchant.id);
    expect(result.triggered).toBe(1);

    const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { obligationId: obligation.id } });
    expect(attempt.failureCategory).toBe("USER_DROPOFF");

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    // This cycle proposes GENERATE_PAYMENT_LINK and then, once it executes,
    // immediately runs another cycle that proposes a follow-up — two rows,
    // so an explicit order is required to reliably get the first one
    // (Postgres, unlike SQLite, doesn't return rows in insertion order
    // without one).
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "asc" } });
    expect(action.actionType).toBe("GENERATE_PAYMENT_LINK");
  });

  it("does not flag a checkout that hasn't gone stale yet", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SILENT_FRESH", amountPaise: 100000 });

    const result = await detectSilentObligations(merchant.id);
    expect(result.triggered).toBe(0);
    expect(await db.paymentAttempt.count({ where: { obligationId: obligation.id } })).toBe(0);
  });

  it("detects an overdue B2B invoice with zero payment attempts and sends a first reminder", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "INVOICE",
      referenceId: "INVOICE_SILENT_1",
      amountPaise: 500000,
      dueDate: new Date(Date.now() - 24 * 3_600_000), // due yesterday
    });

    const result = await detectSilentObligations(merchant.id);
    expect(result.triggered).toBe(1);

    const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { obligationId: obligation.id } });
    expect(attempt.failureCategory).toBe("RECEIVABLE_OVERDUE");

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("SEND_REMINDER");
  });

  it("does not flag an invoice that isn't due yet", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "INVOICE",
      referenceId: "INVOICE_SILENT_FUTURE",
      amountPaise: 500000,
      dueDate: new Date(Date.now() + 24 * 3_600_000), // due tomorrow
    });

    const result = await detectSilentObligations(merchant.id);
    expect(result.triggered).toBe(0);
    expect(await db.paymentAttempt.count({ where: { obligationId: obligation.id } })).toBe(0);
  });

  it("escalates an unanswered overdue-invoice reminder to a human instead of continuing to auto-message", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({
      merchantId: merchant.id,
      referenceType: "INVOICE",
      referenceId: "INVOICE_SILENT_ESCALATE",
      amountPaise: 500000,
      dueDate: new Date(Date.now() - 24 * 3_600_000),
    });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "OPEN", messagesSent: 1 } });
    await db.paymentAttempt.create({
      data: { obligationId: obligation.id, provider: "external", amountPaise: 500000, status: "FAILED", failureCategory: "RECEIVABLE_OVERDUE" },
    });

    await runRecoveryCycle(obligation.id);

    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("ESCALATE_TO_HUMAN");
    expect(action.reason).toMatch(/collections/i);
  });

  it("never touches an obligation that already has a real payment attempt on record", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_SILENT_HAS_ATTEMPT", amountPaise: 100000 });
    await db.paymentObligation.update({ where: { id: obligation.id }, data: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } });
    await db.paymentAttempt.create({
      data: { obligationId: obligation.id, provider: "razorpay", providerPaymentId: "pay_real", amountPaise: 100000, status: "FAILED", failureCategory: "GATEWAY_ERROR" },
    });

    const result = await detectSilentObligations(merchant.id);
    expect(result.triggered).toBe(0);
    expect(await db.paymentAttempt.count({ where: { obligationId: obligation.id } })).toBe(1);
  });

  it("is scoped per merchant when a merchantId is passed", async () => {
    const merchantA = await createMerchant();
    const merchantB = await createMerchant();
    const obligationA = await createObligation({ merchantId: merchantA.id, referenceType: "ORDER", referenceId: "ORDER_SILENT_TENANT_A", amountPaise: 100000 });
    const obligationB = await createObligation({ merchantId: merchantB.id, referenceType: "ORDER", referenceId: "ORDER_SILENT_TENANT_B", amountPaise: 100000 });
    await db.paymentObligation.update({ where: { id: obligationA.id }, data: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } });
    await db.paymentObligation.update({ where: { id: obligationB.id }, data: { createdAt: new Date(Date.now() - 45 * 60 * 1000) } });

    const result = await detectSilentObligations(merchantA.id);
    expect(result.triggered).toBe(1);
    expect(await db.paymentAttempt.count({ where: { obligationId: obligationB.id } })).toBe(0);
  });
});

describe("mandate retry sequencer — a failed UPI Autopay debit follows NPCI's retry limits, not a card's", () => {
  it("asks for mandate re-authorization instead of another retry once the cap is exhausted, end to end", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_MANDATE_1", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_mandate_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT", method: "emandate" });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_mandate_2", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT", method: "emandate" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(lastAction.actionType).toBe("OFFER_ALTERNATIVE_PAYMENT_METHOD");
    expect(lastAction.reason).toMatch(/mandate/i);
  });

  it("does not exhaust the mandate cap from an ordinary card's retries", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_MANDATE_CARD", amountPaise: 100000 });

    await pushRazorpayFailure(merchant.id, { paymentId: "pay_card_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT", method: "card" });
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_card_2", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "GATEWAY_TIMEOUT", method: "card" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(lastAction.reason).not.toMatch(/mandate/i);
  });
});

describe("promise-to-pay tracker — a real trigger, and a real consequence for breaking one", () => {
  it("records and executes a promise, parking the case for ~24h", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PROMISE_1", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "OPEN" } });

    await recordPromiseToPay(obligation.id, "Customer said they'll pay by Friday");

    const action = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id } });
    expect(action.actionType).toBe("RECORD_PROMISE_TO_PAY");
    expect(action.proposedBy).toBe("MERCHANT");
    expect(action.executionStatus).toBe("EXECUTED");

    const updatedCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
    expect(updatedCase.status).toBe("WAITING");
    expect(updatedCase.nextActionAt).not.toBeNull();
    const hoursUntilNext = (updatedCase.nextActionAt!.getTime() - Date.now()) / 3_600_000;
    expect(hoursUntilNext).toBeGreaterThan(23);
    expect(hoursUntilNext).toBeLessThanOrEqual(24);
  });

  it("is a no-op once the obligation is already paid", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PROMISE_PAID", amountPaise: 100000 });
    await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "OPEN" } });
    await resolveExternalPayment(obligation.id, "ext_promise_paid");

    const result = await recordPromiseToPay(obligation.id, "too late, already paid");
    expect(result).toMatchObject({ skipped: true });
  });

  it("escalates to a human on the next cycle once a promise goes unkept past its window", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PROMISE_BROKEN", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    // A promise recorded 25 hours ago — past the 24h window — with the
    // obligation still unpaid.
    await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "RECORD_PROMISE_TO_PAY",
        proposedBy: "MERCHANT",
        reason: "Customer promised to pay",
        executionStatus: "EXECUTED",
        executedAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });

    await runRecoveryCycle(obligation.id);

    const latestAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(latestAction.actionType).toBe("ESCALATE_TO_HUMAN");
    expect(latestAction.reason).toMatch(/broken/i);
  });

  it("does not escalate while a promise is still within its 24h window", async () => {
    const merchant = await createMerchant();
    const obligation = await createObligation({ merchantId: merchant.id, referenceType: "ORDER", referenceId: "ORDER_PROMISE_PENDING", amountPaise: 100000 });
    const recoveryCase = await db.recoveryCase.create({ data: { obligationId: obligation.id, status: "WAITING" } });
    await db.recoveryAction.create({
      data: {
        caseId: recoveryCase.id,
        actionType: "RECORD_PROMISE_TO_PAY",
        proposedBy: "MERCHANT",
        reason: "Customer promised to pay",
        executionStatus: "EXECUTED",
        executedAt: new Date(Date.now() - 2 * 3_600_000), // 2h ago — still well within the window
      },
    });

    await runRecoveryCycle(obligation.id);

    const latestAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(latestAction.actionType).not.toBe("ESCALATE_TO_HUMAN");
  });
});

describe("Hinglish voice recovery — a real, ready-to-use script for a high-value relationship, end to end", () => {
  it("recommends voice outreach with an embedded Hinglish script once automated attempts stop being productive", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    // Two touches happen back-to-back in this test with no real time
    // passing between them — disable the minimum contact gap so the
    // second touch isn't blocked on timing, which isn't what this test
    // is about.
    const merchant = await createMerchant({ minMessageGapHours: 0 });
    const customerId = "cust_high_voice_1";
    // 10 prior PAID obligations is what GenericEcommerceAdapter.getCustomerContext
    // treats as a HIGH-value customer.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.paymentObligation.create({
          data: {
            merchantId: merchant.id,
            referenceType: "ORDER",
            referenceId: `ORDER_VOICE_HISTORY_${i}`,
            customerId,
            originalAmountPaise: 100000,
            outstandingAmountPaise: 0,
            status: "PAID",
          },
        })
      )
    );
    const obligation = await db.paymentObligation.create({
      data: {
        merchantId: merchant.id,
        referenceType: "ORDER",
        referenceId: "ORDER_VOICE_TARGET",
        customerId,
        originalAmountPaise: 100000,
        outstandingAmountPaise: 100000,
        status: "UNPAID",
      },
    });

    // First hard decline: generates a payment link immediately, which
    // auto-executes (amount is well under the auto-approve ceiling) and
    // brings messagesSent to 1.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_voice_1", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "CARD_DECLINED", errorDescription: "Card was declined" });
    // Second failure: with messagesSent already at 1 (this tier's limit),
    // the next cycle should recommend voice outreach instead of a bare
    // escalation.
    await pushRazorpayFailure(merchant.id, { paymentId: "pay_voice_2", obligationId: obligation.referenceId, amountPaise: 100000, errorCode: "CARD_DECLINED", errorDescription: "Card was declined" });

    const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { obligationId: obligation.id } });
    const lastAction = await db.recoveryAction.findFirstOrThrow({ where: { caseId: recoveryCase.id }, orderBy: { createdAt: "desc" } });
    expect(lastAction.actionType).toBe("RECOMMEND_VOICE_OUTREACH");
    expect(lastAction.reason).toMatch(/Namaste/);
    expect(lastAction.policyResult).toBe("REQUIRES_APPROVAL");
  });
});
