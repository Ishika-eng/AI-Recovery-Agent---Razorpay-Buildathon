import type { PaymentProviderAdapter } from "@/lib/providers/types";
import { RazorpayAdapter } from "@/lib/providers/razorpay";
import { StripeAdapter } from "@/lib/providers/stripe";

// The core platform resolves a provider by name and never touches an
// adapter class directly — adding "Adyen" or "Cashfree" later means writing
// one file and registering it here, nothing else changes (PRD §6).
const registry: Record<string, PaymentProviderAdapter> = {
  razorpay: new RazorpayAdapter(),
  stripe: new StripeAdapter(),
};

export function getProviderAdapter(provider: string): PaymentProviderAdapter {
  const adapter = registry[provider];
  if (!adapter) throw new Error(`No provider adapter registered for "${provider}"`);
  return adapter;
}
