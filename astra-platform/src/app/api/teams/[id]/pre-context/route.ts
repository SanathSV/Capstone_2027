import { ApiError, assertUuid, json, requireTeamLeader, route } from "@/lib/api";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
} from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/crypto";
import { generatePreContext } from "@/lib/context/aggregate";
import type {
  Team,
  TeamIntegrations,
  TeamIntegrationsPlain,
  TeamMemberWithEmployee,
} from "@/lib/db/types";

/**
 * POST /api/teams/:id/pre-context — the "Generate Pre-Context" button.
 *
 * Sequence:
 *   1. Prove the caller leads this team, using their own session (RLS).
 *   2. Read the roster with that same session.
 *   3. Read + decrypt the credentials with the service role. This is the only
 *      place that key is used, and it happens strictly after step 1.
 *   4. Fan out to GitHub / Jira / Slack, compact, and return one JSON payload.
 *   5. Log the run, and console.log the payload so it is visible in the server
 *      terminal exactly as the spec asks.
 *
 * The payload is the artefact: it goes into the bot container's ConfigMap or
 * env file at launch. Nothing is cached between clicks — sprint state moves,
 * and a stale payload is worse than a slow one.
 */

export const dynamic = "force-dynamic";
// Three third-party APIs with retries. The Node default would cut a slow Jira
// site off mid-flight and report a timeout that is really ours.
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

export async function POST(_request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    const user = await requireTeamLeader(teamId);

    const supabase = createSupabaseServerClient();

    const [{ data: teamRow }, { data: memberRows, error: memberError }] =
      await Promise.all([
        supabase.from("teams").select("*").eq("id", teamId).single(),
        supabase
          .from("team_members")
          .select(`*, employee:employees ( * )`)
          .eq("team_id", teamId)
          .order("is_lead", { ascending: false }),
      ]);

    if (memberError) throw new ApiError(500, memberError.message);
    const team = teamRow as Team;
    const members = (memberRows ?? []) as unknown as TeamMemberWithEmployee[];

    if (members.length === 0) {
      throw new ApiError(
        400,
        "This team has no members yet. Add people from the resource pool first — the roster is what every other lookup is filtered by.",
      );
    }

    // Leadership is already proven, so the service role is safe here. It is
    // needed because RLS on team_integrations is leader-only *and* we want this
    // read to work identically if a future scheduler triggers it.
    const admin = createSupabaseAdminClient();
    const { data: intRow, error: intError } = await admin
      .from("team_integrations")
      .select("*")
      .eq("team_id", teamId)
      .maybeSingle();

    if (intError) throw new ApiError(500, intError.message);
    const stored = (intRow as TeamIntegrations | null) ?? null;

    let credentials: TeamIntegrationsPlain;
    try {
      credentials = {
        slackBotToken: decryptSecret(stored?.slack_bot_token),
        slackChannelId: stored?.slack_channel_id ?? null,
        githubToken: decryptSecret(stored?.github_token),
        githubRepoUrl: stored?.github_repo_url ?? null,
        jiraBaseUrl: stored?.jira_base_url ?? null,
        jiraProjectKey: stored?.jira_project_key ?? null,
        jiraEmail: stored?.jira_email ?? null,
        jiraApiToken: decryptSecret(stored?.jira_api_token),
      };
    } catch (error) {
      // A key mismatch is a configuration problem, not a transient one — say so
      // rather than reporting three "integration not configured" lines.
      throw new ApiError(500, (error as Error).message);
    }

    const { data: leaderProfile } = await supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", team.leader_id)
      .maybeSingle();

    const { payload, status, sources } = await generatePreContext({
      team,
      leaderName: leaderProfile?.full_name ?? leaderProfile?.email ?? null,
      members,
      integrations: credentials,
    });

    // Spec: print the payload. This is what you copy out of the terminal into
    // the bot's ConfigMap while the launch pipeline is still being built.
    console.log(
      `\n=== ASTRA PRE-CONTEXT — ${team.name} (${teamId}) ===\n` +
        JSON.stringify(payload, null, 2) +
        `\n=== ${payload.meta.bytes} bytes, ~${payload.meta.token_estimate} tokens, ` +
        `${payload.meta.duration_ms}ms, status=${status} ===\n`,
    );

    // Audit row. Written with the service role so a partial run is still
    // recorded even if the leader's token expires mid-request.
    const failure = Object.entries(sources).find(([, s]) => !s.ok);
    const { data: run, error: runError } = await admin
      .from("pre_context_runs")
      .insert({
        team_id: teamId,
        generated_by: user.id,
        status,
        payload,
        sources,
        error: failure ? `${failure[0]}: ${failure[1].error}` : null,
        token_estimate: payload.meta.token_estimate,
        duration_ms: payload.meta.duration_ms,
      })
      .select("id, created_at")
      .single();

    // The payload is the product; failing to log it must not fail the request.
    if (runError) console.error("[astra:precontext] could not log run:", runError.message);

    return json({
      status,
      run_id: run?.id ?? null,
      generated_at: payload.meta.generated_at,
      payload,
    });
  });
}
