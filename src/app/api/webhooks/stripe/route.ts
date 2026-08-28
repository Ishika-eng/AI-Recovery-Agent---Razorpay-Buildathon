import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestProviderEvent } from "@/lib/engine";

// Stripe webhook receiver — same shape as the Razorpay route, proving the
// provider-agnostic pipeline: a completely different payload structure
// (src/lib/providers/stripe.ts) flows through the identical
// ingest → normalize → correlate → recover pipeline.
// https://stripe.com/docs/webhooks
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  const merchantId = req.nextUrl.searchParams.get("merchant");
  const merchant = merchantId ? await db.merchant.findUnique({ where: { id: merchantId } }) : null;
  if (!merchant) {
    return NextResponse.json({ error: "Unknown or missing merchant" }, { status: 400 });
  }

  const result = await ingestProviderEvent("stripe", rawBody, req.headers, merchant.id);
  return NextResponse.json(result);
}
