import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, dbError } from "@/lib/api";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { decryptSecret } from "@/lib/crypto";
import { generatePreContext } from "@/lib/context/aggregate";
import { renderPreContextMarkdown } from "@/lib/context/markdown";
import type { PreContextPayload } from "@/lib/context/types";
import type {
  PreContextStatus,
  SourceOutcome,
  Team,
  TeamIntegrations,
  TeamIntegrationsPlain,
  TeamMemberWithEmployee,
} from "@/lib/db/types";

/**
 * Generating a pre-context payload, in one place.
 *
 * This used to live inline in `POST /api/teams/:id/pre-context`, which meant
 * the extension's prefetch route could not do it — it could only read a run
 * somebody had already generated from the dashboard, and 404'd for every team
 * that never had. Two routes needing the same twelve steps is what a function
 * is for.
 *
 * It takes the Supabase client rather than making one, because the two callers
 * authenticate differently: the dashboard by cookie, the extension by bearer
 * token. Everything below runs as whoever that client is, so RLS decides what
 * is visible either way.
 */

export interface BuildResult {
  team: Team;
  payload: PreContextPayload;
  /**
   * The same payload as Markdown, which is what actually ships to the bot.
   *
   * Roughly half the tokens of the equivalent JSON: a table names each
   * column once, where an array of objects repeats every key on every row.
   * The structured form stays the internal representation — the analysis is
   * computed from it and the audit row stores it — but this is the value
   * that gets spent from a context window.
   */
  markdown: string;
  status: PreContextStatus;
  sources: Record<string, SourceOutcome>;
  runId: string | null;
}

/**
 * Confirms the caller leads this team.
 *
 * Not `requireTeamLeader()` from lib/api, which builds its own cookie-based
 * client — that would authenticate the wrong person for a bearer-token caller,
 * or nobody at all.
 */
async function assertLeader(
  supabase: SupabaseClient,
  teamId: string,
  userId: string,
): Promise<Team> {
  const { data, error } = await supabase
    .from("teams")
    .select("*")
    .eq("id", teamId)
    .maybeSingle();

  const problem = dbError("read the team", "authenticated", error);
  if (problem) throw problem;

  // RLS already hid teams this caller cannot see, so "missing" and "not yours"
  // are deliberately the same answer.
  if (!data) throw new ApiError(404, "Team not found.");
  if ((data as Team).leader_id !== userId) {
    throw new ApiError(403, "Only the team leader can generate pre-context.");
  }
  return data as Team;
}

export async function buildPreContext({
  teamId,
  userId,
  supabase,
  log = true,
}: {
  teamId: string;
  userId: string;
  supabase: SupabaseClient;
  /** The dashboard prints the payload; a prefetch every few seconds should not. */
  log?: boolean;
}): Promise<BuildResult> {
  const team = await assertLeader(supabase, teamId, userId);

  const { data: memberRows, error: memberError } = await supabase
    .from("team_members")
    .select(`*, employee:employees ( * )`)
    .eq("team_id", teamId)
    .order("is_lead", { ascending: false });

  const rosterProblem = dbError("read the roster", "authenticated", memberError);
  if (rosterProblem) throw rosterProblem;
  const members = (memberRows ?? []) as unknown as TeamMemberWithEmployee[];

  if (members.length === 0) {
    throw new ApiError(
      400,
      "This team has no members yet. Add people from the resource pool first — " +
        "the roster is what every other lookup is filtered by.",
    );
  }

  // Leadership is proven above, so the service role is safe here. It is needed
  // because RLS on team_integrations is leader-only.
  const admin = createSupabaseAdminClient();
  const { data: intRow, error: intError } = await admin
    .from("team_integrations")
    .select("*")
    .eq("team_id", teamId)
    .maybeSingle();

  const credsProblem = dbError("read team_integrations", "service_role", intError);
  if (credsProblem) throw credsProblem;
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

  if (log) {
    console.log(
      `\n=== ASTRA PRE-CONTEXT — ${team.name} (${teamId}) ===\n` +
        JSON.stringify(payload, null, 2) +
        `\n=== ${payload.meta.bytes} bytes, ~${payload.meta.token_estimate} tokens, ` +
        `${payload.meta.duration_ms}ms, status=${status} ===\n`,
    );
  }

  // Audit row, written with the service role so a partial run is recorded even
  // if the caller's token expires mid-request. Never fatal: the payload is the
  // product, and failing to file it must not fail the request that made it.
  const failure = Object.entries(sources).find(([, s]) => !s.ok);
  const { data: run, error: runError } = await admin
    .from("pre_context_runs")
    .insert({
      team_id: teamId,
      generated_by: userId,
      status,
      payload,
      sources,
      error: failure ? `${failure[0]}: ${failure[1].error}` : null,
      token_estimate: payload.meta.token_estimate,
      duration_ms: payload.meta.duration_ms,
    })
    .select("id")
    .single();

  if (runError) {
    console.error("[astra:precontext] could not log the run:", runError.message);
  }

  return {
    team,
    payload,
    markdown: renderPreContextMarkdown(payload),
    status,
    sources,
    runId: run?.id ?? null,
  };
}

/**
 * Returns the payload without the derived analysis block.
 *
 * The analysis is what the *dashboard* is for — sprint verdict, risks, the
 * agenda — and it is roughly a third of the payload's size. Callers that only
 * need the harvested facts can drop it and post a smaller body.
 */
export function withoutAnalysis(payload: PreContextPayload): PreContextPayload {
  const { analysis: _analysis, ...rest } = payload;
  return rest as PreContextPayload;
}
