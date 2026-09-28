"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Mientras haya reuniones procesándose, refresca la página cada pocos segundos. */
export function AutoRefresh({ active, everyMs = 4000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}
