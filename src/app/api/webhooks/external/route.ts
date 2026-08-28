import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { resolveExternalPayment } from "@/lib/engine";

const ExternalPaymentPush = z.object({
  obligationReferenceType: z.string().default("ORDER"),
  obligationReferenceId: z.string(),
  reference: z.string(),
});

// Method A from PRD §16 — "Merchant Event Push (Preferred)": the merchant
// (or a provider with no dedicated adapter yet — bank transfer, cash, a
// long tail provider) tells us directly that an obligation was paid through
// a channel we otherwise have no visibility into. This is the general
// mechanism the "customer paid elsewhere" demo scenario runs through.
export async function POST(req: NextRequest) {
  const body = ExternalPaymentPush.parse(await req.json());

  const merchantId = req.nextUrl.searchParams.get("merchant");
  const merchant = merchantId ? await db.merchant.findUnique({ where: { id: merchantId } }) : null;
  if (!merchant) {
    return NextResponse.json({ error: "Unknown or missing merchant" }, { status: 400 });
  }

  const obligation = await db.paymentObligation.findUnique({
    where: {
      merchantId_referenceType_referenceId: {
        merchantId: merchant.id,
        referenceType: body.obligationReferenceType,
        referenceId: body.obligationReferenceId,
      },
    },
  });

  if (!obligation) {
    return NextResponse.json({ error: "Unknown obligation" }, { status: 404 });
  }

  const resolved = await resolveExternalPayment(obligation.id, body.reference);
  return NextResponse.json({ status: "resolved", obligationId: resolved.id });
}
