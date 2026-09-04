"use client";

import { useEffect } from "react";

// globals.css sets a hardcoded white <body> background (`--background:
// #ffffff`), which every other page in the app relies on and which this
// component must not touch globally. The landing page is the one dark-
// themed exception — its own root div reliably covers the full page
// height, but this is a defensive belt-and-braces layer against any
// transient paint gap (a slow initial paint, an overscroll bounce, a
// browser-specific compositing quirk) ever showing white instead of dark
// behind it. Scoped to this page only: restores the original background
// on unmount, so navigating away leaves every other route untouched.
export function DarkBodyBackground() {
  useEffect(() => {
    const previous = document.body.style.backgroundColor;
    document.body.style.backgroundColor = "#0a0a0a";
    return () => {
      document.body.style.backgroundColor = previous;
    };
  }, []);

  return null;
}
