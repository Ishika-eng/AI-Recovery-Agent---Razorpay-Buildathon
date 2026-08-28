import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ingestProviderEvent } from "@/lib/engine";

// Razorpay webhook receiver. Signature verification, parsing, and
// normalization into the Universal Payment Event Model all happen inside
// the Razorpay provider adapter (src/lib/providers/razorpay.ts) — this
// route's only job is locating the merchant and handing off raw bytes.
// https://razorpay.com/docs/webhooks/validate-test/
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Multi-tenant: each merchant's dashboard shows them this URL with their
  // own id appended (see src/app/dashboard/page.tsx). A real deployment
  // would additionally cross-check payload.account_id against it.
  const merchantId = req.nextUrl.searchParams.get("merchant");
  const merchant = merchantId ? await db.merchant.findUnique({ where: { id: merchantId } }) : null;
  if (!merchant) {
    return NextResponse.json({ error: "Unknown or missing merchant" }, { status: 400 });
  }

  const result = await ingestProviderEvent("razorpay", rawBody, req.headers, merchant.id);
  return NextResponse.json(result);
}
