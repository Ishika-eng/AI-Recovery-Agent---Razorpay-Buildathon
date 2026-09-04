import type { ActionType } from "@/lib/types";
import type { DeliveryResult } from "./types";
import { createPaymentLink } from "./paymentLink";
import { sendReminderEmail } from "./email";

export type { DeliveryResult };

// The Action Adapter Layer — the piece that turns a decided action into
// something that actually reaches a customer, instead of a log line. Every
// customer-facing ActionType maps to exactly one delivery attempt here;
// adding a real WhatsApp/SMS channel later means adding one function and
// one branch, not touching the recovery cycle in engine.ts.
export async function deliverAction(
  type: ActionType,
  obligation: { referenceId: string; outstandingAmountPaise: number; currency: string; customerContact: string | null }
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
    if (!link.simulated && link.ref) {
      const emailed = await sendReminderEmail({
        to: obligation.customerContact,
        subject: `Complete your payment — ${amountLabel} due`,
        body: `We were unable to process your payment of ${amountLabel} for ${obligation.referenceId}. Complete it here: ${link.ref}`,
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
      body: `This is a reminder that ${amountLabel} is still outstanding for ${obligation.referenceId}. Please complete your payment at your earliest convenience.`,
    });
  }

  return { channel: "simulated", simulated: true, note: `${type} has no delivery channel wired up yet.` };
}
