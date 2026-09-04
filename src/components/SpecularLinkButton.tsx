"use client";

import { useRouter } from "next/navigation";
import SpecularButton, { type SpecularButtonProps } from "@/components/SpecularButton";

export function SpecularLinkButton({ href, ...props }: SpecularButtonProps & { href: string }) {
  const router = useRouter();
  return <SpecularButton {...props} onClick={() => router.push(href)} />;
}
