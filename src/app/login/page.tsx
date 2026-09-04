"use client";

import { useActionState } from "react";
import Link from "next/link";
import { loginAction } from "@/app/actions/auth";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);

  return (
    <div className="auth-page">
      <aside className="auth-visual">
        <div className="auth-brand"><span className="brand-mark">↗</span> Universal Recovery</div>
        <div className="auth-visual-copy">
          <h2>Recover revenue with a clearer view of what is owed.</h2>
          <p>One intelligent layer for every payment provider, every obligation, and every recovery decision.</p>
          <div className="auth-proof"><div><strong>₹∞</strong>Revenue visibility</div><div><strong>24/7</strong>Policy-led recovery</div></div>
        </div>
      </aside>
      <main className="auth-form-panel">
        <div className="auth-card">
          <h1>Welcome back</h1>
          <p>Sign in to access your recovery operations workspace.</p>
          <form action={action} className="auth-form">
            <label htmlFor="email">Work email</label>
            <input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password" placeholder="Enter your password" />
            {state?.error && <p className="auth-error">{state.error}</p>}
            <button type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in to workspace"}</button>
          </form>
          <p className="auth-switch">New to Universal Recovery? <Link href="/signup">Create an account</Link></p>
          <Link href="/" className="auth-back">← Back to home</Link>
        </div>
      </main>
    </div>
  );
}
