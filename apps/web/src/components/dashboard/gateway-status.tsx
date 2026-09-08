"use client";

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type Health = "checking" | "connected" | "offline";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const POLL_INTERVAL_MS = 15_000;

const copy: Record<Health, string> = {
  checking: "Astra Gateway: Checking…",
  connected: "Astra Gateway: Connected",
  offline: "Astra Gateway: Offline",
};

/** Polls the backend health endpoint and renders a live status dot. */
export function GatewayStatus() {
  const [health, setHealth] = useState<Health>("checking");

  const check = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch(`${API_URL}/api/v1/health`, { signal, cache: "no-store" });
      setHealth(response.ok ? "connected" : "offline");
    } catch {
      if (!signal.aborted) setHealth("offline");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const timer = window.setInterval(() => void check(controller.signal), POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [check]);

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-slate-800/80 bg-slate-900/60 px-3 py-1.5 backdrop-blur-xl"
      title={`Polling ${API_URL}/api/v1/health`}
    >
      <span className="relative flex h-2 w-2">
        {health === "connected" ? (
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-emerald" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            health === "connected" && "bg-emerald",
            health === "offline" && "bg-red-500",
            health === "checking" && "animate-pulse bg-amber-400",
          )}
        />
      </span>
      <span
        className={cn(
          "text-xs font-medium",
          health === "connected" ? "text-slate-300" : "text-slate-500",
        )}
      >
        {copy[health]}
      </span>
    </div>
  );
}
