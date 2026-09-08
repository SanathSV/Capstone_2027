"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PreContextRun, SourceOutcome } from "@/lib/db/types";

/**
 * The "Generate Pre-Context" button and its result.
 *
 * The payload is shown in full rather than summarised, because the person
 * pressing this button is about to paste it into a ConfigMap and needs to see
 * exactly what the bot will see. Copy and download are first-class for the same
 * reason — this screen is a step in a deploy, not a report.
 */

interface RunResponse {
  status: "success" | "partial" | "failed";
  run_id: string | null;
  generated_at: string;
  payload: {
    meta: {
      bytes: number;
      token_estimate: number;
      duration_ms: number;
      sources: Record<string, SourceOutcome>;
      truncated: string[];
    };
    digest: string[];
    [key: string]: unknown;
  };
}

export function PreContextPanel({
  teamId,
  teamName,
  isLeader,
  memberCount,
  anyIntegration,
  lastRun,
}: {
  teamId: string;
  teamName: string;
  isLeader: boolean;
  memberCount: number;
  anyIntegration: boolean;
  lastRun: PreContextRun | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch(`/api/teams/${teamId}/pre-context`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "The context run failed.");
        return;
      }
      setResult(body as RunResponse);
      setShowRaw(true);
      router.refresh(); // the run history below is a server component
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request never completed.");
    } finally {
      setBusy(false);
    }
  }

  const payloadJson = result ? JSON.stringify(result.payload, null, 2) : "";

  async function copy() {
    await navigator.clipboard.writeText(payloadJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function download() {
    const blob = new Blob([payloadJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // The name the bot's entrypoint expects to find mounted.
    anchor.download = `precontext-${teamName.toLowerCase().replace(/\W+/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-700 bg-gradient-to-r from-astra-500/10 to-transparent p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <BoltIcon />
            Pre-Context Engine
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
            Harvests the roster cross-walk, GitHub activity and the live Jira sprint into
            one compact JSON payload — the file mounted into the bot container at launch.
          </p>
        </div>

        {isLeader && (
          <button onClick={generate} disabled={busy || memberCount === 0} className="btn-primary">
            {busy ? (
              <>
                <Spinner />
                Harvesting…
              </>
            ) : (
              "Generate Pre-Context"
            )}
          </button>
        )}
      </div>

      <div className="p-5">
        {!isLeader && (
          <Note tone="muted">
            Only the team leader can run the context engine — it reads the team&rsquo;s
            stored API credentials.
          </Note>
        )}

        {isLeader && memberCount === 0 && (
          <Note tone="warn">
            Add people from the resource pool first. Every GitHub and Jira lookup is
            filtered by the roster&rsquo;s handles, so an empty team harvests nothing.
          </Note>
        )}

        {isLeader && memberCount > 0 && !anyIntegration && !result && (
          <Note tone="warn">
            No integrations are configured yet, so a run right now produces the roster
            cross-walk and nothing else. That is still a valid payload — add GitHub or
            Jira below for the parts that change every day.
          </Note>
        )}

        {error && <Note tone="error">{error}</Note>}

        {result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={result.status} />
              <Stat label="size" value={`${(result.payload.meta.bytes / 1024).toFixed(1)} KB`} />
              <Stat label="≈tokens" value={result.payload.meta.token_estimate.toLocaleString()} />
              <Stat label="took" value={`${result.payload.meta.duration_ms} ms`} />
              <div className="ml-auto flex gap-2">
                <button onClick={copy} className="btn-ghost px-3 py-1.5 text-xs">
                  {copied ? "Copied" : "Copy JSON"}
                </button>
                <button onClick={download} className="btn-ghost px-3 py-1.5 text-xs">
                  Download
                </button>
              </div>
            </div>

            <SourceGrid sources={result.payload.meta.sources} />

            {result.payload.digest.length > 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/60 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Digest
                </h3>
                <ul className="space-y-1.5">
                  {result.payload.digest.map((line, i) => (
                    <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-300">
                      <span className="text-astra-500">▸</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.payload.meta.truncated.length > 0 && (
              <details className="rounded-lg border border-ink-700 bg-ink-900/60 p-4">
                <summary className="cursor-pointer text-xs text-slate-400">
                  Trimmed for the context budget ({result.payload.meta.truncated.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {result.payload.meta.truncated.map((line, i) => (
                    <li key={i} className="text-[11px] text-slate-500">
                      · {line}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div>
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="mb-2 text-xs text-astra-400 hover:text-astra-300"
              >
                {showRaw ? "Hide" : "Show"} the payload
              </button>
              {showRaw && (
                <pre className="mono max-h-[420px] overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-4 text-slate-300">
                  {payloadJson}
                </pre>
              )}
            </div>

            <p className="text-[11px] text-slate-600">
              The same payload was printed to the Next.js server terminal, and stored on
              this team&rsquo;s run history.
            </p>
          </div>
        )}

        {!result && !error && lastRun && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/60 px-4 py-3">
            <span className="text-xs text-slate-500">Last run</span>
            <StatusBadge status={lastRun.status} />
            <span className="text-xs text-slate-500">
              {new Date(lastRun.created_at).toLocaleString()}
            </span>
            {lastRun.token_estimate !== null && (
              <span className="text-xs text-slate-500">
                · ≈{lastRun.token_estimate.toLocaleString()} tokens
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SourceGrid({ sources }: { sources: Record<string, SourceOutcome> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {Object.entries(sources).map(([name, outcome]) => {
        const state = outcome.skipped ? "skipped" : outcome.ok ? "ok" : "failed";
        const colours = {
          ok: "border-signal-green/30 bg-signal-green/5",
          failed: "border-signal-red/30 bg-signal-red/5",
          skipped: "border-ink-700 bg-ink-900/60",
        }[state];

        return (
          <div key={name} className={`rounded-lg border p-3 ${colours}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium capitalize text-slate-200">{name}</span>
              <span
                className={`text-[10px] uppercase tracking-wide ${
                  state === "ok"
                    ? "text-signal-green"
                    : state === "failed"
                      ? "text-signal-red"
                      : "text-slate-600"
                }`}
              >
                {state}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              {outcome.skipped ??
                outcome.error ??
                `${outcome.fetched ?? 0} object(s) in ${outcome.ms} ms`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    success: "border-signal-green/30 bg-signal-green/10 text-signal-green",
    partial: "border-signal-amber/30 bg-signal-amber/10 text-signal-amber",
    failed: "border-signal-red/30 bg-signal-red/10 text-signal-red",
  };
  return (
    <span className={`chip py-0.5 text-[10px] uppercase tracking-wide ${styles[status] ?? ""}`}>
      {status}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="chip py-0.5 text-[10px]">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-200">{value}</span>
    </span>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "muted" | "warn" | "error";
  children: React.ReactNode;
}) {
  const styles = {
    muted: "border-ink-700 bg-ink-900/60 text-slate-500",
    warn: "border-signal-amber/30 bg-signal-amber/5 text-signal-amber",
    error: "border-signal-red/30 bg-signal-red/10 text-signal-red",
  }[tone];
  return (
    <p className={`rounded-lg border px-4 py-3 text-xs leading-relaxed ${styles}`}>{children}</p>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 animate-spin" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-astra-400" fill="currentColor">
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12Z" />
    </svg>
  );
}
