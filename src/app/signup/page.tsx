"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signupAction } from "@/app/actions/auth";

export default function SignupPage() {
  const [state, action, pending] = useActionState(signupAction, undefined);

  return (
    <div className="auth-page">
      <aside className="auth-visual">
        <div className="auth-brand"><span className="brand-mark">↗</span> Universal Recovery</div>
        <div className="auth-visual-copy">
          <h2>Make every payment attempt count.</h2>
          <p>See the full obligation, not just the failed transaction. Recover intelligently across Razorpay, Stripe, and every channel after them.</p>
          <div className="auth-proof"><div><strong>1 view</strong>Across providers</div><div><strong>0 guesswork</strong>Auditable decisions</div></div>
        </div>
      </aside>
      <main className="auth-form-panel">
        <div className="auth-card">
          <h1>Set up your workspace</h1>
          <p>Start recovering revenue for your business in a couple of minutes.</p>
          <form action={action} className="auth-form">
            <label htmlFor="name">Business name</label>
            <input id="name" name="name" type="text" required autoComplete="organization" placeholder="Acme Commerce" />
            <label htmlFor="email">Work email</label>
            <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="At least 8 characters" />
            {state?.error && <p className="auth-error">{state.error}</p>}
            <button type="submit" disabled={pending}>{pending ? "Creating workspace…" : "Create workspace"}</button>
          </form>
          <p className="auth-switch">Already have an account? <Link href="/login">Sign in</Link></p>
          <Link href="/" className="auth-back">← Back to home</Link>
        </div>
      </main>
    </div>
  );
}
