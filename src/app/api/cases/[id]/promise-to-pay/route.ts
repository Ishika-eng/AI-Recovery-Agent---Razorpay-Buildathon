import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { recordPromiseToPay } from "@/lib/engine";

// The real trigger for RECORD_PROMISE_TO_PAY — a merchant recording what a
// customer told them on a call ("I'll pay by Friday"). Same pattern as
// opt-out and write-off: the AI never proposes this itself, since a
// promise made over a channel this platform has no webhook for can only
// be heard by a human.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryCase.findFirst({ where: { id, obligation: { merchantId: merchant.id } } });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await recordPromiseToPay(owned.obligationId, "Customer promised to pay (recorded by merchant)");
  return NextResponse.json(result);
}
