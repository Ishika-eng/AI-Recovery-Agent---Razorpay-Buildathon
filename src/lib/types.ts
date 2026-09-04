import { z } from "zod";

// Mirrors the string-typed "enum" fields in prisma/schema.prisma — SQLite
// has no native enum support, so these arrays are the single source of
// truth for valid values, enforced with zod at every write boundary.

export const FAILURE_CATEGORIES = [
  "ISSUER_DECLINE",
  "EXPIRED_CARD",
  "TIMEOUT",
  "INSUFFICIENT_FUNDS",
  "GATEWAY_ERROR",
  "NETWORK_ERROR",
  "USER_DROPOFF",
  "RECEIVABLE_OVERDUE",
  "UNKNOWN",
] as const;
export const FailureCategory = z.enum(FAILURE_CATEGORIES);
export type FailureCategory = z.infer<typeof FailureCategory>;

export const OBLIGATION_STATUSES = [
  "PENDING",
  "PAYMENT_IN_PROGRESS",
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "CANCELLED",
  "EXPIRED",
  "REFUNDED",
] as const;
export const ObligationStatus = z.enum(OBLIGATION_STATUSES);
export type ObligationStatus = z.infer<typeof ObligationStatus>;

export const ATTEMPT_STATUSES = ["CREATED", "FAILED", "SUCCEEDED"] as const;
export const AttemptStatus = z.enum(ATTEMPT_STATUSES);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const CASE_STATUSES = ["OPEN", "WAITING", "RESOLVED", "ESCALATED", "CANCELLED"] as const;
export const CaseStatus = z.enum(CASE_STATUSES);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const RISK_LEVELS = ["STANDARD", "HIGH_VALUE", "DISPUTE_ACTIVE", "FRAUD_SUSPECTED"] as const;
export const RiskLevel = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const ACTION_TYPES = [
  "WAIT",
  "VERIFY_PAYMENT",
  "SEND_REMINDER",
  "GENERATE_PAYMENT_LINK",
  "OFFER_ALTERNATIVE_PAYMENT_METHOD",
  "SCHEDULE_FOLLOW_UP",
  "RECORD_PROMISE_TO_PAY",
  "ESCALATE_TO_HUMAN",
  "STOP_RECOVERY",
] as const;
export const ActionType = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionType>;

export const EXECUTION_STATUSES = [
  "PROPOSED",
  "POLICY_BLOCKED",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "EXECUTED",
  "FAILED",
  "SKIPPED_ALREADY_PAID",
] as const;
export const ExecutionStatus = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const AUDIT_ACTORS = ["AI", "POLICY", "MERCHANT", "SYSTEM"] as const;
export const AuditActor = z.enum(AUDIT_ACTORS);
export type AuditActor = z.infer<typeof AuditActor>;

export const PROVIDERS = ["razorpay", "stripe", "external"] as const;
export const Provider = z.enum(PROVIDERS);
export type Provider = z.infer<typeof Provider>;

// ---------------------------------------------------------------------------
// Universal Payment Event Model — every provider adapter normalizes its
// provider-specific webhook payload into exactly this shape before it ever
// reaches the core engine. The engine (and any future AI layer) never sees
// a raw Razorpay/Stripe payload.
// ---------------------------------------------------------------------------

export const UniversalPaymentEvent = z.object({
  eventType: z.enum(["PAYMENT_FAILED", "PAYMENT_SUCCEEDED", "PAYMENT_PENDING", "DISPUTE_OPENED", "REFUND_ISSUED"]),
  provider: Provider,
  providerEventId: z.string(),
  merchantId: z.string(),

  // The merchant-owned reference this attempt should correlate to — passed
  // through provider metadata (order.receipt, payment_intent.metadata, etc).
  // This is Priority-1 correlation per the PRD: never merge obligations on
  // amount+customer alone. Absent for DISPUTE_OPENED — a dispute payload
  // doesn't carry the merchant's own reference, only the disputed payment's
  // provider id, so that event type correlates through disputedPaymentId
  // (a PaymentAttempt lookup) instead. See processNormalizedEvent.
  obligationReferenceType: z.string().optional(),
  obligationReferenceId: z.string().optional(),

  paymentAttempt: z
    .object({
      providerPaymentId: z.string().optional(),
      amountPaise: z.number().int().positive(),
      currency: z.string().default("INR"),
      paymentMethod: z.string().optional(),
      status: AttemptStatus,
      failureCategory: FailureCategory.optional(),
      failureReason: z.string().optional(),
    })
    .optional(),

  // DISPUTE_OPENED only.
  disputedPaymentId: z.string().optional(),

  // REFUND_ISSUED only. amountPaise, when present, is the *cumulative*
  // refunded total the provider reports on that payment (Razorpay's
  // amount_refunded), not a delta — engine.ts treats it as a set, not an
  // increment, to stay correct if a refund webhook is ever redelivered.
  refundedPaymentId: z.string().optional(),
  refundAmountPaise: z.number().int().nonnegative().optional(),

  // PAYMENT_SUCCEEDED only, and only when the success came through a
  // payment link this platform generated (src/lib/actions/paymentLink.ts).
  // This is what makes attribution possible — see resolveObligation in
  // engine.ts — instead of every resolution being credited to "something,
  // somehow."
  paymentLinkId: z.string().optional(),

  customerId: z.string().optional(),
  customerContact: z.string().optional(),
});
export type UniversalPaymentEvent = z.infer<typeof UniversalPaymentEvent>;

// Normalized merchant/customer context, as a MerchantAdapter hands it to the
// recovery engine. Custom per-merchant fields stay inside `metadata` — the
// core platform (and the AI) only ever reads the fields above it.
export const ObligationContext = z.object({
  obligationId: z.string(),
  referenceType: z.string(),
  referenceId: z.string(),
  customerId: z.string().optional(),
  amountPaise: z.number().int().nonnegative(),
  status: ObligationStatus,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ObligationContext = z.infer<typeof ObligationContext>;

// The structured "recovery case" the AI decision layer reads, and the
// structured decision it must return — per PRD §18/§22, the AI never
// receives raw payloads and never executes directly; it can only pick from
// `allowedActions`, and the Policy Engine has the final word.
export const RecoveryCaseContext = z.object({
  obligation: z.object({
    id: z.string(),
    // Needed for payment-method lifecycle reasoning (PRD Problem 28): a
    // SUBSCRIPTION obligation hitting a dead instrument (EXPIRED_CARD)
    // isn't a one-off failure — the identical charge will fail again every
    // renewal cycle until the customer updates their payment method, so
    // it's escalated to a human faster than a one-time ORDER would be.
    referenceType: z.string(),
    amountPaise: z.number(),
    outstandingAmountPaise: z.number(),
    status: ObligationStatus,
  }),
  customer: z.object({
    relationshipAgeDays: z.number(),
    successfulPayments: z.number(),
    customerValue: z.enum(["LOW", "STANDARD", "HIGH"]),
  }),
  paymentHistory: z.array(
    z.object({
      provider: Provider,
      status: AttemptStatus,
      failureCategory: FailureCategory.optional(),
      // Needed for mandate-retry sequencing: a failed UPI Autopay/e-mandate
      // debit follows NPCI's own retry limits, not the generic
      // instrument-retry logic every other payment method gets.
      paymentMethod: z.string().optional(),
    })
  ),
  recoveryHistory: z.object({
    messagesSent: z.number(),
    retryCount: z.number(),
    waitedAlready: z.boolean(),
    lastActionAt: z.string().nullable(),
  }),
  // PRD Problem 11: whether the same provider is producing the same
  // transient failure across many other obligations right now — see
  // src/lib/outage.ts. Lets the AI tell "this customer's payment keeps
  // failing" apart from "the provider itself is down," which call for very
  // different responses (wait it out vs. contact the customer).
  providerHealth: z.object({
    suspectedOutage: z.boolean(),
    affectedObligations: z.number(),
    windowMinutes: z.number(),
  }),
  allowedActions: z.array(ActionType),
});
export type RecoveryCaseContext = z.infer<typeof RecoveryCaseContext>;

export const AIDecision = z.object({
  action: ActionType,
  waitMinutes: z.number().optional(),
  reason: z.string(),
});
export type AIDecision = z.infer<typeof AIDecision>;
