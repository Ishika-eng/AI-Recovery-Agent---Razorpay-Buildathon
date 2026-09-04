"use client";

import Link from "next/link";
import { useState } from "react";
import { SpecularLinkButton } from "@/components/SpecularLinkButton";

export function LandingNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mobile-menu-button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span /><span /><span />
      </button>
      <nav className={`landing-nav ${open ? "is-open" : ""}`}>
        <Link href="/login" onClick={() => setOpen(false)}>Sign in</Link>
        <SpecularLinkButton
          href="/signup"
          size="sm"
          radius={8}
          tint="#ffffff"
          tintOpacity={1}
          textColor="#171717"
          lineColor="#ffffff"
          baseColor="#d4d4d4"
          proximity={200}
        >
          Get started
        </SpecularLinkButton>
      </nav>
    </>
  );
}
