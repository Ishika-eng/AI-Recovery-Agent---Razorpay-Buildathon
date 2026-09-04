import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { writeOffObligation } from "@/lib/engine";

// The terminal state a case had no way to reach before: a merchant decides
// to stop pursuing an obligation entirely — distinct from resolving it
// (money arrived) or rejecting one proposed action (the case stays open,
// awaiting a further decision).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryCase.findFirst({ where: { id, obligation: { merchantId: merchant.id } } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await writeOffObligation(owned.obligationId, "merchant decided not to pursue further");
  return NextResponse.json(result);
}
