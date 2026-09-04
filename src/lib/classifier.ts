import type { FailureCategory } from "@/lib/types";

export type Classification = {
  failureCategory: FailureCategory;
  note: string;
};

// Provider-agnostic failure classifier. Every provider adapter normalizes
// its own error taxonomy into a (code, description) pair and hands it here
// — this is the one place that maps raw error text to a FailureCategory, so
// the rest of the platform never has to know a provider's vocabulary.
//
// A real deployment would layer an LLM on top for errors this can't place,
// but the gated actions downstream only need the failure *category*, not
// perfect certainty — so a transparent rule set is the right tool here:
// merchants can read exactly why a classification was made.
export function classifyFailure(input: {
  hadPaymentAttempt: boolean;
  errorCode?: string;
  errorDescription?: string;
}): Classification {
  const code = input.errorCode?.toUpperCase() ?? "";
  const desc = (input.errorDescription ?? "").toLowerCase();

  if (!input.hadPaymentAttempt) {
    return {
      failureCategory: "USER_DROPOFF",
      note: "No payment attempt was recorded against the order — the customer left checkout before authorizing.",
    };
  }

  if (code.includes("TIMEOUT") || desc.includes("timeout") || desc.includes("timed out")) {
    return {
      failureCategory: "TIMEOUT",
      note: `Issuer/network did not respond in time (code: ${code || "n/a"}). Usually transient.`,
    };
  }

  // Checked before the generic decline/gateway patterns below: an expired
  // card is a *terminal* instrument failure, not merely "unlikely to
  // succeed" — no amount of retrying, waiting, or even a freshly generated
  // payment link will ever clear it, because a link still defaults back to
  // the same saved method. It needs its own category so the AI layer can
  // propose a genuinely different payment method instead of just retrying
  // (PRD Problem 28 — payment-method lifecycle).
  if (code.includes("EXPIRED") || desc.includes("expired")) {
    return {
      failureCategory: "EXPIRED_CARD",
      note: `Card on file has expired (code: ${code || "n/a"}) — this instrument can never clear again; a different payment method is required, not a retry.`,
    };
  }

  if (
    code.includes("INSUFFICIENT") ||
    desc.includes("insufficient funds") ||
    desc.includes("insufficient balance")
  ) {
    return {
      failureCategory: "INSUFFICIENT_FUNDS",
      note: "Issuer reported insufficient funds/balance — retrying the same instrument won't help.",
    };
  }

  if (
    code.includes("BAD_REQUEST_ERROR") ||
    code.includes("GATEWAY_ERROR") ||
    desc.includes("gateway")
  ) {
    return {
      failureCategory: "GATEWAY_ERROR",
      note: `Gateway/processor-side error (code: ${code || "n/a"}). May be transient, may need an alternate route.`,
    };
  }

  if (code.includes("NETWORK") || desc.includes("network error") || desc.includes("connection")) {
    return {
      failureCategory: "NETWORK_ERROR",
      note: "Network-level failure between customer, issuer, or gateway. Usually transient.",
    };
  }

  if (
    code.includes("DECLINE") ||
    desc.includes("declined") ||
    desc.includes("do not honour") ||
    desc.includes("card issue")
  ) {
    return {
      failureCategory: "ISSUER_DECLINE",
      note: `Issuing bank declined the transaction (code: ${code || "n/a"}). Same instrument is unlikely to succeed on retry.`,
    };
  }

  return {
    failureCategory: "UNKNOWN",
    note: `Error did not match any known pattern (code: ${code || "n/a"}, description: "${input.errorDescription ?? "none"}"). Routed to merchant for manual review.`,
  };
}
