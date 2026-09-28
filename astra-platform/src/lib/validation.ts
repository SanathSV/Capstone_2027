import { ApiError, cleanString } from "@/lib/api";

/**
 * Directory handle validation, shared by the create and update routes.
 *
 * These rules mirror the CHECK constraints in supabase/schema.sql. Duplicating
 * them here is not belt-and-braces: the database would reject a bad handle with
 * "employees_slack_user_id_check", and a constraint name is not something to
 * put in front of someone filling in a form.
 */

export interface HandleInput {
  github_username?: unknown;
  jira_account_id?: unknown;
  slack_user_id?: unknown;
}

export function validateHandles(body: HandleInput) {
  const github = cleanString(body.github_username, {
    field: "GitHub username",
    max: 39,
  });
  if (github && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(github)) {
    throw new ApiError(
      400,
      "That is not a GitHub username. Use the handle from github.com/<handle>, not a URL or an email.",
    );
  }

  const slack = cleanString(body.slack_user_id, { field: "Slack user ID", max: 21 });
  if (slack && !/^[UW][A-Z0-9]{6,20}$/.test(slack)) {
    throw new ApiError(
      400,
      "That is not a Slack member ID. It starts with U or W, e.g. U01ABCDEF — find it under Profile → More → Copy member ID.",
    );
  }

  const jira = cleanString(body.jira_account_id, { field: "Jira account ID", max: 128 });

  return { github, slack, jira };
}
