import type { ActionType } from "@/lib/types";
import type { DeliveryResult } from "./types";
import { createPaymentLink } from "./paymentLink";
import { sendReminderEmail } from "./email";
import { createOptOutToken } from "@/lib/optout";

export type { DeliveryResult };

function unsubscribeLine(obligationId: string): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const url = `${base}/api/optout?obligation=${obligationId}&token=${createOptOutToken(obligationId)}`;
  return `\n\nDon't want to hear about this again? Opt out: ${url}`;
}

// The Action Adapter Layer — the piece that turns a decided action into
// something that actually reaches a customer, instead of a log line. Every
// customer-facing ActionType maps to exactly one delivery attempt here;
// adding a real WhatsApp/SMS channel later means adding one function and
// one branch, not touching the recovery cycle in engine.ts.
//
// Every real email carries a real, working unsubscribe link — the actual
// trigger for the customer-opt-out guardrail (src/lib/policy.ts
// contactOptedOut), not just a checkbox nobody can ever check.
export async function deliverAction(
  type: ActionType,
  obligation: { id: string; referenceId: string; outstandingAmountPaise: number; currency: string; customerContact: string | null }
): Promise<DeliveryResult> {
  const amountLabel = `${obligation.currency} ${(obligation.outstandingAmountPaise / 100).toFixed(2)}`;

  if (type === "GENERATE_PAYMENT_LINK" || type === "OFFER_ALTERNATIVE_PAYMENT_METHOD") {
    const link = await createPaymentLink({
      obligationReferenceId: obligation.referenceId,
      amountPaise: obligation.outstandingAmountPaise,
      currency: obligation.currency,
      description: `Payment for ${obligation.referenceId}`,
      customerContact: obligation.customerContact,
    });

    // A real link is worth emailing if we have an email-shaped contact —
    // best-effort: email delivery failing doesn't downgrade a real link
    // back to "simulated", the link itself is still real and payable.
    if (!link.simulated && link.customerUrl) {
      const emailed = await sendReminderEmail({
        to: obligation.customerContact,
        subject: `Complete your payment — ${amountLabel} due`,
        body: `We were unable to process your payment of ${amountLabel} for ${obligation.referenceId}. Complete it here: ${link.customerUrl}${unsubscribeLine(obligation.id)}`,
      });
      if (!emailed.simulated) {
        return { ...link, note: `${link.note} ${emailed.note}` };
      }
    }
    return link;
  }

  if (type === "SEND_REMINDER") {
    return sendReminderEmail({
      to: obligation.customerContact,
      subject: `Reminder: ${amountLabel} still outstanding`,
      body: `This is a reminder that ${amountLabel} is still outstanding for ${obligation.referenceId}. Please complete your payment at your earliest convenience.${unsubscribeLine(obligation.id)}`,
    });
  }

  return { channel: "simulated", simulated: true, note: `${type} has no delivery channel wired up yet.` };
}
