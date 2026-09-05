import type { RecoveryCaseContext } from "@/lib/types";
import { generateText } from "@/lib/llm";

// Hinglish voice recovery — honestly scoped. This platform has no
// telephony/IVR integration (no calling API keys, no PSTN access), so it
// does not place real calls and never claims to. What it *can* do
// honestly is the AI-judgment part of a voice channel: deciding *when* a
// personal call is warranted (see the RECOMMEND_VOICE_OUTREACH branch in
// src/lib/ai.ts) and generating the actual script a human agent — or a
// text-to-speech/IVR system, if one is wired up later — would read. That
// script is a real, usable deliverable in its own right, not a
// placeholder standing in for a feature that doesn't exist.
export function generateHinglishVoiceScript(context: RecoveryCaseContext): string {
  const amount = `₹${(context.obligation.outstandingAmountPaise / 100).toFixed(2)}`;
  const orderRef = context.obligation.referenceType.toLowerCase();

  return [
    `Namaste! Main [Merchant Name] ki taraf se baat kar raha/rahi hoon.`,
    `Aapka ${amount} ka payment abhi tak pending hai, ${orderRef} ke against.`,
    `Kya aap ise abhi complete karna chahenge, ya koi dikkat aa rahi hai payment mein?`,
    `Agar card ya UPI mein koi issue hai, main aapko turant ek naya payment link bhej sakta/sakti hoon.`,
    `Agar aap thodi der mein pay karna chahte hain, koi baat nahi — bas mujhe bata dijiye, main note kar loonga/loongi.`,
    `Dhanyavaad, aapka time dene ke liye.`,
  ].join(" ");
}

// LLM-generated variant of the same script — genuinely personalized to the
// customer's relationship, history, and situation, which the fixed template
// above (same six sentences for every case) structurally can't be. Falls
// back to the deterministic template whenever no LLM is configured or the
// call fails, so this is always safe to call and always returns something.
export async function generateVoiceScript(context: RecoveryCaseContext): Promise<string> {
  const fallback = generateHinglishVoiceScript(context);
  const amount = `₹${(context.obligation.outstandingAmountPaise / 100).toFixed(2)}`;

  const generated = await generateText({
    system:
      "You write short, warm, natural-sounding Hinglish (Hindi+English mix, Roman script) phone scripts for a payment recovery agent calling a customer about a pending payment. Keep it under 80 words, polite, never pushy, and offer to send a fresh payment link if there's a payment issue. Reply with the script only — no preamble, no labels.",
    prompt: `Customer: ${context.customer.customerValue.toLowerCase()}-value, ${context.customer.relationshipAgeDays}-day relationship, ${context.customer.successfulPayments} prior successful payment(s). Amount due: ${amount} for a ${context.obligation.referenceType.toLowerCase()}.`,
    maxTokens: 200,
  });

  return generated ?? fallback;
}
