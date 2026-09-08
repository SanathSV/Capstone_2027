import { notFound, redirect } from "next/navigation";
import { ProgressLink } from "@/components/Navigation";
import { RosterEditor } from "@/components/RosterEditor";
import { IntegrationsForm } from "@/components/IntegrationsForm";
import { PreContextPanel, StatusBadge } from "@/components/PreContextPanel";
import {
  getEmployees,
  getIntegrationsView,
  getRecentPreContextRuns,
  getTeam,
  getTeamLeaderName,
  getTeamMembers,
} from "@/lib/db/queries";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * Team detail: roster, credentials, and the pre-context engine.
 *
 * Everything on this page is RLS-filtered, so a non-leader simply gets a
 * read-only view — the integrations card is absent for them because the row
 * itself is invisible, not because a flag hides it.
 */

export const dynamic = "force-dynamic";

export default async function TeamPage({ params }: { params: { id: string } }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const team = await getTeam(params.id);
  if (!team) notFound();

  const isLeader = team.leader_id === user.id;

  const [members, directory, leaderName, runs] = await Promise.all([
    getTeamMembers(team.id),
    isLeader ? getEmployees() : Promise.resolve([]),
    getTeamLeaderName(team.leader_id),
    getRecentPreContextRuns(team.id),
  ]);

  const integrations = isLeader ? await getIntegrationsView(team.id) : null;
  const anyIntegration = Boolean(
    integrations?.github.configured ||
      integrations?.jira.configured ||
      integrations?.slack.configured,
  );

  return (
    <>
      <div className="mb-6">
        <ProgressLink href="/dashboard" className="text-xs text-slate-500 hover:text-slate-300">
          ← Teams
        </ProgressLink>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight text-white">
                {team.name}
              </h1>
              {isLeader ? (
                <span className="chip border-astra-500/30 bg-astra-500/10 text-astra-300">
                  You lead this team
                </span>
              ) : (
                <span className="chip">led by {leaderName}</span>
              )}
            </div>
            {team.description && (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">
                {team.description}
              </p>
            )}
            {team.sprint_name && (
              <p className="mt-2 text-xs text-signal-violet">{team.sprint_name}</p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <PreContextPanel
          teamId={team.id}
          teamName={team.name}
          isLeader={isLeader}
          memberCount={members.length}
          anyIntegration={anyIntegration}
          lastRun={runs[0] ?? null}
        />

        <div className="grid gap-6 lg:grid-cols-2">
          <RosterEditor
            teamId={team.id}
            members={members}
            directory={directory}
            isLeader={isLeader}
          />

          {integrations ? (
            <IntegrationsForm teamId={team.id} initial={integrations} />
          ) : (
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-white">Integrations</h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                The team&rsquo;s GitHub, Jira and Slack credentials are held by{" "}
                {leaderName ?? "the team leader"} and are not visible to other members.
              </p>
            </div>
          )}
        </div>

        {runs.length > 0 && <RunHistory runs={runs} />}
      </div>
    </>
  );
}

function RunHistory({
  runs,
}: {
  runs: Awaited<ReturnType<typeof getRecentPreContextRuns>>;
}) {
  return (
    <div className="card">
      <div className="border-b border-ink-700 p-5">
        <h2 className="text-sm font-semibold text-white">Recent context runs</h2>
        <p className="mt-0.5 text-[11px] text-slate-600">
          Each row stores the exact payload the bot was given, so a meeting can be
          replayed against the context it actually had.
        </p>
      </div>
      <div className="divide-y divide-ink-700">
        {runs.map((run) => (
          <div key={run.id} className="flex flex-wrap items-center gap-3 p-4 text-xs">
            <StatusBadge status={run.status} />
            <span className="text-slate-400">
              {new Date(run.created_at).toLocaleString()}
            </span>
            {run.token_estimate !== null && (
              <span className="text-slate-500">
                ≈{run.token_estimate.toLocaleString()} tokens
              </span>
            )}
            {run.duration_ms !== null && (
              <span className="text-slate-500">{run.duration_ms} ms</span>
            )}
            {run.error && (
              <span className="truncate text-signal-red" title={run.error}>
                {run.error}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
