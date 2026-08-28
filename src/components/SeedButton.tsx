"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SeedButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  return (
    <button
      onClick={async () => {
        setLoading(true);
        try {
          await fetch("/api/seed", { method: "POST" });
          router.refresh();
        } finally {
          setLoading(false);
        }
      }}
      disabled={loading}
      className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
    >
      {loading ? "Generating…" : "Load demo batch"}
    </button>
  );
}
