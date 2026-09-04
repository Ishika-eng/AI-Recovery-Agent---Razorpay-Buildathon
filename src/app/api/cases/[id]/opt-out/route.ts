import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { optOutCustomer } from "@/lib/engine";

// The other real trigger for the opt-out guardrail: a merchant marking a
// case opted-out by hand after a customer says "don't contact me" on a
// call — the exact scenario PRD Problem 11 describes, for the channel
// (phone) this platform has no inbound webhook for.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryCase.findFirst({ where: { id, obligation: { merchantId: merchant.id } } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await optOutCustomer(owned.obligationId, "merchant marked opted out");
  return NextResponse.json(result);
}
