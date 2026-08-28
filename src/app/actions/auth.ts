"use server";

import { z } from "zod";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, deleteSession } from "@/lib/session";

export type AuthFormState = { error: string } | undefined;

const SignupSchema = z.object({
  name: z.string().trim().min(2, "Business name must be at least 2 characters."),
  email: z.email("Enter a valid email address.").trim().toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

const LoginSchema = z.object({
  email: z.email("Enter a valid email address.").trim().toLowerCase(),
  password: z.string().min(1, "Enter your password."),
});

export async function signupAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = SignupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { name, email, password } = parsed.data;

  const existing = await db.merchant.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const merchant = await db.merchant.create({ data: { name, email, passwordHash } });

  await createSession(merchant.id);
  redirect("/onboarding");
}

export async function loginAction(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = LoginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }
  const { email, password } = parsed.data;

  const merchant = await db.merchant.findUnique({ where: { email } });
  // Compare against a dummy hash when no account exists, so the response
  // time doesn't reveal whether the email is registered.
  const valid = await bcrypt.compare(password, merchant?.passwordHash ?? "$2b$10$invalidsaltinvalidsaltinvalidsaltinvalidsal");
  if (!merchant || !valid) {
    return { error: "Incorrect email or password." };
  }

  await createSession(merchant.id);
  redirect(merchant.termsAcceptedAt ? "/dashboard" : "/onboarding");
}

export async function logoutAction() {
  await deleteSession();
  redirect("/");
}
