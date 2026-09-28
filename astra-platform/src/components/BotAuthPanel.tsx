"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BotStatusBadge } from "./BotStatusBadge";
import type { BotCredentialStatus } from "@/lib/db/types";

/**
 * "Bot Account Setup" — the Team Leader authenticates their meeting bot here.
 *
 * One bot account per leader, not per team: whoever signs in here is the
 * account that shows up in the participant list of every standup that leader
 * runs. The panel says so explicitly, because the failure mode is someone
 * signing in with their personal Google account and only discovering it when
 * the bot appears in a meeting under their own name.
 *
 * The sign-in itself happens in a real browser window on this machine. This
 * component starts it and then polls, because there is no way to know how long
 * a human will take over 2FA.
 */

interface Status {
  state: "none" | "authenticated" | "expired" | "failed";
  googleEmail: string | null;
  cookieCount: number | null;
  expiresAt: string | null;
  updatedAt: string | null;
  storagePath: string | null;
  error: string | null;
  filePresent: boolean;
}

interface Run {
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  elapsedMs: number;
  log: string[];
}

interface Payload {
  status: Status;
  run: Run | null;
  localFlowEnabled: boolean;
  storageKey: string;
}

const POLL_MS = 2000;

export function BotAuthPanel({ initial }: { initial: Payload }) {
  const router = useRouter();
  const [data, setData] = useState<Payload>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const running = data.run?.state === "running";

  const poll = useCallback(async () => {
    const response = await fetch("/api/bot-auth/status", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { run: Run | null; status: Status };
    setData((d) => ({ ...d, run: body.run, status: body.status }));
    return body;
  }, []);

  // Poll only while a window is open. A dashboard that hits the disk every two
  // seconds forever is a dashboard nobody leaves open.
  useEffect(() => {
    if (!running) return;
    timer.current = setTimeout(async () => {
      const body = await poll();
      if (body && body.run?.state !== "running") {
        // The run finished: refresh the server components so the team pages
        // pick up the new badge too.
        router.refresh();
      }
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [running, data.run?.elapsedMs, poll, router]);

  async function authenticate() {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/bot-auth", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? "Could not start the sign-in.");
      return;
    }
    setData((d) => ({ ...d, run: body.run }));
  }

  async function cancel() {
    await fetch("/api/bot-auth?cancel=1", { method: "DELETE" });
    await poll();
  }

  async function revoke() {
    if (
      !confirm(
        "Sign the bot out and delete its saved session from this machine? " +
          "It will not be able to join meetings until you authenticate it again.",
      )
    ) {
      return;
    }
    setBusy(true);
    const response = await fetch("/api/bot-auth", { method: "DELETE" });
    setBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not revoke.");
      return;
    }
    await poll();
    router.refresh();
  }

  const badgeStatus: BotCredentialStatus =
    data.status.state === "failed" ? "none" : data.status.state;

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-700 p-5">
        <div>
          <h2 className="flex items-center gap-2.5 text-sm font-semibold text-slate-50">
            Bot Account Setup
            <BotStatusBadge
              status={badgeStatus}
              subject="Your bot"
              googleEmail={data.status.googleEmail}
            />
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">
            One Google account, signed in once, that joins the standups for{" "}
            <strong className="text-slate-300">every team you lead</strong>. Meet treats
            anonymous guests differently — they wait in the lobby and cannot always turn
            captions on — so the bot needs a real account of its own.
          </p>
        </div>

        {!running && (
          <div className="flex gap-2">
            {data.status.state === "authenticated" || data.status.filePresent ? (
              <>
                <button onClick={authenticate} disabled={busy} className="btn-ghost">
                  Re-authenticate
                </button>
                <button onClick={revoke} disabled={busy} className="btn-danger">
                  Revoke
                </button>
              </>
            ) : (
              <button onClick={authenticate} disabled={busy} className="btn-primary">
                {busy ? "Opening…" : "Authenticate Bot Account"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="space-y-4 p-5">
        {!data.localFlowEnabled && (
          <Note tone="warn">
            <strong>This server cannot open a browser window.</strong> Signing the bot in
            means completing Google&rsquo;s login and 2FA by hand, so it only works when
            Astra is running on your own machine. Set{" "}
            <code className="font-mono text-slate-300">ASTRA_ALLOW_LOCAL_BOT_AUTH=1</code>{" "}
            in <code className="font-mono text-slate-300">.env.local</code> and restart{" "}
            <code className="font-mono text-slate-300">npm run dev</code>.
          </Note>
        )}

        {error && <Note tone="error">{error}</Note>}

        {running && (
          <div className="space-y-3">
            <Note tone="info">
              <strong>A browser window is open on this machine.</strong> Sign in to the
              dedicated bot Google account there — not your personal one — then close the
              window. This page updates on its own.
            </Note>

            <div className="flex items-center gap-3">
              <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-ink-700">
                <div className="h-full w-1/3 animate-route-progress rounded-full bg-astra-500" />
              </div>
              <span className="font-mono text-[11px] text-slate-500">
                {Math.round((data.run?.elapsedMs ?? 0) / 1000)}s
              </span>
              <button onClick={cancel} className="btn-ghost px-3 py-1 text-xs">
                Cancel
              </button>
            </div>

            {data.run!.log.length > 0 && (
              <pre className="mono max-h-40 overflow-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-slate-400">
                {data.run!.log.join("\n")}
              </pre>
            )}
          </div>
        )}

        {!running && data.run?.state === "failed" && (
          <Note tone="error">
            The sign-in did not complete
            {data.run.exitCode !== null && ` (exit code ${data.run.exitCode})`}. The most
            common reasons are closing the window before signing in, or Python not having
            Playwright installed — see <code className="font-mono">bot-auth/README</code>.
            {data.run.log.length > 0 && (
              <pre className="mono mt-2 max-h-32 overflow-auto rounded border border-signal-red/20 bg-ink-950 p-2">
                {data.run.log.slice(-8).join("\n")}
              </pre>
            )}
          </Note>
        )}

        {data.status.state === "authenticated" && (
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <Row label="Signed in as" value={data.status.googleEmail ?? "unknown"} mono />
            <Row
              label="Session cookies"
              value={data.status.cookieCount ? `${data.status.cookieCount} captured` : "—"}
            />
            <Row
              label="Valid until"
              value={
                data.status.expiresAt
                  ? new Date(data.status.expiresAt).toLocaleDateString()
                  : "no expiry recorded"
              }
            />
            <Row
              label="Authenticated"
              value={
                data.status.updatedAt
                  ? new Date(data.status.updatedAt).toLocaleString()
                  : "—"
              }
            />
          </dl>
        )}

        {data.status.state === "expired" && (
          <Note tone="warn">
            The saved session has lapsed, so the bot would join as a guest. Press
            Re-authenticate to sign it in again.
          </Note>
        )}

        {data.status.storagePath && (
          <p className="text-[11px] leading-relaxed text-slate-600">
            Stored on this machine at{" "}
            <code className="font-mono text-slate-500">{data.status.storagePath}</code>.
            This file is a live Google session — it is gitignored, and it is what the bot
            container mounts at launch. In Phase 2 it moves to Supabase Storage as{" "}
            <code className="font-mono text-slate-500">{data.storageKey}</code>.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-ink-800 pb-1.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className={`text-slate-300 ${mono ? "font-mono text-[11px]" : ""}`}>{value}</dd>
    </div>
  );
}

function Note({
  tone,
  children,
}: {
  tone: "info" | "warn" | "error";
  children: React.ReactNode;
}) {
  const styles = {
    info: "border-astra-500/30 bg-astra-500/5 text-slate-300",
    warn: "border-signal-amber/30 bg-signal-amber/5 text-signal-amber",
    error: "border-signal-red/30 bg-signal-red/10 text-signal-red",
  }[tone];
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}
