"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { AstraMark } from "@/components/Shell";

/**
 * Sign in / sign up.
 *
 * Password auth is the default because it works against a brand-new Supabase
 * project with nothing configured; the magic link is there for anyone who has
 * SMTP set up and would rather not manage a password. Both land on the same
 * profile row — the `on_auth_user_created` trigger does not care how you got in.
 */

type Mode = "signin" | "signup" | "magic" | "reset";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  // /auth/callback bounces here with ?error= when a magic link or a recovery
  // link has expired or already been used. Without this the user is returned to
  // a blank form with no idea why.
  const callbackError = params.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(callbackError);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    const supabase = createSupabaseBrowserClient();

    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        setNotice("Check your inbox — the sign-in link is on its way.");
        return;
      }

      if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          // The link lands on the callback, which swaps the one-time code for a
          // session and forwards to the page that actually sets the password.
          redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
        });
        if (error) throw error;
        setNotice(
          "If that email has an account, a reset link is on its way. The link is single-use and expires in an hour.",
        );
        return;
      }

      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          // full_name lands in raw_user_meta_data, which the database trigger
          // reads when it creates the profile row.
          options: {
            data: { full_name: fullName.trim() || undefined },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) throw error;
        // With email confirmation on, there is no session yet.
        if (!data.session) {
          setNotice("Account created. Confirm your email address, then sign in.");
          setMode("signin");
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }

      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <AstraMark className="h-9 w-9" />
          <div>
            <h1 className="text-lg font-semibold text-slate-50">Astra</h1>
            <p className="mt-1 text-sm text-slate-500">
              Sprint context for the meeting bot.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          {mode === "reset" ? (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-slate-50">Reset your password</h2>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Enter the email you signed up with and we will send a single-use link.
                Opening it signs you in just long enough to choose a new password.
              </p>
            </div>
          ) : (
          // A segmented control, in the same pill language as every other
          // control in the app. The old square-cornered version was the one
          // thing on this page still speaking the previous design's dialect,
          // which is exactly the sort of detail that makes an interface feel
          // assembled rather than designed.
          <div className="flex rounded-full border border-ink-700 bg-ink-900 p-1 text-xs">
            {(
              [
                ["signin", "Sign in"],
                ["signup", "Create account"],
                ["magic", "Magic link"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                  setNotice(null);
                }}
                // whitespace-nowrap because "Create account" wraps to two lines
                // at this width otherwise, which makes the whole control taller
                // than its siblings and the row visibly uneven.
                className={`flex-1 whitespace-nowrap rounded-full px-2 py-2 font-medium transition duration-200 ease-emphasized ${
                  mode === value
                    ? "bg-astra-500/15 text-astra-300"
                    : "text-slate-400 hover:bg-ink-800 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          )}

          {mode === "signup" && (
            <div>
              <label className="label" htmlFor="fullName">
                Full name
              </label>
              <input
                id="fullName"
                className="input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Grace Hopper"
                autoComplete="name"
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              required
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
            />
          </div>

          {mode !== "magic" && mode !== "reset" && (
            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <label className="label mb-0" htmlFor="password">
                  Password
                </label>
                {mode === "signin" && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode("reset");
                      setError(null);
                      setNotice(null);
                    }}
                    className="text-[11px] text-astra-400 transition hover:text-astra-300"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </div>
          )}

          {error && (
            <p className="rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-xs text-signal-red">
              {error}
            </p>
          )}
          {notice && (
            <p className="rounded-lg border border-signal-green/30 bg-signal-green/10 px-3 py-2 text-xs text-signal-green">
              {notice}
            </p>
          )}

          {/* Both of these send mail, and Supabase's built-in sender allows
              only two messages an hour for the whole project. Saying so here
              turns "the email never arrived" from a mystery into a known cost. */}
          {(mode === "magic" || mode === "reset") && (
            <p className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
              This sends mail through Supabase&rsquo;s built-in service, which allows only{" "}
              <strong className="text-slate-400">2 emails per hour</strong> for the whole
              project. If nothing arrives, that budget is usually why — raise it by
              configuring custom SMTP under Authentication &rarr; Emails.
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : mode === "magic"
                  ? "Email me a link"
                  : mode === "reset"
                    ? "Send the reset link"
                    : "Sign in"}
          </button>

          {mode === "reset" && (
            <button
              type="button"
              onClick={() => {
                setMode("signin");
                setError(null);
                setNotice(null);
              }}
              className="w-full text-center text-[11px] text-slate-500 transition hover:text-slate-300"
            >
              ← Back to sign in
            </button>
          )}

          {mode !== "reset" && (
            <p className="text-center text-[11px] leading-relaxed text-slate-600">
              Your account becomes the Team Leader of any team you create.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
