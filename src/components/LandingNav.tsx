"use client";

import Link from "next/link";
import { useState } from "react";

export function LandingNav() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="mobile-menu-button" aria-label={open ? "Close navigation" : "Open navigation"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span /><span /><span />
      </button>
      <nav className={`landing-nav ${open ? "is-open" : ""}`}>
        <Link href="/login" onClick={() => setOpen(false)}>Sign in</Link>
        <Link href="/signup" className="nav-cta" onClick={() => setOpen(false)}>Get started</Link>
      </nav>
    </>
  );
}
