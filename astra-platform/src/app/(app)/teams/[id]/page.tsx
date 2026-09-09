import { notFound, redirect } from "next/navigation";
import { ProgressLink } from "@/components/Navigation";
import { RosterEditor } from "@/components/RosterEditor";
import { IntegrationsForm } from "@/components/IntegrationsForm";
import { PreContextPanel, StatusBadge } from "@/components/PreContextPanel";
import { BotStatusBadge, type BadgeStatus } from "@/components/BotStatusBadge";
import { TeamDescriptionEditor } from "@/components/TeamDescriptionEditor";
import {
  getEmployees,
  getLeaderBotStatus,
  getIntegrationsView,
  getRecentPreContextRuns,
  getTeam,
  getTeamLeaderName,
  getTeamMembers,
} from "@/lib/db/queries";
import { createSupabaseServerClient, getSessionUser } from "@/lib/supabase/server";
import { publishBotStatus } from "@/lib/botStatusPublish";

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

  const [members, directory, leaderName, runs, botStatus] = await Promise.all([
    getTeamMembers(team.id),
    isLeader ? getEmployees() : Promise.resolve([]),
    getTeamLeaderName(team.leader_id),
    getRecentPreContextRuns(team.id),
    // The bot belongs to the leader, not the team: one account covers every
    // team they lead, so this is looked up by leader_id.
    //
    // When YOU are that leader, skip the database entirely: the credential is a
    // file on this machine, and reading it is both authoritative and free of
    // any sync gap. `publishBotStatus` also writes the row on the way past, so
    // simply visiting your own team page keeps the copy other members see up to
    // date. The database lookup below is only for viewing *someone else's*
    // team, where the file is on a laptop you cannot reach.
    isLeader
      ? publishBotStatus(createSupabaseServerClient(), user.id)
      : getLeaderBotStatus(team.leader_id),
  ]);

  // Two sources, one badge. `publishBotStatus` returns the on-disk status for
  // the leader; `getLeaderBotStatus` returns a database row (or "unknown" when
  // that lookup itself failed) for everyone else.
  const badge: { status: BadgeStatus; email: string | null } =
    botStatus === "unknown"
      ? { status: "unknown", email: null }
      : botStatus === null
        ? { status: "none", email: null }
        : "state" in botStatus
          ? {
              // A run that failed is not a credential that failed; the badge
              // only ever shows what the leader *has*.
              status: botStatus.state === "failed" ? "none" : botStatus.state,
              email: botStatus.googleEmail,
            }
          : { status: botStatus.status, email: botStatus.google_email };

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
              <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
                {team.name}
              </h1>
              {isLeader ? (
                <span className="chip border-astra-500/30 bg-astra-500/10 text-astra-300">
                  You lead this team
                </span>
              ) : (
                <span className="chip">led by {leaderName}</span>
              )}
              <BotStatusBadge
                status={badge.status}
                subject={isLeader ? "Your bot" : `${leaderName ?? "The leader"}'s bot`}
                googleEmail={badge.email}
              />
            </div>
            <TeamDescriptionEditor
              teamId={team.id}
              initial={team.description}
              canEdit={isLeader}
            />
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
              <h2 className="text-sm font-semibold text-slate-50">Integrations</h2>
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
        <h2 className="text-sm font-semibold text-slate-50">Recent context runs</h2>
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
