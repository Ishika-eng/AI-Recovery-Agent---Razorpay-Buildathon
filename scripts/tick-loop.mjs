#!/usr/bin/env node
// Local stand-in for a production scheduler (Vercel Cron, GitHub Actions,
// plain cron — see vercel.json and src/app/api/cron/tick/route.ts). Run
// this in a second terminal alongside `npm run dev` so WAIT and
// SCHEDULE_FOLLOW_UP cases actually advance on their own once their
// nextActionAt arrives, instead of only reacting to a new webhook or a
// manual "Advance" click on the dashboard.
//
// Usage: npm run scheduler
// Env:   TICK_URL (default http://localhost:3000/api/cron/tick)
//        TICK_INTERVAL_MS (default 15000)
//        CRON_SECRET (must match the running server's, if it has one set)

const url = process.env.TICK_URL ?? "http://localhost:3000/api/cron/tick";
const secret = process.env.CRON_SECRET;
const intervalMs = Number(process.env.TICK_INTERVAL_MS ?? 15_000);

async function tick() {
  const stamp = new Date().toLocaleTimeString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!res.ok) {
      console.error(`[${stamp}] tick failed: HTTP ${res.status}`);
      return;
    }
    const body = await res.json();
    console.log(
      body.dueCount > 0
        ? `[${stamp}] advanced ${body.dueCount} due case(s)`
        : `[${stamp}] no due cases`
    );
  } catch (err) {
    console.error(`[${stamp}] tick failed:`, err instanceof Error ? err.message : err);
  }
}

console.log(`[scheduler] polling ${url} every ${intervalMs / 1000}s — Ctrl+C to stop`);
tick();
setInterval(tick, intervalMs);
