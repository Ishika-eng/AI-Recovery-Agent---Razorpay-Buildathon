import nodemailer from "nodemailer";
import type { DeliveryResult } from "./types";

let cachedTransport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !port || !user || !pass) return null;

  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465,
      auth: { user, pass },
    });
  }
  return cachedTransport;
}

// Sends a real email through whatever SMTP account is configured — Gmail,
// SES, Mailtrap, anything. Reports { channel: "not_configured" } instead of
// throwing when SMTP env vars are absent or the contact on file doesn't
// look like an email address (this platform has no SMS/WhatsApp channel
// yet — see README "Known limitations" — so a phone-number contact simply
// has nothing to send to today).
export async function sendReminderEmail(input: {
  to: string | null | undefined;
  subject: string;
  body: string;
}): Promise<DeliveryResult> {
  if (!input.to || !input.to.includes("@")) {
    return { channel: "not_configured", simulated: true, note: "No email-shaped contact on file — nothing to send to." };
  }

  const transport = getTransport();
  if (!transport) {
    return { channel: "not_configured", simulated: true, note: "SMTP not configured — no real email sent." };
  }

  try {
    const info = await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
    return { channel: "email", simulated: false, ref: info.messageId, note: `Real email sent to ${input.to} (${info.messageId}).` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel: "not_configured", simulated: true, note: `Email send failed, falling back to simulation: ${message}` };
  }
}
