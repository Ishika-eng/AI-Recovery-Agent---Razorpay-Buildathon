import { db } from "@/lib/db";
import { getProviderAdapter } from "@/lib/providers/registry";
import { merchantAdapter } from "@/lib/merchants/genericEcommerce";
import { decideRecoveryAction } from "@/lib/ai";
import { evaluatePolicy, type PolicyContext } from "@/lib/policy";
import { deliverAction } from "@/lib/actions";
import type { UniversalPaymentEvent, ActionType, RecoveryCaseContext, FailureCategory } from "@/lib/types";

async function audit(
  merchantId: string,
  actor: "AI" | "POLICY" | "MERCHANT" | "SYSTEM",
  action: string,
  reasoning: string,
  metadata?: Record<string, unknown>
) {
  await db.auditLog.create({
    data: { merchantId, actor, action, reasoning, metadata: metadata ? JSON.stringify(metadata) : null },
  });
}

// ---------------------------------------------------------------------------
// Obligation creation — the merchant side of the flow (a customer placing
// an order, subscribing, enrolling...) always happens before any provider
// ever sees a payment attempt. This is the "merchant system" creating its
// own record; provider webhooks only ever correlate against it afterward.
// ---------------------------------------------------------------------------

export async function createObligation(input: {
  merchantId: string;
  referenceType: string;
  referenceId: string;
  customerId?: string;
  customerContact?: string;
  amountPaise: number;
  currency?: string;
}) {
  return db.paymentObligation.create({
    data: {
      merchantId: input.merchantId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      customerId: input.customerId,
      customerContact: input.customerContact,
      originalAmountPaise: input.amountPaise,
      outstandingAmountPaise: input.amountPaise,
      currency: input.currency ?? "INR",
      status: "UNPAID",
    },
  });
}

// ---------------------------------------------------------------------------
// Inbound event ingestion — every provider webhook lands here after its
// adapter has already verified the signature and normalized the payload.
// ---------------------------------------------------------------------------

export async function ingestProviderEvent(provider: string, rawBody: string, headers: Headers, merchantId: string) {
  const adapter = getProviderAdapter(provider);

  if (!adapter.verifyWebhook(rawBody, headers)) {
    return { status: "rejected" as const, reason: "signature verification failed" };
  }

  const parsed = adapter.parseEvent(rawBody);
  const event = adapter.normalizeEvent(parsed, merchantId);

  if (!event) {
    return { status: "ignored" as const, reason: "event type not acted on, or missing obligation reference" };
  }

  // Idempotency ledger (PRD §20 Problem 1) — providers explicitly document
  // at-least-once / retried delivery, so a repeat delivery of the same
  // provider event id must be a no-op rather than a second recovery cycle.
  const existing = await db.externalEvent.findUnique({
    where: { merchantId_provider_externalEventId: { merchantId, provider, externalEventId: event.providerEventId } },
  });
  if (existing) {
    return { status: "duplicate" as const, externalEventId: existing.id };
  }

  const externalEvent = await db.externalEvent.create({
    data: {
      merchantId,
      provider,
      externalEventId: event.providerEventId,
      eventType: event.eventType,
      rawPayload: rawBody,
      processedAt: new Date(),
    },
  });

  const result = await processNormalizedEvent(event);
  return { status: "processed" as const, externalEventId: externalEvent.id, ...result };
}

async function processNormalizedEvent(event: UniversalPaymentEvent) {
  if (event.eventType === "DISPUTE_OPENED") {
    return handleDisputeOpened(event);
  }

  if (event.eventType === "REFUND_ISSUED") {
    return handleRefundIssued(event);
  }

  // Correlation, Priority 1 (PRD §17): the merchant-owned obligation
  // reference the adapter already extracted from provider metadata. We
  // never fall back to amount+customer matching — if it can't be found,
  // this goes to manual review instead of guessing.
  const obligationReferenceId = event.obligationReferenceId;
  const paymentAttempt = event.paymentAttempt;
  if (!obligationReferenceId || !paymentAttempt) {
    // Every non-dispute adapter output is required to carry both — this is
    // a defensive guard against a malformed adapter, not a real user path.
    return { correlated: false as const };
  }

  const obligation = await db.paymentObligation.findUnique({
    where: {
      merchantId_referenceType_referenceId: {
        merchantId: event.merchantId,
        referenceType: event.obligationReferenceType ?? "ORDER",
        referenceId: obligationReferenceId,
      },
    },
  });

  if (!obligation) {
    await audit(
      event.merchantId,
      "SYSTEM",
      "CORRELATION_FAILED",
      `Provider event referenced obligation "${obligationReferenceId}" which does not exist — routed to manual review instead of guessing a match.`,
      { provider: event.provider, obligationReferenceId }
    );
    return { correlated: false as const };
  }

  await db.paymentAttempt.create({
    data: {
      obligationId: obligation.id,
      provider: event.provider,
      providerPaymentId: paymentAttempt.providerPaymentId,
      providerEventId: event.providerEventId,
      paymentMethod: paymentAttempt.paymentMethod,
      amountPaise: paymentAttempt.amountPaise,
      currency: paymentAttempt.currency,
      status: paymentAttempt.status,
      failureCategory: paymentAttempt.failureCategory,
      failureReason: paymentAttempt.failureReason,
    },
  });

  if (event.customerContact && !obligation.customerContact) {
    await db.paymentObligation.update({
      where: { id: obligation.id },
      data: { customerContact: event.customerContact },
    });
  }

  if (event.eventType === "PAYMENT_SUCCEEDED") {
    // Attribution (PRD Problem 7): only credit a specific RecoveryAction
    // when we can trace this success back to something *we* generated — a
    // payment link this platform created. Match it by the link's own id,
    // which the adapter surfaces only when the success genuinely came
    // through payment_link.paid. Anything else (a customer retrying
    // normally, a cross-channel payment) resolves the obligation exactly
    // as before, but honestly records no attributed action — "resolved,
    // cause unknown" beats a false claim of causing it.
    let attributedActionId: string | undefined;
    if (event.paymentLinkId) {
      const matchedAction = await db.recoveryAction.findFirst({
        where: { deliveryRef: event.paymentLinkId, case: { obligationId: obligation.id } },
        orderBy: { createdAt: "desc" },
      });
      attributedActionId = matchedAction?.id;
    }

    await resolveObligation(
      obligation.id,
      event.provider,
      paymentAttempt.providerPaymentId ?? event.providerEventId,
      attributedActionId
    );
    return { correlated: true as const, obligationId: obligation.id, result: "resolved" as const };
  }

  if (event.eventType === "PAYMENT_FAILED") {
    await runRecoveryCycle(obligation.id);
    return { correlated: true as const, obligationId: obligation.id, result: "recovery_cycle_run" as const };
  }

  return { correlated: true as const, obligationId: obligation.id, result: "noop" as const };
}

// A dispute/chargeback carries the disputed payment's provider id, not the
// merchant's own obligation reference — so it correlates through the
// PaymentAttempt we already recorded for that payment, not the standard
// reference lookup above. PRD Problem 9: a disputed payment must stop all
// automated collection and go to a human, not keep getting reminders while
// it's contested.
async function handleDisputeOpened(event: UniversalPaymentEvent) {
  if (!event.disputedPaymentId) return { correlated: false as const };

  const attempt = await db.paymentAttempt.findFirst({
    where: {
      provider: event.provider,
      providerPaymentId: event.disputedPaymentId,
      obligation: { merchantId: event.merchantId },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!attempt) {
    await audit(
      event.merchantId,
      "SYSTEM",
      "CORRELATION_FAILED",
      `Dispute opened on payment "${event.disputedPaymentId}" but no matching payment attempt is on record — routed to manual review.`,
      { provider: event.provider, disputedPaymentId: event.disputedPaymentId }
    );
    return { correlated: false as const };
  }

  const recoveryCase = await db.recoveryCase.findUnique({ where: { obligationId: attempt.obligationId } });
  if (recoveryCase) {
    await db.recoveryCase.update({
      where: { id: recoveryCase.id },
      data: { riskLevel: "DISPUTE_ACTIVE", status: "ESCALATED" },
    });
    // Same treatment as a cross-channel resolution: anything still awaiting
    // execution or approval must not go out while the payment is contested.
    await db.recoveryAction.updateMany({
      where: { caseId: recoveryCase.id, executionStatus: { in: ["PROPOSED", "PENDING_APPROVAL", "APPROVED"] } },
      data: { executionStatus: "POLICY_BLOCKED" },
    });
  }

  await audit(
    event.merchantId,
    "SYSTEM",
    "DISPUTE_OPENED",
    `A dispute was opened on payment ${event.disputedPaymentId} — automated recovery stopped${recoveryCase ? " and the case was escalated to the merchant" : ""}; the AI must not pressure a customer mid-dispute.`,
    { obligationId: attempt.obligationId, disputedPaymentId: event.disputedPaymentId, provider: event.provider }
  );

  return { correlated: true as const, obligationId: attempt.obligationId, result: "dispute_opened" as const };
}

// PRD Problem 26: a payment already counted as recovered can still be
// refunded or charged back — without this, "₹ recovered" on the dashboard
// keeps claiming revenue that was actually given back. Correlates the same
// way disputes do: through the refunded payment's provider id against the
// PaymentAttempt already on record, since a refund payload doesn't carry
// the merchant's own obligation reference either. Deliberately does *not*
// restart recovery — a refund is usually a deliberate business decision
// (return, cancellation), not something to auto-re-chase.
async function handleRefundIssued(event: UniversalPaymentEvent) {
  if (!event.refundedPaymentId) return { correlated: false as const };

  const attempt = await db.paymentAttempt.findFirst({
    where: {
      provider: event.provider,
      providerPaymentId: event.refundedPaymentId,
      obligation: { merchantId: event.merchantId },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!attempt) {
    await audit(
      event.merchantId,
      "SYSTEM",
      "CORRELATION_FAILED",
      `Refund issued for payment "${event.refundedPaymentId}" but no matching payment attempt is on record — routed to manual review.`,
      { provider: event.provider, refundedPaymentId: event.refundedPaymentId }
    );
    return { correlated: false as const };
  }

  const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: attempt.obligationId } });
  // The provider reports a cumulative refunded total on the payment, not a
  // delta — set, don't add, so a redelivered or repeated webhook can never
  // double-count.
  const refundedAmountPaise = event.refundAmountPaise ?? attempt.amountPaise;
  const isFullRefund = refundedAmountPaise >= obligation.originalAmountPaise;

  await db.paymentObligation.update({
    where: { id: obligation.id },
    data: {
      refundedAmountPaise,
      status: isFullRefund ? "REFUNDED" : obligation.status,
    },
  });

  await audit(
    obligation.merchantId,
    "SYSTEM",
    "REFUND_ISSUED",
    `₹${(refundedAmountPaise / 100).toFixed(2)} refunded on payment ${event.refundedPaymentId}${
      isFullRefund
        ? " — obligation marked REFUNDED; recovery is not being restarted automatically, and this amount no longer counts toward recovered revenue"
        : " (partial — outstanding recovered total adjusted accordingly)"
    }.`,
    { obligationId: obligation.id, refundedPaymentId: event.refundedPaymentId, refundedAmountPaise, isFullRefund }
  );

  return { correlated: true as const, obligationId: obligation.id, result: "refund_issued" as const };
}

// ---------------------------------------------------------------------------
// Cross-channel resolution — the mandatory feature from PRD §13/§14. The
// moment ANY channel resolves the obligation, everything scheduled against
// it stops atomically. This is the "customer already paid elsewhere" demo
// moment: if a case had a scheduled action pending, that's surfaced
// explicitly as a prevented action, not silently dropped.
// ---------------------------------------------------------------------------

export async function resolveObligation(
  obligationId: string,
  source: string,
  paymentReference: string,
  attributedActionId?: string
) {
  const obligation = await db.paymentObligation.findUniqueOrThrow({
    where: { id: obligationId },
    include: { recoveryCase: true },
  });

  if (obligation.status === "PAID") {
    return obligation; // already resolved — nothing to do (idempotent)
  }

  const updated = await db.paymentObligation.update({
    where: { id: obligationId },
    data: {
      status: "PAID",
      outstandingAmountPaise: 0,
      resolvedAt: new Date(),
      resolutionSource: source,
    },
  });

  // Attribution (PRD Problem 7): only ever credit an action when the
  // caller traced this resolution back to something that action actually
  // produced (see the paymentLinkId match in processNormalizedEvent) —
  // never inferred from "a case existed at the time."
  if (attributedActionId) {
    await db.recoveryAction.update({
      where: { id: attributedActionId },
      data: { recoveredPaise: obligation.originalAmountPaise },
    });
  }

  await audit(
    obligation.merchantId,
    "SYSTEM",
    "OBLIGATION_RESOLVED",
    attributedActionId
      ? `Obligation ${obligation.referenceId} resolved via ${source} (${paymentReference}) — ₹${(obligation.originalAmountPaise / 100).toFixed(2)}, confirmed attributable to a recovery action this platform took.`
      : `Obligation ${obligation.referenceId} resolved via ${source} (${paymentReference}) — ₹${(obligation.originalAmountPaise / 100).toFixed(2)}. Not attributed to a specific recovery action — the customer may have paid regardless of it.`,
    { obligationId, source, paymentReference, attributedActionId: attributedActionId ?? null }
  );

  const recoveryCase = obligation.recoveryCase;
  if (recoveryCase && recoveryCase.status !== "RESOLVED" && recoveryCase.status !== "CANCELLED") {
    const hadScheduledAction = Boolean(recoveryCase.nextAction);

    await db.recoveryCase.update({
      where: { id: recoveryCase.id },
      data: { status: "RESOLVED", nextAction: null, nextActionAt: null, resolvedAt: new Date() },
    });

    // Cancel every action still awaiting approval/execution on this case —
    // an approved-but-not-yet-executed reminder must never go out after the
    // obligation is already paid.
    await db.recoveryAction.updateMany({
      where: { caseId: recoveryCase.id, executionStatus: { in: ["PROPOSED", "PENDING_APPROVAL", "APPROVED"] } },
      data: { executionStatus: "SKIPPED_ALREADY_PAID" },
    });

    if (hadScheduledAction) {
      await audit(
        obligation.merchantId,
        "SYSTEM",
        "RECOVERY_ACTION_PREVENTED",
        `Customer had already paid through ${source} — cancelled the scheduled "${recoveryCase.nextAction}" and closed the recovery case instead of contacting them.`,
        { obligationId, caseId: recoveryCase.id, cancelledAction: recoveryCase.nextAction }
      );
    } else {
      await audit(
        obligation.merchantId,
        "SYSTEM",
        "RECOVERY_CASE_CLOSED",
        `Recovery case closed — obligation resolved via ${source} before any further action was needed.`,
        { obligationId, caseId: recoveryCase.id }
      );
    }
  }

  await merchantAdapter.notifyStatusChange(obligationId, "PAID");

  return updated;
}

// Method A from PRD §16 — merchant/alt-provider push reporting a payment
// that happened entirely outside a channel this platform has a webhook for
// (bank transfer, cash, a provider with no adapter yet). Also what the demo
// "customer paid elsewhere" button calls.
export async function resolveExternalPayment(obligationId: string, reference: string) {
  const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } });

  await db.paymentAttempt.create({
    data: {
      obligationId,
      provider: "external",
      providerPaymentId: reference,
      amountPaise: obligation.outstandingAmountPaise,
      currency: obligation.currency,
      status: "SUCCEEDED",
    },
  });

  return resolveObligation(obligationId, "external", reference);
}

// PRD Problem 11: the moment a customer says "don't contact me," every
// automated channel stops — permanently, not just for the action in
// flight. Two real triggers call this: the unsubscribe link on every
// email this platform actually sends (src/lib/actions/email.ts via
// src/app/api/optout/route.ts), and a merchant marking a case opted-out
// by hand after a customer says so on a call. Policy Engine already
// enforces `contactOptedOut` on every customer-facing proposal — this is
// what finally sets that flag instead of it sitting unused.
export async function optOutCustomer(obligationId: string, reason: string) {
  const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } });
  const recoveryCase = await db.recoveryCase.findUnique({ where: { obligationId } });
  if (!recoveryCase) return null;

  await db.recoveryCase.update({ where: { id: recoveryCase.id }, data: { contactOptedOut: true } });

  await db.recoveryAction.updateMany({
    where: { caseId: recoveryCase.id, executionStatus: { in: ["PROPOSED", "PENDING_APPROVAL", "APPROVED"] } },
    data: { executionStatus: "POLICY_BLOCKED" },
  });

  await audit(
    obligation.merchantId,
    "SYSTEM",
    "CUSTOMER_OPTED_OUT",
    `Customer opted out of contact (${reason}) — all automated communication for this obligation stops.`,
    { obligationId, caseId: recoveryCase.id }
  );

  return db.recoveryCase.findUniqueOrThrow({ where: { id: recoveryCase.id } });
}

// The missing terminal state: a case can escalate to a merchant, the
// merchant can reject one proposed action, and reject a dozen more after
// it — but until now nothing actually *closed* the case. "Runs out of
// runway and needs a human decision on whether to keep trying or write it
// off" only half-existed: the human decision point (the approval queue)
// worked, but "write it off" had nowhere to go. This is that path —
// a deliberate, terminal, merchant-made decision, distinct from
// resolveObligation() (money arrived) and STOP_RECOVERY (the AI proposed
// pausing, which is not the same as a human giving up on it).
export async function writeOffObligation(obligationId: string, reason: string) {
  const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } });

  if (obligation.status === "PAID" || obligation.status === "CANCELLED") {
    return obligation; // already resolved, or already written off — idempotent no-op
  }

  const updated = await db.paymentObligation.update({
    where: { id: obligationId },
    data: { status: "CANCELLED", resolvedAt: new Date(), resolutionSource: "write_off" },
  });

  const recoveryCase = await db.recoveryCase.findUnique({ where: { obligationId } });
  if (recoveryCase && recoveryCase.status !== "RESOLVED" && recoveryCase.status !== "CANCELLED") {
    await db.recoveryCase.update({
      where: { id: recoveryCase.id },
      data: { status: "CANCELLED", nextAction: null, nextActionAt: null, resolvedAt: new Date() },
    });
    await db.recoveryAction.updateMany({
      where: { caseId: recoveryCase.id, executionStatus: { in: ["PROPOSED", "PENDING_APPROVAL", "APPROVED"] } },
      data: { executionStatus: "POLICY_BLOCKED" },
    });
  }

  await audit(
    obligation.merchantId,
    "MERCHANT",
    "WRITE_OFF",
    `Merchant wrote off this obligation (${reason}) — recovery stops permanently; this is a business decision, not a resolution.`,
    { obligationId, caseId: recoveryCase?.id }
  );

  return updated;
}

// ---------------------------------------------------------------------------
// Recovery cycle — one pass of: verify → gather context → AI proposes →
// Policy gates → execute (or park for approval). This is what runs after
// every failure event, and again whenever a case is manually advanced
// (WAIT elapsing, a follow-up coming due).
// ---------------------------------------------------------------------------

async function ensureRecoveryCase(obligationId: string) {
  const existing = await db.recoveryCase.findUnique({ where: { obligationId } });
  if (existing) return existing;
  return db.recoveryCase.create({ data: { obligationId, status: "OPEN" } });
}

export async function runRecoveryCycle(obligationId: string) {
  // Mandatory pre-action verification (PRD §15) — re-read the obligation
  // fresh, every cycle. A delayed success event or a duplicate/out-of-order
  // failure must never push a resolved obligation through recovery.
  const obligation = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligationId } });
  if (obligation.status === "PAID") {
    return { skipped: true as const, reason: "obligation already PAID at cycle start" };
  }

  const recoveryCase = await ensureRecoveryCase(obligationId);
  if (recoveryCase.status === "RESOLVED" || recoveryCase.status === "CANCELLED") {
    return { skipped: true as const, reason: `case is already ${recoveryCase.status}` };
  }

  const [attempts, merchant] = await Promise.all([
    db.paymentAttempt.findMany({ where: { obligationId }, orderBy: { createdAt: "asc" } }),
    db.merchant.findUniqueOrThrow({ where: { id: obligation.merchantId } }),
  ]);

  const customerContext = obligation.customerId
    ? await merchantAdapter.getCustomerContext(obligation.customerId)
    : { relationshipAgeDays: 0, successfulPayments: 0, customerValue: "STANDARD" as const };

  const failedAttempts = attempts.filter((a) => a.status === "FAILED");
  const context: RecoveryCaseContext = {
    obligation: {
      id: obligation.id,
      amountPaise: obligation.originalAmountPaise,
      outstandingAmountPaise: obligation.outstandingAmountPaise,
      status: obligation.status as RecoveryCaseContext["obligation"]["status"],
    },
    customer: customerContext,
    paymentHistory: attempts.map((a) => ({
      provider: a.provider as RecoveryCaseContext["paymentHistory"][number]["provider"],
      status: a.status as RecoveryCaseContext["paymentHistory"][number]["status"],
      failureCategory: (a.failureCategory ?? undefined) as FailureCategory | undefined,
    })),
    recoveryHistory: {
      messagesSent: recoveryCase.messagesSent,
      retryCount: failedAttempts.length,
      waitedAlready: false, // set below
      lastActionAt: null, // set below
    },
    allowedActions: merchantAdapter.getAvailableRecoveryActions(),
  };

  const executedActions = await db.recoveryAction.findMany({
    where: { caseId: recoveryCase.id, executionStatus: "EXECUTED" },
    orderBy: { executedAt: "desc" },
  });
  context.recoveryHistory.waitedAlready = executedActions.some((a) => a.actionType === "WAIT");
  const lastCustomerFacingAction = executedActions.find((a) =>
    (["SEND_REMINDER", "GENERATE_PAYMENT_LINK", "OFFER_ALTERNATIVE_PAYMENT_METHOD"] as ActionType[]).includes(
      a.actionType as ActionType
    )
  );
  context.recoveryHistory.lastActionAt = lastCustomerFacingAction?.executedAt?.toISOString() ?? null;

  const decision = decideRecoveryAction(context);

  await audit(obligation.merchantId, "AI", "PROPOSE_ACTION", decision.reason, {
    obligationId,
    caseId: recoveryCase.id,
    action: decision.action,
  });

  const policyCtx: PolicyContext = {
    obligationStatus: obligation.status,
    outstandingAmountPaise: obligation.outstandingAmountPaise,
    contactOptedOut: recoveryCase.contactOptedOut,
    riskLevel: recoveryCase.riskLevel as PolicyContext["riskLevel"],
    messagesSentToday: await countMessagesSentToday(obligation.merchantId),
    messagesSentThisCase: recoveryCase.messagesSent,
    retryCount: recoveryCase.recoveryAttempts,
    hourOfDay: new Date().getHours(),
    lastActionAt: lastCustomerFacingAction?.executedAt ?? null,
    merchant: {
      maxAutoRetries: merchant.maxAutoRetries,
      maxMessagesPerCase: merchant.maxMessagesPerCase,
      minMessageGapHours: merchant.minMessageGapHours,
      autoApproveUnderPaise: merchant.autoApproveUnderPaise,
      contactWindowStartHour: merchant.contactWindowStartHour,
      contactWindowEndHour: merchant.contactWindowEndHour,
    },
  };

  const verdict = evaluatePolicy(decision.action, policyCtx);

  await audit(obligation.merchantId, "POLICY", "EVALUATE_ACTION", verdict.reasoning, {
    obligationId,
    caseId: recoveryCase.id,
    action: decision.action,
    result: verdict.result,
  });

  const action = await db.recoveryAction.create({
    data: {
      caseId: recoveryCase.id,
      actionType: decision.action,
      proposedBy: "AI",
      reason: decision.reason,
      policyResult: verdict.result,
      policyReasoning: verdict.reasoning,
      executionStatus:
        verdict.result === "BLOCKED" ? "POLICY_BLOCKED" : verdict.result === "REQUIRES_APPROVAL" ? "PENDING_APPROVAL" : "PROPOSED",
    },
  });

  if (verdict.result === "ALLOWED") {
    return executeAction(action.id, decision.waitMinutes);
  }

  if (verdict.result === "BLOCKED" || verdict.result === "REQUIRES_APPROVAL") {
    // Neither is a dead end for the case — e.g. WAIT is always allowed, so
    // a BLOCKED customer-facing action just means "hold" until the next
    // trigger; REQUIRES_APPROVAL means "hold until a merchant decides".
    // Either way there is a pending next step, which is exactly what a
    // cross-channel resolution must be able to cancel.
    //
    // BLOCKED holds get a real nextActionAt so the scheduler (processDueCases)
    // picks them back up once the guardrail that blocked them plausibly
    // clears (contact window opens, minimum message gap elapses) — without
    // this, a case blocked by a time-based guardrail would never advance on
    // its own. A permanent-ish hold (opt-out, active dispute) isn't
    // time-based, so it's left off the clock instead of polled forever.
    // REQUIRES_APPROVAL is always off the clock — only a merchant decision
    // moves it, not the passage of time.
    const permanentHold = /opted out|dispute/i.test(verdict.reasoning);
    await db.recoveryCase.update({
      where: { id: recoveryCase.id },
      data: {
        status: "WAITING",
        nextAction: decision.action,
        nextActionAt:
          verdict.result === "BLOCKED" && !permanentHold ? new Date(Date.now() + 3_600_000) : null,
      },
    });
  }

  return { action, verdict };
}

async function countMessagesSentToday(merchantId: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return db.recoveryAction.count({
    where: {
      executionStatus: "EXECUTED",
      actionType: { in: ["SEND_REMINDER", "GENERATE_PAYMENT_LINK", "OFFER_ALTERNATIVE_PAYMENT_METHOD"] },
      executedAt: { gte: startOfDay },
      case: { obligation: { merchantId } },
    },
  });
}

// Fallback-only recovery rates. These are used exclusively when
// deliverAction() reports `simulated: true` — i.e. no real channel was
// configured (RAZORPAY_KEY_ID/SECRET, SMTP_*) or an email-shaped contact
// wasn't on file, so nothing actually reached the customer and there's no
// real webhook to eventually close the loop. When a real channel *was*
// used, this is never consulted — resolution comes from resolveObligation()
// being called by an actual payment.captured/payment_link.paid webhook,
// same as any other channel.
const RECOVERY_RATES: Partial<Record<ActionType, number>> = {
  SEND_REMINDER: 0.3,
  GENERATE_PAYMENT_LINK: 0.55,
  OFFER_ALTERNATIVE_PAYMENT_METHOD: 0.45,
};

export async function executeAction(actionId: string, waitMinutes?: number) {
  const action = await db.recoveryAction.findUniqueOrThrow({
    where: { id: actionId },
    include: { case: { include: { obligation: true } } },
  });

  if (action.executionStatus === "EXECUTED" || action.executionStatus === "REJECTED" || action.executionStatus === "SKIPPED_ALREADY_PAID") {
    return action;
  }

  const { case: recoveryCase } = action;
  const obligation = recoveryCase.obligation;

  // Re-verify one more time, immediately before doing anything — the time
  // between proposal and execution (e.g. merchant approval) is exactly the
  // window PRD §15 worries about.
  const fresh = await db.paymentObligation.findUniqueOrThrow({ where: { id: obligation.id } });
  if (fresh.status === "PAID") {
    const skipped = await db.recoveryAction.update({
      where: { id: actionId },
      data: { executionStatus: "SKIPPED_ALREADY_PAID" },
    });
    await audit(obligation.merchantId, "SYSTEM", "ACTION_SKIPPED", "Obligation was resolved between proposal and execution — skipped.", { actionId });
    return skipped;
  }

  try {
    const type = action.actionType as ActionType;

    if (type === "WAIT") {
      await db.recoveryCase.update({
        where: { id: recoveryCase.id },
        data: {
          status: "WAITING",
          nextAction: "VERIFY_PAYMENT",
          nextActionAt: new Date(Date.now() + (waitMinutes ?? 2) * 60_000),
        },
      });
      const executed = await db.recoveryAction.update({
        where: { id: actionId },
        data: { executionStatus: "EXECUTED", executedAt: new Date() },
      });
      await audit(obligation.merchantId, "SYSTEM", "EXECUTE_ACTION", `WAIT executed — re-checking in ${waitMinutes ?? 2} minute(s).`, { actionId });
      return executed;
    }

    if (type === "RECORD_PROMISE_TO_PAY") {
      await db.recoveryCase.update({
        where: { id: recoveryCase.id },
        data: { status: "WAITING", nextAction: "VERIFY_PAYMENT", nextActionAt: new Date(Date.now() + 24 * 3_600_000) },
      });
      return finishExecution(actionId, obligation.merchantId, "Promise-to-pay recorded; will re-verify in 24h.");
    }

    if (type === "ESCALATE_TO_HUMAN") {
      await db.recoveryCase.update({ where: { id: recoveryCase.id }, data: { status: "ESCALATED" } });
      return finishExecution(actionId, obligation.merchantId, "Case escalated to merchant.");
    }

    if (type === "STOP_RECOVERY") {
      await db.recoveryCase.update({
        where: { id: recoveryCase.id },
        data: { status: "CANCELLED", nextAction: null, nextActionAt: null, resolvedAt: new Date() },
      });
      return finishExecution(actionId, obligation.merchantId, "Recovery stopped for this case.");
    }

    if (type === "SCHEDULE_FOLLOW_UP") {
      const merchant = await db.merchant.findUniqueOrThrow({ where: { id: obligation.merchantId } });
      await db.recoveryCase.update({
        where: { id: recoveryCase.id },
        data: {
          status: "WAITING",
          nextAction: "SEND_REMINDER",
          nextActionAt: new Date(Date.now() + merchant.minMessageGapHours * 3_600_000),
        },
      });
      return finishExecution(actionId, obligation.merchantId, `Follow-up scheduled in ${merchant.minMessageGapHours}h — holding until the minimum contact gap elapses.`);
    }

    if (type === "VERIFY_PAYMENT") {
      const executed = await finishExecution(actionId, obligation.merchantId, "Verified obligation status directly against the merchant record.");
      // Verification itself doesn't change anything — immediately run
      // another cycle so the case keeps moving instead of stalling.
      await runRecoveryCycle(obligation.id);
      return executed;
    }

    // Customer-facing actions: increment counters, actually try to reach
    // the customer, and only fall back to a simulated outcome if nothing
    // real was possible.
    await db.recoveryCase.update({
      where: { id: recoveryCase.id },
      data: {
        messagesSent: { increment: 1 },
        recoveryAttempts: type === "GENERATE_PAYMENT_LINK" ? { increment: 1 } : undefined,
        status: "WAITING",
        nextAction: null,
        nextActionAt: null,
      },
    });

    const delivery = await deliverAction(type, {
      id: obligation.id,
      referenceId: obligation.referenceId,
      outstandingAmountPaise: obligation.outstandingAmountPaise,
      currency: obligation.currency,
      customerContact: obligation.customerContact,
    });

    await db.recoveryAction.update({
      where: { id: actionId },
      data: { deliveryChannel: delivery.channel, deliveryRef: delivery.ref ?? null },
    });

    const executed = await finishExecution(actionId, obligation.merchantId, delivery.note);

    if (delivery.simulated) {
      const recoveryRate = RECOVERY_RATES[type] ?? 0;
      if (Math.random() < recoveryRate) {
        await db.recoveryAction.update({ where: { id: actionId }, data: { recoveredPaise: obligation.outstandingAmountPaise } });
        await resolveObligation(obligation.id, "razorpay", `sim_${actionId}`);
        return executed;
      }
    }

    // Either a real channel was used (resolution now waits on a real
    // webhook — payment.captured / payment_link.paid) or the simulated
    // roll didn't recover it. Either way, immediately determine the next
    // step (another reminder, a follow-up, escalation...) so the case
    // always has a scheduled next action visible rather than sitting
    // inert. This is what a cross-channel payment cancels if it lands
    // before the customer acts on it.
    await runRecoveryCycle(obligation.id);

    return executed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await db.recoveryAction.update({
      where: { id: actionId },
      data: { executionStatus: "FAILED", executedAt: new Date() },
    });
    await audit(obligation.merchantId, "SYSTEM", "EXECUTION_FAILED", `${action.actionType} failed to execute: ${message}`, { actionId, error: message });
    return failed;
  }
}

async function finishExecution(actionId: string, merchantId: string, reasoning: string) {
  const executed = await db.recoveryAction.update({
    where: { id: actionId },
    data: { executionStatus: "EXECUTED", executedAt: new Date() },
  });
  await audit(merchantId, "SYSTEM", "EXECUTE_ACTION", reasoning, { actionId });
  return executed;
}

export async function approveAction(actionId: string) {
  const action = await db.recoveryAction.findUniqueOrThrow({
    where: { id: actionId },
    include: { case: { include: { obligation: true } } },
  });

  await db.recoveryAction.update({ where: { id: actionId }, data: { executionStatus: "APPROVED", decidedAt: new Date() } });
  await audit(action.case.obligation.merchantId, "MERCHANT", "APPROVE_ACTION", `Merchant approved ${action.actionType} for case ${action.caseId}.`, { actionId });

  return executeAction(actionId);
}

export async function rejectAction(actionId: string) {
  const action = await db.recoveryAction.findUniqueOrThrow({
    where: { id: actionId },
    include: { case: true },
  });

  const updated = await db.recoveryAction.update({ where: { id: actionId }, data: { executionStatus: "REJECTED", decidedAt: new Date() } });

  await db.recoveryCase.update({ where: { id: action.caseId }, data: { status: "ESCALATED" } });

  await audit(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: action.caseId }, include: { obligation: true } })).obligation.merchantId,
    "MERCHANT",
    "REJECT_ACTION",
    `Merchant rejected ${action.actionType} for case ${action.caseId}.`,
    { actionId }
  );

  return updated;
}

// Manual "tick" — advances a WAITING case (used by the demo UI in place of
// a real scheduler/cron, and by tests) by re-running the recovery cycle.
export async function advanceCase(caseId: string) {
  const recoveryCase = await db.recoveryCase.findUniqueOrThrow({ where: { id: caseId } });
  return runRecoveryCycle(recoveryCase.obligationId);
}

// ---------------------------------------------------------------------------
// Autonomous scheduling — without this, the recovery cycle only ever
// advances when a provider webhook happens to arrive or a human clicks
// Advance on the dashboard. A WAIT or SCHEDULE_FOLLOW_UP case whose
// nextActionAt has passed, with nobody watching, would otherwise sit
// unpaid forever with no reminder ever sent — which is most of what this
// agent exists to prevent. This is the function an external scheduler
// (see src/app/api/cron/tick/route.ts) calls periodically, across every
// merchant, to pick those cases back up on its own.
// ---------------------------------------------------------------------------

export async function processDueCases(now: Date = new Date()) {
  const dueCases = await db.recoveryCase.findMany({
    where: { status: "WAITING", nextActionAt: { lte: now } },
    select: {
      id: true,
      obligationId: true,
      // A case awaiting merchant sign-off must never be auto-advanced —
      // that would silently re-propose (and could duplicate) an action a
      // human is already supposed to be deciding on.
      actions: { where: { executionStatus: "PENDING_APPROVAL" }, select: { id: true }, take: 1 },
    },
  });

  const results: Array<{ caseId: string; obligationId: string; skipped?: string; outcome?: unknown }> = [];

  for (const c of dueCases) {
    if (c.actions.length > 0) {
      results.push({ caseId: c.id, obligationId: c.obligationId, skipped: "pending_approval" });
      continue;
    }
    const outcome = await runRecoveryCycle(c.obligationId);
    results.push({ caseId: c.id, obligationId: c.obligationId, outcome });
  }

  return { processedAt: now.toISOString(), dueCount: dueCases.length, results };
}
