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

type Mode = "signin" | "signup" | "magic";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
            <h1 className="text-lg font-semibold text-white">Astra</h1>
            <p className="mt-1 text-sm text-slate-500">
              Sprint context for the meeting bot.
            </p>
          </div>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-6">
          <div className="flex rounded-lg border border-ink-700 bg-ink-900 p-1 text-xs">
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
                className={`flex-1 rounded-md px-2 py-1.5 transition ${
                  mode === value
                    ? "bg-ink-700 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

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

          {mode !== "magic" && (
            <div>
              <label className="label" htmlFor="password">
                Password
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

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy
              ? "Working…"
              : mode === "signup"
                ? "Create account"
                : mode === "magic"
                  ? "Email me a link"
                  : "Sign in"}
          </button>

          <p className="text-center text-[11px] leading-relaxed text-slate-600">
            Your account becomes the Team Leader of any team you create.
          </p>
        </form>
      </div>
    </div>
  );
}
