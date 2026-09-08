"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AstraMark } from "@/components/Shell";

/**
 * Choose a new password.
 *
 * How you get here: the recovery email links to `/auth/callback`, which trades
 * the one-time code for a real session and forwards to this page. So by the
 * time this renders the visitor is *already signed in* — `updateUser` is an
 * ordinary authenticated call, and there is no token to pass around in the URL.
 *
 * That also means the page has to check for a session before showing the form.
 * A link that has expired or been used already lands here signed-out, and a
 * password box that cannot possibly work is worse than an explanation.
 */
export function ResetPasswordForm() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [authorised, setAuthorised] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      setAuthorised(Boolean(user));
      setEmail(user?.email ?? null);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }

    setBusy(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (error) {
      setError(
        /same.*password/i.test(error.message)
          ? "That is already your password. Choose a different one."
          : error.message,
      );
      return;
    }

    setDone(true);
    // The recovery session is a real session, so there is nothing else to do —
    // send them into the app rather than making them sign in again.
    setTimeout(() => {
      router.push("/dashboard");
      router.refresh();
    }, 1200);
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <AstraMark className="h-9 w-9" />
          <h1 className="text-lg font-semibold text-white">Choose a new password</h1>
        </div>

        {checking ? (
          <div className="card p-6 text-center text-sm text-slate-500">
            Checking your reset link…
          </div>
        ) : !authorised ? (
          <div className="card space-y-4 p-6">
            <p className="rounded-lg border border-signal-amber/30 bg-signal-amber/5 px-3 py-2 text-xs leading-relaxed text-signal-amber">
              This reset link is no longer valid. Recovery links are single-use and
              expire an hour after they are sent.
            </p>
            <Link href="/login" className="btn-primary w-full">
              Request a new one
            </Link>
          </div>
        ) : done ? (
          <div className="card space-y-3 p-6 text-center">
            <p className="text-sm text-signal-green">Password updated.</p>
            <p className="text-xs text-slate-500">Taking you to your teams…</p>
          </div>
        ) : (
          <form onSubmit={submit} className="card space-y-4 p-6">
            {email && (
              <p className="text-[11px] text-slate-500">
                Setting a new password for{" "}
                <span className="font-mono text-slate-300">{email}</span>.
              </p>
            )}

            <div>
              <label className="label" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                autoFocus
              />
            </div>

            <div>
              <label className="label" htmlFor="confirm">
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Type it again"
                autoComplete="new-password"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-xs text-signal-red">
                {error}
              </p>
            )}

            <button type="submit" disabled={busy} className="btn-primary w-full">
              {busy ? "Updating…" : "Update password"}
            </button>

            <p className="text-center text-[11px] text-slate-600">
              You are signed in on this device already; changing the password does not
              sign you out.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
