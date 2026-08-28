"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ApprovalActions({ actionId }: { actionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);

  async function act(action: "approve" | "reject") {
    setPending(action);
    try {
      await fetch(`/api/actions/${actionId}/${action}`, { method: "POST" });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={() => act("approve")}
        disabled={pending !== null}
        className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
      >
        {pending === "approve" ? "Approving…" : "Approve"}
      </button>
      <button
        onClick={() => act("reject")}
        disabled={pending !== null}
        className="rounded bg-neutral-700 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
      >
        {pending === "reject" ? "Rejecting…" : "Reject"}
      </button>
    </div>
  );
}
