import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  BotCredential,
  Employee,
  IntegrationsView,
  Meeting,
  MeetingDetail,
  PreContextRun,
  Profile,
  Team,
  TeamIntegrations,
  TeamMemberWithEmployee,
  TeamSummary,
  TranscriptLine,
} from "./types";

/**
 * Server-side reads for the pages.
 *
 * Every query here runs as the signed-in user, so the RLS policies in
 * supabase/schema.sql are what decide visibility — none of these functions
 * filter by user id themselves, and adding such a filter would be a sign the
 * policy is wrong rather than a belt-and-braces improvement.
 */

/**
 * Everything the dashboard needs, in one round trip.
 *
 * RLS already returns only teams the user leads or belongs to, so the split
 * into "Teams I Lead" / "Teams I am In" is a partition of what comes back
 * rather than two separate queries.
 */
export async function getDashboardTeams(userId: string): Promise<{
  lead: TeamSummary[];
  member: TeamSummary[];
}> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("teams")
    .select(
      `id, name, description, leader_id, sprint_name, created_at, updated_at,
       leader:profiles!teams_leader_id_fkey ( id, email, full_name ),
       team_members ( id, sprint_role, is_lead, employee:employees ( id, profile_id ) )`,
    )
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Could not load teams: ${error.message}`);

  const lead: TeamSummary[] = [];
  const member: TeamSummary[] = [];

  for (const row of data ?? []) {
    // PostgREST embeds are typed as arrays by the client because it cannot see
    // the foreign-key cardinality without generated types; both of these are
    // to-one relationships, so they arrive as objects at runtime.
    const members = (row.team_members ?? []) as unknown as {
      sprint_role: string;
      is_lead: boolean;
      employee: { id: string; profile_id: string | null } | null;
    }[];

    const mine = members.find((m) => m.employee?.profile_id === userId);
    const leader = Array.isArray(row.leader) ? row.leader[0] : row.leader;

    const summary: TeamSummary = {
      id: row.id,
      name: row.name,
      description: row.description,
      leader_id: row.leader_id,
      sprint_name: row.sprint_name,
      created_at: row.created_at,
      updated_at: row.updated_at,
      leader: leader ?? null,
      member_count: members.length,
      my_role: mine?.sprint_role ?? null,
      i_lead: row.leader_id === userId,
    };

    if (summary.i_lead) lead.push(summary);
    else member.push(summary);
  }

  return { lead, member };
}

/**
 * The signed-in user's own profile, which is where the role lives.
 *
 * Pages call this to decide what to *show*; the database policies decide what
 * is actually allowed. Both matter: without the first, a non-admin stares at a
 * form that will always fail, and without the second the form is only a
 * suggestion.
 */
export async function getMyProfile(userId: string): Promise<Profile | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw new Error(`Could not load your profile: ${error.message}`);
  return (data as Profile) ?? null;
}

export async function getEmployees(): Promise<Employee[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("full_name", { ascending: true });

  if (error) throw new Error(`Could not load the resource pool: ${error.message}`);
  return (data ?? []) as Employee[];
}

export async function getTeam(teamId: string): Promise<Team | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("teams")
    .select("*")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw new Error(`Could not load the team: ${error.message}`);
  return (data as Team) ?? null;
}

export async function getTeamLeaderName(leaderId: string): Promise<string | null> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", leaderId)
    .maybeSingle();
  return data?.full_name ?? data?.email ?? null;
}

/**
 * A Team Leader's bot status, readable by anyone who can see the team.
 *
 * This comes from Postgres rather than from disk, and that is the whole
 * point: the `auth.json` that actually proves the bot is signed in lives on
 * the leader's own machine, so a member opening this page could never read
 * it. The leader's dashboard publishes the *status* to `bot_credentials`, and
 * that is what everyone else sees.
 */
export async function getLeaderBotStatus(
  leaderId: string,
): Promise<BotCredential | null | "unknown"> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("bot_credentials")
    .select("*")
    .eq("user_id", leaderId)
    .maybeSingle();

  // Three outcomes, and they are not the same thing:
  //
  //   a row        -> report it
  //   no row       -> the leader has never set the bot up: "Not Authenticated"
  //   an ERROR     -> we genuinely do not know, and saying "Not Authenticated"
  //                   would be a claim we cannot support. The commonest cause
  //                   is PGRST205, the table missing from PostgREST's schema
  //                   cache, which has nothing to do with the leader's bot.
  if (error) {
    console.error(
      "[astra] could not read bot status:",
      error.message,
      error.code === "PGRST205"
        ? "— run supabase/FIX_bot_credentials.sql"
        : "",
    );
    return "unknown";
  }
  return (data as BotCredential) ?? null;
}

export async function getTeamMembers(
  teamId: string,
): Promise<TeamMemberWithEmployee[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("team_members")
    .select(`*, employee:employees ( * )`)
    .eq("team_id", teamId)
    // Leader first, then alphabetically: the roster reads like an org chart.
    .order("is_lead", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Could not load the roster: ${error.message}`);
  return (data ?? []) as unknown as TeamMemberWithEmployee[];
}

/**
 * The redacted integrations view for the browser.
 *
 * Ciphertext is still a secret: it is decryptable by anything holding the key,
 * and shipping it to the client would put it in the page source. So the form
 * only ever learns *whether* a token exists.
 */
export async function getIntegrationsView(
  teamId: string,
): Promise<IntegrationsView> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("team_integrations")
    .select("*")
    .eq("team_id", teamId)
    .maybeSingle();

  // RLS hides this row from non-leaders, which surfaces as "no row" rather than
  // an error — the right answer either way.
  if (error) throw new Error(`Could not load integrations: ${error.message}`);

  const row = (data as TeamIntegrations | null) ?? null;

  return {
    slack: {
      configured: Boolean(row?.slack_bot_token && row?.slack_channel_id),
      channelId: row?.slack_channel_id ?? null,
      hasToken: Boolean(row?.slack_bot_token),
    },
    github: {
      configured: Boolean(row?.github_token && row?.github_repo_url),
      repoUrl: row?.github_repo_url ?? null,
      hasToken: Boolean(row?.github_token),
    },
    jira: {
      configured: Boolean(
        row?.jira_base_url && row?.jira_project_key && row?.jira_email && row?.jira_api_token,
      ),
      baseUrl: row?.jira_base_url ?? null,
      projectKey: row?.jira_project_key ?? null,
      email: row?.jira_email ?? null,
      hasToken: Boolean(row?.jira_api_token),
    },
    updatedAt: row?.updated_at ?? null,
  };
}

export async function getRecentPreContextRuns(
  teamId: string,
  limit = 5,
): Promise<PreContextRun[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pre_context_runs")
    .select("id, team_id, generated_by, status, sources, error, token_estimate, duration_ms, created_at, payload")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load previous runs: ${error.message}`);
  return (data ?? []) as PreContextRun[];
}

/**
 * Every meeting the bot has held for a team, newest first.
 *
 * Matches on `team_id` OR `team_ref`, and the second half is not redundant: the
 * container writes `team_id` null whenever its team lookup failed at summon
 * time — a slow database, a team created seconds earlier — while `team_ref`
 * still holds the id the extension sent. Selecting on `team_id` alone would
 * hide a meeting with a full transcript in it, permanently.
 */
export async function getTeamMeetings(teamId: string): Promise<Meeting[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("meetings")
    .select("*")
    .or(`team_id.eq.${teamId},team_ref.eq.${teamId}`)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(error.message);
  return (data ?? []) as Meeting[];
}

/**
 * One meeting and everything said in it.
 *
 * Ordered by `spoken_at` rather than `created_at`: the first is the browser's
 * own timestamp for the caption block, the second is when the row reached
 * Postgres — which is later, and under load differently ordered, because the
 * container writes through a queue.
 */
export async function getMeetingDetail(meetingId: string): Promise<MeetingDetail | null> {
  const supabase = createSupabaseServerClient();

  const [{ data: meeting, error: mErr }, { data: lines, error: tErr }] = await Promise.all([
    supabase.from("meetings").select("*").eq("id", meetingId).maybeSingle(),
    supabase
      .from("transcripts")
      .select("*")
      .eq("meeting_id", meetingId)
      .order("spoken_at", { ascending: true })
      .limit(2000),
  ]);

  if (mErr) throw new Error(mErr.message);
  if (tErr) throw new Error(tErr.message);
  if (!meeting) return null;

  return {
    meeting: meeting as Meeting,
    transcript: (lines ?? []) as TranscriptLine[],
  };
}
