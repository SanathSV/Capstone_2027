import { ApiError, cleanString, json, readJson, requireUser, route } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encryptSecret } from "@/lib/crypto";
import type { Team } from "@/lib/db/types";

/**
 * Team creation.
 *
 * One POST carries the whole wizard: the team, its roster picked out of the
 * resource pool with a sprint role each, and optionally the integration
 * credentials. The creator becomes the leader — enforced by the
 * `teams_register_leader` trigger in schema.sql, not by this route, so it holds
 * no matter who inserts the row.
 */

export const dynamic = "force-dynamic";

interface MemberInput {
  employee_id: string;
  sprint_role?: string;
}

interface CreateTeamBody {
  name?: string;
  description?: string;
  sprint_name?: string;
  members?: MemberInput[];
  integrations?: {
    slack_bot_token?: string;
    slack_channel_id?: string;
    github_token?: string;
    github_repo_url?: string;
    jira_base_url?: string;
    jira_project_key?: string;
    jira_email?: string;
    jira_api_token?: string;
  };
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson<CreateTeamBody>(request);

    const name = cleanString(body.name, { field: "Team name", max: 120, required: true })!;
    const description = cleanString(body.description, { field: "Description", max: 2000 });
    const sprint_name = cleanString(body.sprint_name, { field: "Sprint", max: 120 });

    const supabase = createSupabaseServerClient();

    // 1. The team. leader_id must be the caller — the RLS insert policy checks
    //    the same thing, so a forged body cannot create a team under someone
    //    else's name.
    const { data: team, error: teamError } = await supabase
      .from("teams")
      .insert({ name, description, sprint_name, leader_id: user.id })
      .select("*")
      .single();

    if (teamError) throw new ApiError(400, teamError.message);
    const created = team as Team;

    // 2. The roster. The trigger has already seated the leader, so skip any
    //    duplicate of them rather than failing the whole request on a conflict.
    const members = (body.members ?? []).filter((m) => m?.employee_id);
    if (members.length) {
      const rows = members.map((m) => ({
        team_id: created.id,
        employee_id: m.employee_id,
        sprint_role:
          cleanString(m.sprint_role, { field: "Sprint role", max: 60 }) ?? "Engineer",
      }));

      const { error: memberError } = await supabase
        .from("team_members")
        .upsert(rows, { onConflict: "team_id,employee_id", ignoreDuplicates: true });

      if (memberError) {
        // The team exists but is unusable without its roster, so roll it back
        // rather than leaving a half-built team on the dashboard.
        await supabase.from("teams").delete().eq("id", created.id);
        throw new ApiError(400, `Could not add the roster: ${memberError.message}`);
      }
    }

    // 3. Integrations, if the wizard collected any. Every secret is encrypted
    //    before it goes near the database.
    const integrations = body.integrations ?? {};
    const hasAny = Object.values(integrations).some(
      (v) => typeof v === "string" && v.trim(),
    );
    if (hasAny) {
      const { error: intError } = await supabase.from("team_integrations").insert({
        team_id: created.id,
        slack_bot_token: encryptSecret(integrations.slack_bot_token),
        slack_channel_id: cleanString(integrations.slack_channel_id, {
          field: "Slack channel ID",
          max: 32,
        }),
        github_token: encryptSecret(integrations.github_token),
        github_repo_url: cleanString(integrations.github_repo_url, {
          field: "GitHub repository URL",
          max: 300,
        }),
        jira_base_url: cleanString(integrations.jira_base_url, {
          field: "Jira base URL",
          max: 300,
        })?.replace(/\/+$/, ""),
        jira_project_key: cleanString(integrations.jira_project_key, {
          field: "Jira project key",
          max: 15,
        })?.toUpperCase(),
        jira_email: cleanString(integrations.jira_email, { field: "Jira email", max: 254 }),
        jira_api_token: encryptSecret(integrations.jira_api_token),
      });

      // A bad credential is worth reporting, but not worth destroying a team
      // whose roster is already correct — the leader can fix it on the team page.
      if (intError) {
        return json(
          {
            team: created,
            warning: `The team was created, but the integration settings were rejected: ${intError.message}`,
          },
          201,
        );
      }
    }

    return json({ team: created }, 201);
  });
}

export async function GET() {
  return route(async () => {
    await requireUser();
    const supabase = createSupabaseServerClient();
    // RLS returns only teams the caller leads or belongs to.
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw new ApiError(500, error.message);
    return json({ teams: (data ?? []) as Team[] });
  });
}
