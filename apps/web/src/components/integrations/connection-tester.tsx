"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, PlugZap, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type Phase = "idle" | "testing" | "success" | "error";

export interface ConnectionTesterProps {
  /** Disabled until every required credential field has a value. */
  ready: boolean;
  serviceName: string;
}

/**
 * Simulated ping. Swap `runTest` for a POST to the backend's integration
 * verification route once it exists — the state machine stays the same.
 */
export function ConnectionTester({ ready, serviceName }: ConnectionTesterProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [latency, setLatency] = useState<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const runTest = () => {
    setPhase("testing");
    setLatency(null);

    timerRef.current = window.setTimeout(() => {
      // Simulated result: credentials that are present are treated as valid.
      const elapsed = 120 + Math.floor(Math.random() * 380);
      setLatency(elapsed);
      setPhase(ready ? "success" : "error");
    }, 1400);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={runTest} disabled={phase === "testing"}>
        {phase === "testing" ? (
          <Spinner className="h-3.5 w-3.5" />
        ) : (
          <PlugZap className="h-3.5 w-3.5" aria-hidden />
        )}
        {phase === "testing" ? "Pinging…" : "Test connection"}
      </Button>

      <div aria-live="polite" className="flex items-center gap-2">
        {phase === "testing" ? (
          <span className="text-xs text-slate-500">Reaching {serviceName}…</span>
        ) : null}

        {phase === "success" ? (
          <Badge tone="active">
            <CheckCircle2 className="h-3 w-3" aria-hidden />
            Connected · {latency}ms
          </Badge>
        ) : null}

        {phase === "error" ? (
          <Badge tone="danger">
            <XCircle className="h-3 w-3" aria-hidden />
            Missing credentials
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
