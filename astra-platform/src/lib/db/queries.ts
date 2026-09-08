import { createSupabaseServerClient } from "@/lib/supabase/server";
import type {
  Employee,
  PreContextRun,
  Team,
  TeamMemberWithEmployee,
  TeamSummary,
  IntegrationsView,
  TeamIntegrations,
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
