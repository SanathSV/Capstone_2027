import { basicAuth, fetchJson, IntegrationError } from "./http";
import { LIMITS, truncate } from "./compaction";
import type { JiraContext, JiraIssue, JiraSprint, RosterEntry } from "./types";

/**
 * Jira half of the context engine.
 *
 * Jira Cloud splits what we need across two APIs: the Agile API owns boards and
 * sprints (including the sprint *goal*, which is the single most useful
 * sentence in the whole payload), while the Platform API owns issue search. We
 * walk project -> board -> active sprint -> issues, and fall back to an
 * open-issues search when the project has no board or no running sprint, so a
 * Kanban team still gets context.
 */

interface JiraBoard {
  id: number;
  name: string;
}
interface JiraBoardsResponse {
  values: JiraBoard[];
}
interface JiraSprintResponse {
  values: {
    id: number;
    name: string;
    state: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  }[];
}
/**
 * The response from `/rest/api/3/search/jql`, Jira's enhanced search.
 *
 * Note what is NOT here: `total`. The old `/rest/api/3/search` endpoint was
 * removed in August 2025 (it now answers 410 Gone) and its replacement paginates
 * with an opaque `nextPageToken` instead of offsets, deliberately dropping the
 * result count — getting one back costs a second call to
 * `/rest/api/3/search/approximate-count`. We do not make that call: the presence
 * of `nextPageToken` already tells us there is more than we asked for, which is
 * all `meta.truncated` needs to say.
 */
interface JiraSearchResponse {
  issues: {
    key: string;
    fields: {
      summary: string;
      status?: { name: string; statusCategory?: { name: string } };
      issuetype?: { name: string };
      priority?: { name: string };
      assignee?: { accountId: string; displayName: string } | null;
      updated: string;
      [custom: string]: unknown;
    };
  }[];
  nextPageToken?: string;
  isLast?: boolean;
}

/** Normalise "https://acme.atlassian.net/" to "https://acme.atlassian.net". */
export function normaliseJiraBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/i.test(trimmed)) {
    throw new IntegrationError(
      "Jira",
      `"${raw}" is not a Jira base URL. Expected https://your-site.atlassian.net.`,
    );
  }
  return trimmed;
}

/** Story points live on a per-site custom field; these are the common ids. */
const POINT_FIELDS = ["customfield_10016", "customfield_10024", "customfield_10004"];

function readPoints(fields: Record<string, unknown>): number | undefined {
  for (const key of POINT_FIELDS) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Quote a value for JQL, escaping the quote character. */
function jqlString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export interface JiraResult {
  context: JiraContext;
  fetched: number;
  truncated: string[];
}

export async function collectJira(
  baseUrlRaw: string,
  projectKey: string,
  email: string,
  apiToken: string,
  roster: RosterEntry[],
): Promise<JiraResult> {
  const baseUrl = normaliseJiraBaseUrl(baseUrlRaw);
  const opts = {
    source: "Jira",
    headers: { authorization: basicAuth(email, apiToken) },
    allowNotFound: true,
  };
  const truncated: string[] = [];

  const byAccount = new Map<string, RosterEntry>();
  for (const person of roster) {
    if (person.jira) byAccount.set(person.jira, person);
  }

  // --- board -> active sprint ---------------------------------------------
  const boards = await fetchJson<JiraBoardsResponse>(
    `${baseUrl}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=1`,
    opts,
  );
  const board = boards?.values?.[0];

  let sprint: JiraSprint | undefined;
  if (board) {
    const sprints = await fetchJson<JiraSprintResponse>(
      `${baseUrl}/rest/agile/1.0/board/${board.id}/sprint?state=active&maxResults=1`,
      opts,
    );
    const active = sprints?.values?.[0];
    if (active) {
      sprint = {
        id: active.id,
        name: active.name,
        state: active.state,
      };
      if (active.goal?.trim()) sprint.goal = truncate(active.goal, 240);
      if (active.startDate) sprint.start = active.startDate.slice(0, 10);
      if (active.endDate) {
        sprint.end = active.endDate.slice(0, 10);
        sprint.days_left = Math.round(
          (Date.parse(active.endDate) - Date.now()) / 86_400_000,
        );
      }
    }
  }

  // --- issues --------------------------------------------------------------
  // Scoped to the active sprint when there is one; otherwise the open backlog.
  // Either way it is narrowed to the team's account ids, because the point is
  // "what is *this standup* carrying", not "what does the project contain".
  const accountIds = [...byAccount.keys()];
  const clauses = [`project = ${jqlString(projectKey)}`];
  if (sprint) {
    clauses.push(`sprint = ${sprint.id}`);
  } else {
    clauses.push("statusCategory != Done");
  }
  if (accountIds.length) {
    clauses.push(`assignee in (${accountIds.map(jqlString).join(", ")})`);
  }
  const jql = `${clauses.join(" AND ")} ORDER BY updated DESC`;

  const fields = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "updated",
    ...POINT_FIELDS,
  ].join(",");

  const search = await fetchJson<JiraSearchResponse>(
    `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
      `&maxResults=${LIMITS.issues}&fields=${encodeURIComponent(fields)}`,
    opts,
  );

  const rawIssues = search?.issues ?? [];
  const statusCounts: Record<string, number> = {};
  const seenAssignees = new Set<string>();

  const issues: JiraIssue[] = rawIssues.map((issue) => {
    const f = issue.fields;
    const category = f.status?.statusCategory?.name ?? f.status?.name ?? "Unknown";
    statusCounts[category] = (statusCounts[category] ?? 0) + 1;

    const entry = f.assignee ? byAccount.get(f.assignee.accountId) : undefined;
    if (entry) seenAssignees.add(entry.ref);

    const out: JiraIssue = {
      key: issue.key,
      summary: truncate(f.summary ?? "", LIMITS.summaryChars),
      status: f.status?.name ?? "Unknown",
      updated: f.updated?.slice(0, 10) ?? "",
    };
    if (f.issuetype?.name) out.type = f.issuetype.name;
    if (f.priority?.name) out.priority = f.priority.name;
    if (f.assignee) out.assignee = entry?.ref ?? f.assignee.displayName;
    const points = readPoints(f as Record<string, unknown>);
    if (points !== undefined) out.points = points;
    return out;
  });

  // A token for the next page means the sprint has more issues than our cap.
  // We do not fetch them: the standup does not need issue 51.
  if (search?.nextPageToken) {
    truncated.push(
      `jira: more than ${issues.length} matching issue(s); kept the ${issues.length} most recently updated`,
    );
  }

  const idle = roster
    .filter((p) => p.jira && !seenAssignees.has(p.ref))
    .map((p) => p.ref);

  const context: JiraContext = {
    base_url: baseUrl,
    project: projectKey,
    issues,
  };
  if (board) context.board = { id: board.id, name: board.name };
  if (sprint) context.sprint = sprint;
  if (Object.keys(statusCounts).length) context.status_counts = statusCounts;
  if (idle.length) context.unassigned_members = idle;

  return { context, fetched: rawIssues.length, truncated };
}
