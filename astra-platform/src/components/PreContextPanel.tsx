"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PreContextRun, SourceOutcome } from "@/lib/db/types";
import type { Analysis } from "@/lib/context/types";
import { AnalysisView } from "./AnalysisView";

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
  markdown?: string;
  token_estimate?: { markdown: number; json: number };
  payload: {
    // Optional on purpose. Runs generated before meta was exempted from
    // pruning have no `truncated` key at all, and those payloads are still in
    // pre_context_runs — so the type says what the data actually is rather
    // than what we wish it were.
    meta: {
      bytes?: number;
      token_estimate?: number;
      duration_ms?: number;
      sources?: Record<string, SourceOutcome>;
      truncated?: string[];
    };
    digest?: string[];
    /** The derived layer. Absent on runs generated before it existed. */
    analysis?: Analysis;
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
  // Markdown is what ships; JSON is there for anyone debugging the harvest.
  const [view, setView] = useState<"markdown" | "json">("markdown");
  const [copied, setCopied] = useState(false);
  // A harvest hits three third-party APIs with retries and can legitimately
  // take ten seconds. Without a running clock that is indistinguishable from a
  // hung request, and people start clicking again.
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!busy) return;
    startedAt.current = Date.now();
    setElapsed(0);
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 100) / 10),
      100,
    );
    return () => clearInterval(id);
  }, [busy]);

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
  const payloadMarkdown = result?.markdown ?? "";
  const shown = view === "markdown" && payloadMarkdown ? payloadMarkdown : payloadJson;

  // One place where the payload's optional shape is normalised, so the JSX
  // below can read these without a guard on every line.
  const meta = result?.payload.meta;
  const digest = result?.payload.digest ?? [];
  const analysis = result?.payload.analysis ?? null;
  const trimmed = meta?.truncated ?? [];
  const sources = meta?.sources ?? {};

  async function copy() {
    await navigator.clipboard.writeText(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function download() {
    const isMd = view === "markdown" && Boolean(payloadMarkdown);
    const blob = new Blob([shown], {
      type: isMd ? "text/markdown" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    // The name the bot's entrypoint expects to find mounted.
    anchor.download =
      `precontext-${teamName.toLowerCase().replace(/\W+/g, "-")}.` + (isMd ? "md" : "json");
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-700 bg-gradient-to-r from-astra-500/10 to-transparent p-5">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-50">
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
                Harvesting… {elapsed.toFixed(1)}s
              </>
            ) : (
              "Generate Pre-Context"
            )}
          </button>
        )}
      </div>

      <div className="p-5">
        {busy && <HarvestProgress elapsed={elapsed} />}

        {!isLeader && (
          <Note tone="muted">
            Only the team leader can run the context engine — it reads the team&rsquo;s
            stored API credentials.
          </Note>
        )}

        {isLeader && !busy && memberCount === 0 && (
          <Note tone="warn">
            Add people from the resource pool first. Every GitHub and Jira lookup is
            filtered by the roster&rsquo;s handles, so an empty team harvests nothing.
          </Note>
        )}

        {isLeader && !busy && memberCount > 0 && !anyIntegration && !result && (
          <Note tone="warn">
            No integrations are configured yet, so a run right now produces the roster
            cross-walk and nothing else. That is still a valid payload — add GitHub or
            Jira below for the parts that change every day.
          </Note>
        )}

        {!busy && error && <Note tone="error">{error}</Note>}

        {!busy && result && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={result.status} />
              <Stat label="size" value={`${((meta?.bytes ?? 0) / 1024).toFixed(1)} KB`} />
              <Stat
                label="≈tokens"
                value={
                  result.token_estimate
                    ? `${result.token_estimate.markdown.toLocaleString()} md`
                    : (meta?.token_estimate ?? 0).toLocaleString()
                }
              />
              {result.token_estimate && (
                <Stat
                  label="saved"
                  value={`${Math.round(
                    (1 - result.token_estimate.markdown / result.token_estimate.json) * 100,
                  )}% vs JSON`}
                />
              )}
              <Stat label="took" value={`${meta?.duration_ms ?? 0} ms`} />
              <div className="ml-auto flex gap-2">
                <button onClick={copy} className="btn-ghost px-3 py-1.5 text-xs">
                  {copied ? "Copied" : "Copy JSON"}
                </button>
                <button onClick={download} className="btn-ghost px-3 py-1.5 text-xs">
                  Download
                </button>
              </div>
            </div>

            {Object.keys(sources).length > 0 && <SourceGrid sources={sources} />}

            {analysis && <AnalysisView analysis={analysis} />}

            {digest.length > 0 && (
              <div className="rounded-lg border border-ink-700 bg-ink-900/60 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Digest{analysis ? " (headline facts)" : ""}
                </h3>
                <ul className="space-y-1.5">
                  {digest.map((line, i) => (
                    <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-300">
                      <span className="text-astra-500">▸</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {trimmed.length > 0 && (
              <details className="rounded-lg border border-ink-700 bg-ink-900/60 p-4">
                <summary className="cursor-pointer text-xs text-slate-400">
                  Trimmed for the context budget ({trimmed.length})
                </summary>
                <ul className="mt-2 space-y-1">
                  {trimmed.map((line, i) => (
                    <li key={i} className="text-[11px] text-slate-500">
                      · {line}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div>
              <div className="mb-2 flex items-center gap-3">
                <button
                  onClick={() => setShowRaw((v) => !v)}
                  className="text-xs text-astra-400 hover:text-astra-300"
                >
                  {showRaw ? "Hide" : "Show"} the payload
                </button>
                {showRaw && payloadMarkdown && (
                  <div className="flex rounded-md border border-ink-700 bg-ink-900 p-0.5 text-[10px]">
                    {(["markdown", "json"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setView(mode)}
                        className={`rounded px-2 py-0.5 transition ${
                          view === mode
                            ? "bg-ink-700 text-slate-50"
                            : "text-slate-500 hover:text-slate-300"
                        }`}
                      >
                        {mode === "markdown" ? "Markdown (sent)" : "JSON (source)"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {showRaw && (
                <pre className="mono max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-950 p-4 text-slate-300">
                  {shown}
                </pre>
              )}
            </div>

            <p className="text-[11px] text-slate-600">
              The bot is briefed with the <strong className="text-slate-400">Markdown</strong>,
              not the JSON &mdash; roughly half the tokens for the same facts. The
              structured form is what the analysis above is computed from, and what is
              stored in this team&rsquo;s run history.
            </p>
          </div>
        )}

        {!busy && !result && !error && lastRun && (
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

/**
 * What the page shows while the three sources are being fetched.
 *
 * The sources are named individually even though we cannot know which one is
 * still outstanding — the request is a single POST and the server fans out
 * internally. Naming them is still worth it: when the run comes back partial,
 * the same three cards are already where the eye expects them, and the failure
 * reads as "Jira failed" rather than "the button failed".
 */
function HarvestProgress({ elapsed }: { elapsed: number }) {
  return (
    <div className="animate-fade-up space-y-4">
      <div className="h-0.5 overflow-hidden rounded-full bg-ink-700">
        <div className="h-full w-1/3 animate-route-progress rounded-full bg-astra-500" />
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {["github", "jira", "slack"].map((name) => (
          <div key={name} className="shimmer rounded-lg border border-ink-700 bg-ink-900/60 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium capitalize text-slate-300">{name}</span>
              <Spinner />
            </div>
            <p className="mt-1 text-[11px] text-slate-600">querying…</p>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-600">
        {elapsed < 8
          ? "Querying the configured integrations in parallel."
          : "Still going — a slow Jira site or a retry after a rate limit can take a few more seconds."}
      </p>
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
