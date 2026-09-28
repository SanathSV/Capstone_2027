"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Employee } from "@/lib/db/types";

/**
 * The resource pool editor.
 *
 * The three handle fields are what make the whole product work, so the form
 * treats them as first-class rather than as optional metadata: each one carries
 * the exact instruction for finding that value in the source system, because
 * "Jira account ID" is otherwise the sort of field people confidently fill in
 * with a display name.
 */

interface Draft {
  full_name: string;
  email: string;
  title: string;
  github_username: string;
  jira_account_id: string;
  slack_user_id: string;
}

const BLANK: Draft = {
  full_name: "",
  email: "",
  title: "",
  github_username: "",
  jira_account_id: "",
  slack_user_id: "",
};

export function DirectoryManager({
  employees,
  isAdmin,
}: {
  employees: Employee[];
  /**
   * Whether this user may change the directory.
   *
   * This only decides what is *rendered*. The RLS policies decide what is
   * allowed, so a non-admin who reaches the API another way is refused by the
   * database regardless of what this component drew.
   */
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.full_name, e.email, e.title, e.github_username, e.jira_account_id, e.slack_user_id]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q)),
    );
  }, [employees, query]);

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const url = editingId ? `/api/employees/${editingId}` : "/api/employees";
    const response = await fetch(url, {
      method: editingId ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });

    const body = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(body.error ?? "Could not save.");
      return;
    }

    setDraft(BLANK);
    setEditingId(null);
    router.refresh();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Remove ${name} from the resource pool? They are removed from every team roster too.`)) {
      return;
    }
    const response = await fetch(`/api/employees/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not remove.");
      return;
    }
    router.refresh();
  }

  function edit(employee: Employee) {
    setEditingId(employee.id);
    setDraft({
      full_name: employee.full_name,
      email: employee.email,
      title: employee.title ?? "",
      github_username: employee.github_username ?? "",
      jira_account_id: employee.jira_account_id ?? "",
      slack_user_id: employee.slack_user_id ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* ------------------------------------------------ add / edit form -- */}
      {!isAdmin ? (
        <div className="card h-fit space-y-3 p-5 lg:sticky lg:top-20">
          <div className="flex items-center gap-2">
            <LockIcon />
            <h2 className="text-sm font-semibold text-slate-300">
              Managed by an admin
            </h2>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            Adding people to the resource pool, and editing the handles already in
            it, is restricted to admins. Everything else is unaffected: you can
            still put anyone listed here on a team you lead, and generate that
            team&rsquo;s pre-context.
          </p>
          <p className="text-[11px] leading-relaxed text-slate-600">
            Those handles decide whose commits and issues end up in every
            team&rsquo;s payload, so they are deliberately not open to everyone.
            Ask an admin to add someone, or to grant you the role.
          </p>
        </div>
      ) : (
      <form onSubmit={save} className="card h-fit space-y-4 p-5 lg:sticky lg:top-20">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-50">
            {editingId ? "Edit employee" : "Add an employee"}
          </h2>
          {editingId && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(BLANK);
              }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Cancel
            </button>
          )}
        </div>

        <Field label="Name" required>
          <input
            className="input"
            required
            value={draft.full_name}
            onChange={(e) => set("full_name", e.target.value)}
            placeholder="Grace Hopper"
          />
        </Field>

        <Field label="Email" required>
          <input
            type="email"
            className="input"
            required
            value={draft.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="grace@company.com"
          />
        </Field>

        <Field label="Title">
          <input
            className="input"
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Staff Engineer"
          />
        </Field>

        <div className="space-y-4 rounded-lg border border-ink-700 bg-ink-900/60 p-4">
          <p className="text-[11px] leading-relaxed text-slate-500">
            The cross-walk. These three handles are how Astra tells that a commit,
            a Jira ticket and a Slack message all belong to the same person.
          </p>

          <Field label="GitHub username" hint="From github.com/<handle> — not a URL.">
            <input
              className="input font-mono text-xs"
              value={draft.github_username}
              onChange={(e) => set("github_username", e.target.value)}
              placeholder="gracehopper"
            />
          </Field>

          <Field
            label="Jira account ID"
            hint="Profile → the id in the URL, or /rest/api/3/myself."
          >
            <input
              className="input font-mono text-xs"
              value={draft.jira_account_id}
              onChange={(e) => set("jira_account_id", e.target.value)}
              placeholder="5b10a2844c20165700ede21g"
            />
          </Field>

          <Field label="Slack user ID" hint="Profile → More → Copy member ID.">
            <input
              className="input font-mono text-xs"
              value={draft.slack_user_id}
              onChange={(e) => set("slack_user_id", e.target.value.toUpperCase())}
              placeholder="U01ABCDEF"
            />
          </Field>
        </div>

        {error && (
          <p className="rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-xs text-signal-red">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn-primary w-full">
          {busy ? "Saving…" : editingId ? "Save changes" : "Add to resource pool"}
        </button>
      </form>
      )}

      {/* -------------------------------------------------------- the list -- */}
      <div className="space-y-3">
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or any handle…"
        />

        {filtered.length === 0 ? (
          <div className="card px-6 py-10 text-center text-sm text-slate-500">
            {employees.length === 0
              ? "The resource pool is empty. Add your first employee on the left."
              : "Nobody matches that search."}
          </div>
        ) : (
          <div className="card divide-y divide-ink-700 overflow-hidden">
            {filtered.map((employee) => (
              <div
                key={employee.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 transition duration-200 ease-emphasized hover:bg-ink-800/60"
              >
                <PersonAvatar name={employee.full_name} email={employee.email} />

                <div className="min-w-[180px] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-100">
                      {employee.full_name}
                    </span>
                    {employee.profile_id && (
                      <span
                        className="chip border-signal-green/30 bg-signal-green/10 py-0.5 text-[10px] text-signal-green"
                        title="This person has signed in to Astra"
                      >
                        active
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400">
                    {employee.email}
                    {employee.title && ` · ${employee.title}`}
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <Handle kind="gh" value={employee.github_username} />
                  <Handle kind="jira" value={employee.jira_account_id} />
                  <Handle kind="slack" value={employee.slack_user_id} />
                </div>

                {isAdmin && (
                  <div className="ml-auto flex gap-1.5">
                    <button
                      onClick={() => edit(employee)}
                      className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-ink-700 hover:text-slate-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => remove(employee.id, employee.full_name)}
                      className="rounded-md px-2 py-1 text-xs text-slate-500 transition hover:bg-signal-red/10 hover:text-signal-red"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-slate-500"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" strokeLinecap="round" />
    </svg>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">
        {label}
        {required && <span className="ml-1 text-signal-red">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-600">{hint}</p>}
    </div>
  );
}

const HANDLE_STYLES = {
  gh: { label: "gh", className: "border-slate-600/40 bg-slate-500/10 text-slate-300" },
  jira: { label: "jira", className: "border-astra-500/30 bg-astra-500/10 text-astra-300" },
  slack: {
    label: "slack",
    className: "border-signal-violet/30 bg-signal-violet/10 text-signal-violet",
  },
} as const;

/** A missing handle is shown, greyed — silence here is a configuration bug. */
/**
 * A person, as a coloured initial.
 *
 * Google puts one of these on every row of every people list, and it is not
 * decoration: in a list of a dozen names that all begin to look alike, colour
 * plus letter is what the eye actually navigates by, well before it has read
 * anything. The hue is derived from the email rather than assigned, so the same
 * person is the same colour on every screen and across reloads — an avatar that
 * changed colour between renders would be worse than none.
 *
 * The four hues are Google's own brand colours, in their dark-theme tints.
 */
function PersonAvatar({ name, email }: { name: string; email: string }) {
  const PALETTE = [
    "bg-astra-500/20 text-astra-300 ring-astra-300/25",       // blue
    "bg-signal-red/15 text-signal-red ring-signal-red/25",     // red
    "bg-signal-amber/15 text-signal-amber ring-signal-amber/25", // yellow
    "bg-signal-green/15 text-signal-green ring-signal-green/25", // green
    "bg-signal-violet/15 text-signal-violet ring-signal-violet/25",
  ];

  // A tiny deterministic hash. Not a good hash — it does not need to be, it
  // needs to be stable and cheap, and to spread a few hundred names evenly
  // across five buckets.
  let sum = 0;
  for (const ch of email || name) sum = (sum * 31 + ch.charCodeAt(0)) % 100000;

  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold ring-1 ring-inset ${PALETTE[sum % PALETTE.length]}`}
    >
      {initials}
    </span>
  );
}

function Handle({ kind, value }: { kind: keyof typeof HANDLE_STYLES; value: string | null }) {
  const style = HANDLE_STYLES[kind];
  if (!value) {
    return (
      <span className="chip border-ink-700 bg-transparent py-0.5 text-[10px] text-slate-600">
        {style.label}: —
      </span>
    );
  }
  return (
    <span className={`chip py-0.5 font-mono text-[10px] ${style.className}`} title={value}>
      {style.label}: {value.length > 14 ? `${value.slice(0, 12)}…` : value}
    </span>
  );
}
