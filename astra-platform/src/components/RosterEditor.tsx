"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Employee, TeamMemberWithEmployee } from "@/lib/db/types";

/**
 * The team roster on the detail page.
 *
 * Doubles as a readiness check: each row shows which of the three handles the
 * person carries, so "why is Alan missing from the Jira section" is answerable
 * before the standup rather than after it.
 */

export function RosterEditor({
  teamId,
  members,
  directory,
  isLeader,
}: {
  teamId: string;
  members: TeamMemberWithEmployee[];
  directory: Employee[];
  isLeader: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const seated = useMemo(
    () => new Set(members.map((m) => m.employee_id)),
    [members],
  );

  const available = useMemo(() => {
    const q = query.trim().toLowerCase();
    return directory
      .filter((e) => !seated.has(e.id))
      .filter((e) =>
        !q ? true : [e.full_name, e.email].some((f) => f.toLowerCase().includes(q)),
      );
  }, [directory, seated, query]);

  async function add(employeeId: string) {
    setPendingId(employeeId);
    setError(null);
    const response = await fetch(`/api/teams/${teamId}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employee_id: employeeId, sprint_role: "Engineer" }),
    });
    setPendingId(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not add that person.");
      return;
    }
    setQuery("");
    router.refresh();
  }

  async function changeRole(memberId: string, sprint_role: string) {
    const response = await fetch(`/api/teams/${teamId}/members/${memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sprint_role }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not change that role.");
      return;
    }
    router.refresh();
  }

  async function remove(memberId: string, name: string) {
    if (!confirm(`Remove ${name} from this team? They stay in the resource pool.`)) return;
    const response = await fetch(`/api/teams/${teamId}/members/${memberId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not remove that person.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-ink-700 p-5">
        <div>
          <h2 className="text-sm font-semibold text-slate-50">
            Roster
            <span className="ml-2 text-xs font-normal text-slate-500">
              {members.length} member{members.length === 1 ? "" : "s"}
            </span>
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-600">
            Sprint roles and the handles each lookup is filtered by.
          </p>
        </div>
        {isLeader && (
          <button onClick={() => setAdding((v) => !v)} className="btn-ghost px-3 py-1.5 text-xs">
            {adding ? "Done" : "Add member"}
          </button>
        )}
      </div>

      {adding && isLeader && (
        <div className="border-b border-ink-700 bg-ink-900/60 p-4">
          <input
            className="input mb-2"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the resource pool…"
            autoFocus
          />
          {available.length === 0 ? (
            <p className="px-1 py-2 text-xs text-slate-500">
              {directory.length === seated.size ? (
                <>
                  Everyone in the pool is already on this team.{" "}
                  <Link href="/directory" className="text-astra-400 hover:underline">
                    Add more people
                  </Link>
                  .
                </>
              ) : (
                "No matches."
              )}
            </p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {available.slice(0, 30).map((employee) => (
                <button
                  key={employee.id}
                  onClick={() => add(employee.id)}
                  disabled={pendingId === employee.id}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition hover:bg-ink-800 disabled:opacity-50"
                >
                  <div className="flex-1">
                    <div className="text-sm text-slate-200">{employee.full_name}</div>
                    <div className="text-[11px] text-slate-500">{employee.email}</div>
                  </div>
                  <span className="text-xs text-astra-400">
                    {pendingId === employee.id ? "Adding…" : "Add"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="border-b border-ink-700 bg-signal-red/10 px-5 py-2 text-xs text-signal-red">
          {error}
        </p>
      )}

      <div className="divide-y divide-ink-700">
        {members.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">
            No members yet.
          </p>
        ) : (
          members.map((member) => (
            <div key={member.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
              <div className="min-w-[160px] flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-50">{member.employee.full_name}</span>
                  {member.is_lead && (
                    <span className="chip border-astra-500/30 bg-astra-500/10 py-0.5 text-[10px] text-astra-300">
                      Leader
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500">{member.employee.email}</div>
              </div>

              <div className="w-44">
                {isLeader && !member.is_lead ? (
                  <input
                    className="input py-1.5 text-xs"
                    defaultValue={member.sprint_role}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value && value !== member.sprint_role) changeRole(member.id, value);
                    }}
                  />
                ) : (
                  <span className="chip">{member.sprint_role}</span>
                )}
              </div>

              <HandleDots employee={member.employee} />

              {isLeader && !member.is_lead && (
                <button
                  onClick={() => remove(member.id, member.employee.full_name)}
                  className="rounded-md px-2 py-1 text-xs text-slate-500 transition hover:bg-signal-red/10 hover:text-signal-red"
                >
                  Remove
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Three dots: filled means the handle is recorded, hollow means it is not. */
function HandleDots({ employee }: { employee: Employee }) {
  const handles = [
    { key: "GitHub", value: employee.github_username, colour: "bg-slate-400" },
    { key: "Jira", value: employee.jira_account_id, colour: "bg-astra-400" },
    { key: "Slack", value: employee.slack_user_id, colour: "bg-signal-violet" },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {handles.map((h) => (
        <span
          key={h.key}
          title={h.value ? `${h.key}: ${h.value}` : `No ${h.key} handle recorded`}
          className={`h-2 w-2 rounded-full ${
            h.value ? h.colour : "border border-ink-600 bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}
