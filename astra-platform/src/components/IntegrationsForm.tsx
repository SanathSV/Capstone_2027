"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { IntegrationsView } from "@/lib/db/types";

/**
 * Team integration credentials.
 *
 * The secret fields start empty and stay empty even when a token is stored —
 * the API never sends one back. So an untouched password field means "leave the
 * stored token alone", and the UI has to say that out loud or people will
 * assume the blank box means the token was lost. Clearing one is therefore an
 * explicit button rather than an empty submit.
 */

type Section = "github" | "jira" | "slack";

export function IntegrationsForm({
  teamId,
  initial,
}: {
  teamId: string;
  initial: IntegrationsView;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<Section | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const [form, setForm] = useState({
    github_repo_url: initial.github.repoUrl ?? "",
    github_token: "",
    jira_base_url: initial.jira.baseUrl ?? "",
    jira_project_key: initial.jira.projectKey ?? "",
    jira_email: initial.jira.email ?? "",
    jira_api_token: "",
    slack_channel_id: initial.slack.channelId ?? "",
    slack_bot_token: "",
  });

  function set(key: keyof typeof form, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save(section: Section, body: Record<string, string | null>) {
    setBusy(true);
    setError(null);
    setSaved(null);

    const response = await fetch(`/api/teams/${teamId}/integrations`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setError(payload.error ?? "Could not save.");
      return;
    }

    setView(payload.integrations as IntegrationsView);
    // Blank the secret inputs again: the value is stored now, and leaving it on
    // screen is a token sitting in the DOM for the rest of the session.
    setForm((f) => ({ ...f, github_token: "", jira_api_token: "", slack_bot_token: "" }));
    setSaved(section);
    setTimeout(() => setSaved(null), 2500);
    router.refresh();
  }

  return (
    <div className="card">
      <div className="border-b border-ink-700 p-5">
        <h2 className="text-sm font-semibold text-white">Integrations</h2>
        <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
          Tokens are encrypted with AES-256-GCM before they are stored and are never sent
          back to this page. Setup instructions are in{" "}
          <span className="font-mono text-slate-500">INTEGRATIONS.md</span>.
        </p>
      </div>

      {error && (
        <p className="border-b border-ink-700 bg-signal-red/10 px-5 py-2 text-xs text-signal-red">
          {error}
        </p>
      )}

      <div className="divide-y divide-ink-700">
        {/* ------------------------------------------------------- GitHub -- */}
        <Section
          id="github"
          title="GitHub"
          status={view.github.configured ? "configured" : view.github.repoUrl ? "partial" : "off"}
          summary={view.github.repoUrl ?? "Repositories, open PRs, recent commits"}
          open={open === "github"}
          saved={saved === "github"}
          onToggle={() => setOpen(open === "github" ? null : "github")}
        >
          <Field label="Repository URL">
            <input
              className="input"
              value={form.github_repo_url}
              onChange={(e) => set("github_repo_url", e.target.value)}
              placeholder="https://github.com/acme/payments"
            />
          </Field>
          <SecretField
            label="API token"
            stored={view.github.hasToken}
            value={form.github_token}
            onChange={(v) => set("github_token", v)}
            placeholder="github_pat_… or ghp_…"
            hint="Fine-grained PAT, read access to Contents, Metadata and Pull requests."
            onClear={() => save("github", { github_token: "" })}
          />
          <SaveRow
            busy={busy}
            onSave={() =>
              save("github", {
                github_repo_url: form.github_repo_url,
                ...(form.github_token ? { github_token: form.github_token } : {}),
              })
            }
          />
        </Section>

        {/* --------------------------------------------------------- Jira -- */}
        <Section
          id="jira"
          title="Jira"
          status={view.jira.configured ? "configured" : view.jira.baseUrl ? "partial" : "off"}
          summary={
            view.jira.baseUrl
              ? `${view.jira.baseUrl}${view.jira.projectKey ? ` · ${view.jira.projectKey}` : ""}`
              : "Active sprint, goal, and issues assigned to the roster"
          }
          open={open === "jira"}
          saved={saved === "jira"}
          onToggle={() => setOpen(open === "jira" ? null : "jira")}
        >
          <Field label="Base URL">
            <input
              className="input"
              value={form.jira_base_url}
              onChange={(e) => set("jira_base_url", e.target.value)}
              placeholder="https://acme.atlassian.net"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project key">
              <input
                className="input font-mono uppercase"
                value={form.jira_project_key}
                onChange={(e) => set("jira_project_key", e.target.value.toUpperCase())}
                placeholder="PAY"
              />
            </Field>
            <Field label="Account email" hint="The account the API token belongs to.">
              <input
                type="email"
                className="input"
                value={form.jira_email}
                onChange={(e) => set("jira_email", e.target.value)}
                placeholder="bot@acme.com"
              />
            </Field>
          </div>
          <SecretField
            label="API token"
            stored={view.jira.hasToken}
            value={form.jira_api_token}
            onChange={(v) => set("jira_api_token", v)}
            placeholder="ATATT…"
            hint="id.atlassian.com → Security → Create and manage API tokens."
            onClear={() => save("jira", { jira_api_token: "" })}
          />
          <SaveRow
            busy={busy}
            onSave={() =>
              save("jira", {
                jira_base_url: form.jira_base_url,
                jira_project_key: form.jira_project_key,
                jira_email: form.jira_email,
                ...(form.jira_api_token ? { jira_api_token: form.jira_api_token } : {}),
              })
            }
          />
        </Section>

        {/* -------------------------------------------------------- Slack -- */}
        <Section
          id="slack"
          title="Slack"
          status={view.slack.configured ? "configured" : view.slack.channelId ? "partial" : "off"}
          summary={view.slack.channelId ?? "Verifies the roster's Slack IDs against the channel"}
          open={open === "slack"}
          saved={saved === "slack"}
          onToggle={() => setOpen(open === "slack" ? null : "slack")}
        >
          <Field label="Channel ID" hint="Channel details → the ID at the bottom of the panel.">
            <input
              className="input font-mono"
              value={form.slack_channel_id}
              onChange={(e) => set("slack_channel_id", e.target.value.toUpperCase())}
              placeholder="C01ABCDEF"
            />
          </Field>
          <SecretField
            label="Bot token"
            stored={view.slack.hasToken}
            value={form.slack_bot_token}
            onChange={(v) => set("slack_bot_token", v)}
            placeholder="xoxb-…"
            hint="Bot token with channels:read, groups:read and users:read."
            onClear={() => save("slack", { slack_bot_token: "" })}
          />
          <SaveRow
            busy={busy}
            onSave={() =>
              save("slack", {
                slack_channel_id: form.slack_channel_id,
                ...(form.slack_bot_token ? { slack_bot_token: form.slack_bot_token } : {}),
              })
            }
          />
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  status,
  summary,
  open,
  saved,
  onToggle,
  children,
}: {
  id: Section;
  title: string;
  status: "configured" | "partial" | "off";
  summary: string;
  open: boolean;
  saved: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const dot = {
    configured: "bg-signal-green",
    partial: "bg-signal-amber",
    off: "bg-ink-500",
  }[status];

  return (
    <div>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-ink-800/50"
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-100">{title}</span>
            {saved && <span className="text-[10px] text-signal-green">saved</span>}
          </div>
          <div className="truncate text-[11px] text-slate-500">{summary}</div>
        </div>
        <span className="text-xs text-slate-500">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="space-y-4 border-t border-ink-700 bg-ink-900/50 p-4">{children}</div>}
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

function SecretField({
  label,
  stored,
  value,
  onChange,
  placeholder,
  hint,
  onClear,
}: {
  label: string;
  stored: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  hint: string;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="label mb-0">{label}</label>
        {stored && (
          <div className="flex items-center gap-2">
            <span className="chip border-signal-green/30 bg-signal-green/10 py-0.5 text-[10px] text-signal-green">
              stored
            </span>
            <button
              type="button"
              onClick={onClear}
              className="text-[10px] text-slate-500 hover:text-signal-red"
            >
              clear
            </button>
          </div>
        )}
      </div>
      <input
        type="password"
        className="input font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={stored ? "•••••••• (leave blank to keep)" : placeholder}
        autoComplete="off"
      />
      <p className="mt-1 text-[11px] text-slate-600">{hint}</p>
    </div>
  );
}

function SaveRow({ busy, onSave }: { busy: boolean; onSave: () => void }) {
  return (
    <div className="flex justify-end">
      <button onClick={onSave} disabled={busy} className="btn-primary px-3 py-1.5 text-xs">
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
