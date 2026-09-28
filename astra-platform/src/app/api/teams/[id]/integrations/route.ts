import {
  ApiError,
  assertUuid,
  cleanString,
  json,
  readJson,
  requireTeamLeader,
  route,
} from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encryptSecret } from "@/lib/crypto";
import { getIntegrationsView } from "@/lib/db/queries";

/**
 * Team-level integration credentials.
 *
 * Two rules govern this route and everything that reads the table:
 *
 *  1. Secrets go in encrypted and never come back out. GET returns booleans for
 *     the token fields; the form shows "configured" rather than a masked value,
 *     because a masked value still has to travel to the browser to be masked.
 *  2. An omitted token means "leave it alone", an explicit empty string means
 *     "clear it". Without that distinction, saving the form to change a channel
 *     ID would silently wipe the bot token.
 */

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

interface IntegrationsBody {
  slack_bot_token?: string | null;
  slack_channel_id?: string | null;
  github_token?: string | null;
  github_repo_url?: string | null;
  jira_base_url?: string | null;
  jira_project_key?: string | null;
  jira_email?: string | null;
  jira_api_token?: string | null;
}

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamLeader(teamId);
    return json({ integrations: await getIntegrationsView(teamId) });
  });
}

export async function PUT(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamLeader(teamId);
    const body = await readJson<IntegrationsBody>(request);

    const patch: Record<string, unknown> = { team_id: teamId };

    // --- non-secret fields, validated so the DB constraint never has to speak
    if ("slack_channel_id" in body) {
      const channel = cleanString(body.slack_channel_id, {
        field: "Slack channel ID",
        max: 32,
      });
      if (channel && !/^[CGD][A-Z0-9]{6,20}$/.test(channel)) {
        throw new ApiError(
          400,
          "That is not a Slack channel ID. It starts with C (or G/D) — open the channel, scroll to the bottom of its details, and copy the ID.",
        );
      }
      patch.slack_channel_id = channel;
    }

    if ("github_repo_url" in body) {
      const url = cleanString(body.github_repo_url, {
        field: "GitHub repository URL",
        max: 300,
      })?.replace(/\.git$/, "").replace(/\/+$/, "");
      if (url && !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(url)) {
        throw new ApiError(
          400,
          "Enter the repository URL as https://github.com/owner/repo.",
        );
      }
      patch.github_repo_url = url ?? null;
    }

    if ("jira_base_url" in body) {
      const url = cleanString(body.jira_base_url, { field: "Jira base URL", max: 300 })
        ?.replace(/\/+$/, "");
      if (url && !/^https:\/\/[^/\s]+$/.test(url)) {
        throw new ApiError(
          400,
          "Enter the Jira site URL as https://your-site.atlassian.net, with no path.",
        );
      }
      patch.jira_base_url = url ?? null;
    }

    if ("jira_project_key" in body) {
      const key = cleanString(body.jira_project_key, {
        field: "Jira project key",
        max: 15,
      })?.toUpperCase();
      if (key && !/^[A-Z][A-Z0-9_]{1,14}$/.test(key)) {
        throw new ApiError(
          400,
          "A Jira project key is short and upper-case, like PAY or CORE — it is the prefix on every issue key.",
        );
      }
      patch.jira_project_key = key ?? null;
    }

    if ("jira_email" in body) {
      patch.jira_email = cleanString(body.jira_email, { field: "Jira email", max: 254 });
    }

    // --- secrets: absent = unchanged, "" = cleared, value = re-encrypted ----
    for (const [field, column] of [
      ["slack_bot_token", "slack_bot_token"],
      ["github_token", "github_token"],
      ["jira_api_token", "jira_api_token"],
    ] as const) {
      if (!(field in body)) continue;
      const raw = body[field];
      patch[column] = raw === null || raw === "" ? null : encryptSecret(String(raw));
    }

    const supabase = createSupabaseServerClient();
    const { error } = await supabase
      .from("team_integrations")
      .upsert(patch, { onConflict: "team_id" });

    if (error) throw new ApiError(400, error.message);

    return json({ integrations: await getIntegrationsView(teamId) });
  });
}
