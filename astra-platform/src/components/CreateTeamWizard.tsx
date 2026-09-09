"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Employee } from "@/lib/db/types";

/**
 * Team creation, in three steps.
 *
 * Splitting it up is not decoration: picking a roster out of a long directory
 * and typing six credentials are different kinds of work, and putting them on
 * one screen makes people abandon the second half. The credentials step is
 * explicitly skippable — a team with no integrations still generates a roster
 * cross-walk, which is the part the bot needs most.
 */

const ROLE_SUGGESTIONS = [
  "Tech Lead",
  "Frontend Dev",
  "Backend Dev",
  "Full Stack Dev",
  "DevOps",
  "QA",
  "Product Manager",
  "Designer",
  "Data Engineer",
];

interface Picked {
  employee: Employee;
  role: string;
}

export function CreateTeamWizard({ employees }: { employees: Employee[] }) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sprintName, setSprintName] = useState("");

  const [picked, setPicked] = useState<Record<string, Picked>>({});
  const [query, setQuery] = useState("");

  const [integrations, setIntegrations] = useState({
    slack_bot_token: "",
    slack_channel_id: "",
    github_token: "",
    github_repo_url: "",
    jira_base_url: "",
    jira_project_key: "",
    jira_email: "",
    jira_api_token: "",
  });

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = employees.filter((e) => !picked[e.id]);
    if (!q) return list;
    return list.filter((e) =>
      [e.full_name, e.email, e.title].filter(Boolean).some((f) => f!.toLowerCase().includes(q)),
    );
  }, [employees, picked, query]);

  const chosen = Object.values(picked);

  function add(employee: Employee) {
    setPicked((p) => ({
      ...p,
      [employee.id]: { employee, role: employee.title ?? "Engineer" },
    }));
  }

  function drop(id: string) {
    setPicked((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
  }

  function setRole(id: string, role: string) {
    setPicked((p) => ({ ...p, [id]: { ...p[id], role } }));
  }

  function setIntegration(key: keyof typeof integrations, value: string) {
    setIntegrations((i) => ({ ...i, [key]: value }));
  }

  async function create() {
    setBusy(true);
    setError(null);

    const response = await fetch("/api/teams", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        sprint_name: sprintName,
        members: chosen.map((c) => ({
          employee_id: c.employee.id,
          sprint_role: c.role,
        })),
        integrations,
      }),
    });

    const body = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? "Could not create the team.");
      return;
    }
    router.push(`/teams/${body.team.id}`);
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Steps current={step} />

      {/* ------------------------------------------------------ 1. details -- */}
      {step === 1 && (
        <div className="card animate-fade-up space-y-5 p-6">
          <div>
            <label className="label">
              Team name<span className="ml-1 text-signal-red">*</span>
            </label>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Payments Core"
              autoFocus
            />
          </div>

          <div>
            <label className="label">What does this team own?</label>
            <textarea
              className="input min-h-[92px] resize-y"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Checkout and settlement services. Standups are transcribed by Astra."
            />
            <p className="mt-1 text-[11px] text-slate-600">
              This sentence goes into the bot&rsquo;s context, so write it for the bot.
            </p>
          </div>

          <div>
            <label className="label">Current sprint</label>
            <input
              className="input"
              value={sprintName}
              onChange={(e) => setSprintName(e.target.value)}
              placeholder="Sprint 24 — Settlement hardening"
            />
          </div>

          <div className="flex justify-end">
            <button
              className="btn-primary"
              disabled={!name.trim()}
              onClick={() => setStep(2)}
            >
              Pick the roster →
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------- 2. roster -- */}
      {step === 2 && (
        <div className="animate-fade-up space-y-4">
          <div className="card p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-50">
                Roster
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {chosen.length} selected
                </span>
              </h2>
              <Link href="/directory" className="text-xs text-astra-400 hover:text-astra-300">
                Manage the resource pool →
              </Link>
            </div>

            {chosen.length === 0 ? (
              <p className="rounded-lg border border-dashed border-ink-600 px-4 py-6 text-center text-xs text-slate-500">
                Nobody picked yet. You are added as Team Leader automatically.
              </p>
            ) : (
              <div className="space-y-2">
                {chosen.map(({ employee, role }) => (
                  <div
                    key={employee.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/60 p-3"
                  >
                    <div className="min-w-[140px] flex-1">
                      <div className="text-sm text-slate-50">{employee.full_name}</div>
                      <div className="text-[11px] text-slate-500">{employee.email}</div>
                    </div>

                    <div className="w-48">
                      <input
                        className="input py-1.5 text-xs"
                        list="astra-roles"
                        value={role}
                        onChange={(e) => setRole(employee.id, e.target.value)}
                        placeholder="Sprint role"
                      />
                    </div>

                    <button
                      onClick={() => drop(employee.id)}
                      className="rounded-md px-2 py-1 text-xs text-slate-500 hover:text-signal-red"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            <datalist id="astra-roles">
              {ROLE_SUGGESTIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </div>

          <div className="card p-6">
            <input
              className="input mb-3"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the resource pool…"
            />
            {available.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">
                {employees.length === 0 ? (
                  <>
                    The resource pool is empty.{" "}
                    <Link href="/directory" className="text-astra-400 hover:underline">
                      Add people first
                    </Link>
                    .
                  </>
                ) : (
                  "Everyone matching is already on the roster."
                )}
              </p>
            ) : (
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {available.map((employee) => (
                  <button
                    key={employee.id}
                    onClick={() => add(employee)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-ink-800"
                  >
                    <div className="flex-1">
                      <div className="text-sm text-slate-200">{employee.full_name}</div>
                      <div className="text-[11px] text-slate-500">
                        {employee.email}
                        {employee.title && ` · ${employee.title}`}
                      </div>
                    </div>
                    <MissingHandles employee={employee} />
                    <span className="text-xs text-astra-400">Add</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button className="btn-primary" onClick={() => setStep(3)}>
              Integrations →
            </button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------- 3. integrations -- */}
      {step === 3 && (
        <div className="animate-fade-up space-y-4">
          <p className="rounded-lg border border-ink-700 bg-ink-850 px-4 py-3 text-xs leading-relaxed text-slate-400">
            Every field here is optional and can be filled in later on the team page.
            Tokens are encrypted before they are stored and are never sent back to the
            browser. See <span className="font-mono text-slate-300">INTEGRATIONS.md</span>{" "}
            for exactly which scopes each one needs.
          </p>

          <IntegrationCard title="GitHub" accent="text-slate-200">
            <Field label="Repository URL">
              <input
                className="input"
                value={integrations.github_repo_url}
                onChange={(e) => setIntegration("github_repo_url", e.target.value)}
                placeholder="https://github.com/acme/payments"
              />
            </Field>
            <Field label="API token" hint="Fine-grained PAT with Contents + Pull requests: read.">
              <input
                type="password"
                className="input font-mono text-xs"
                value={integrations.github_token}
                onChange={(e) => setIntegration("github_token", e.target.value)}
                placeholder="github_pat_…"
              />
            </Field>
          </IntegrationCard>

          <IntegrationCard title="Jira" accent="text-astra-300">
            <Field label="Base URL">
              <input
                className="input"
                value={integrations.jira_base_url}
                onChange={(e) => setIntegration("jira_base_url", e.target.value)}
                placeholder="https://acme.atlassian.net"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project key">
                <input
                  className="input font-mono uppercase"
                  value={integrations.jira_project_key}
                  onChange={(e) => setIntegration("jira_project_key", e.target.value.toUpperCase())}
                  placeholder="PAY"
                />
              </Field>
              <Field label="Account email" hint="The account the token belongs to.">
                <input
                  type="email"
                  className="input"
                  value={integrations.jira_email}
                  onChange={(e) => setIntegration("jira_email", e.target.value)}
                  placeholder="bot@acme.com"
                />
              </Field>
            </div>
            <Field label="API token">
              <input
                type="password"
                className="input font-mono text-xs"
                value={integrations.jira_api_token}
                onChange={(e) => setIntegration("jira_api_token", e.target.value)}
                placeholder="ATATT…"
              />
            </Field>
          </IntegrationCard>

          <IntegrationCard title="Slack" accent="text-signal-violet">
            <Field label="Channel ID" hint="Channel details → the ID at the bottom.">
              <input
                className="input font-mono"
                value={integrations.slack_channel_id}
                onChange={(e) => setIntegration("slack_channel_id", e.target.value.toUpperCase())}
                placeholder="C01ABCDEF"
              />
            </Field>
            <Field label="Bot token" hint="xoxb- token with channels:read and users:read.">
              <input
                type="password"
                className="input font-mono text-xs"
                value={integrations.slack_bot_token}
                onChange={(e) => setIntegration("slack_bot_token", e.target.value)}
                placeholder="xoxb-…"
              />
            </Field>
          </IntegrationCard>

          {error && (
            <p className="rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-xs text-signal-red">
              {error}
            </p>
          )}

          <div className="flex justify-between">
            <button className="btn-ghost" onClick={() => setStep(2)} disabled={busy}>
              ← Back
            </button>
            <button className="btn-primary" onClick={create} disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create team"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const labels = ["Details", "Roster", "Integrations"];
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs">
      {labels.map((label, index) => {
        const n = index + 1;
        const state = n === current ? "current" : n < current ? "done" : "todo";
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] ${
                state === "current"
                  // text-white, not the theme heading colour: this chip is filled
                    // with Google blue in both themes.
                    ? "border-astra-500 bg-astra-500 text-white"
                  : state === "done"
                    ? "border-signal-green/40 bg-signal-green/10 text-signal-green"
                    : "border-ink-600 text-slate-600"
              }`}
            >
              {state === "done" ? "✓" : n}
            </span>
            <span className={state === "todo" ? "text-slate-600" : "text-slate-300"}>
              {label}
            </span>
            {n < labels.length && <span className="h-px flex-1 bg-ink-700" />}
          </li>
        );
      })}
    </ol>
  );
}

function IntegrationCard({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card space-y-4 p-5">
      <h3 className={`text-sm font-semibold ${accent}`}>{title}</h3>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

/**
 * Warns at pick time about someone with no handles at all — they will appear in
 * the roster but contribute nothing to the GitHub or Jira sections, and finding
 * that out after a standup is too late.
 */
function MissingHandles({ employee }: { employee: Employee }) {
  const missing =
    !employee.github_username && !employee.jira_account_id && !employee.slack_user_id;
  if (!missing) return null;
  return (
    <span
      className="chip border-signal-amber/30 bg-signal-amber/10 py-0.5 text-[10px] text-signal-amber"
      title="No GitHub, Jira or Slack handle recorded — this person will not appear in any harvested data."
    >
      no handles
    </span>
  );
}
