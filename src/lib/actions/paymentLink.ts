import Razorpay from "razorpay";
import type { DeliveryResult } from "./types";

// Creates a real Razorpay Payment Link — money actually moves through this
// if the customer completes it, unlike everything else in this file's
// neighborhood before this change. `notes.obligation_id` and `reference_id`
// both carry the merchant's own obligation reference, so when the customer
// pays, RazorpayAdapter (src/lib/providers/razorpay.ts) can correlate the
// resulting payment.captured / payment_link.paid webhook straight back to
// this obligation — the same Priority-1 correlation path every other
// Razorpay event goes through, not a special case.
//
// Gracefully reports { channel: "not_configured" } when RAZORPAY_KEY_ID /
// RAZORPAY_KEY_SECRET aren't set, rather than throwing — this platform is
// meant to be demoable with zero external credentials, and the caller
// (engine.ts) falls back to a simulated outcome in that case.
export async function createPaymentLink(input: {
  obligationReferenceId: string;
  amountPaise: number;
  currency: string;
  description: string;
  customerContact?: string | null;
}): Promise<DeliveryResult> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return { channel: "not_configured", simulated: true, note: "Razorpay API keys not configured — no real payment link created." };
  }

  const contact = input.customerContact ?? undefined;
  const looksLikeEmail = contact?.includes("@") ?? false;

  try {
    const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const link = await razorpay.paymentLink.create({
      amount: input.amountPaise,
      currency: input.currency,
      description: input.description,
      reference_id: input.obligationReferenceId,
      notes: { obligation_id: input.obligationReferenceId },
      customer: {
        name: "Customer",
        email: looksLikeEmail ? contact : undefined,
        contact: !looksLikeEmail ? contact : undefined,
      },
      notify: { email: looksLikeEmail, sms: !looksLikeEmail && Boolean(contact) },
      reminder_enable: true,
    });

    return {
      channel: "razorpay_payment_link",
      simulated: false,
      ref: link.id, // durable id — what a later payment_link.paid webhook will carry, for attribution
      customerUrl: link.short_url,
      note: `Real Razorpay payment link created (${link.id}): ${link.short_url}`,
    };
  } catch (err) {
    return { channel: "not_configured", simulated: true, note: `Payment link creation failed, falling back to simulation: ${describeRazorpayError(err)}` };
  }
}

// Razorpay's SDK rejects with a plain object shaped like
// { statusCode, error: { code, description, ... } }, not a real Error
// instance — `err instanceof Error ? err.message : String(err)` therefore
// stringified every real API failure into the literal text "[object
// Object]", making the audit trail (meant to be merchant-readable, see
// AuditLog in prisma/schema.prisma) useless for diagnosing exactly the
// failures a merchant would want to see. Found live: a real payment link
// creation failing after keys were correctly configured produced this
// exact unreadable message.
function describeRazorpayError(err: unknown): string {
  if (err && typeof err === "object" && "error" in err) {
    const inner = (err as { error?: { description?: string; code?: string } }).error;
    if (inner?.description) return inner.code ? `${inner.code}: ${inner.description}` : inner.description;
  }
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
