import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  advanceCase,
  approveAction,
  createObligation,
  ingestProviderEvent,
  processDueCases,
  rejectAction,
  resolveExternalPayment,
  runRecoveryCycle,
} from "@/lib/engine";
import { createMerchant, resetDb } from "./helpers";

function razorpayFailedBody(opts: { paymentId: string; obligationId: string; amountPaise: number; errorCode?: string; errorDescription?: string }) {
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
          method: "upi",
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
