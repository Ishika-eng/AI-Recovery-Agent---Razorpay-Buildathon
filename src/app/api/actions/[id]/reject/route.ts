import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentMerchant } from "@/lib/dal";
import { rejectAction } from "@/lib/engine";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const merchant = await getCurrentMerchant();
  if (!merchant) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await params;
  const owned = await db.recoveryAction.findFirst({
    where: { id, case: { obligation: { merchantId: merchant.id } } },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const action = await rejectAction(id);
  return NextResponse.json(action);
}
