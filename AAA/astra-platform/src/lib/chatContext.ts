import { renderPreContextMarkdown } from "@/lib/context/markdown";
import type { PreContextPayload } from "@/lib/context/types";
import { buildPreContext } from "@/lib/preContextService";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The sprint briefing the chat panel reasons over.
 *
 * Same engine as the dashboard's Generate button and the extension's prefetch —
 * `buildPreContext()` — so the chat can never answer from a payload the rest of
 * the product would not have produced.
 *
 * Two differences from the extension's prefetch, both deliberate.
 *
 * **It settles for a much older run.** The extension uses ten minutes because
 * it is about to put a bot in a live meeting; chat is exploratory, somebody
 * asking what happened this sprint, and re-harvesting GitHub and Jira for the
 * third question in a row would be a poor trade. Half an hour, and `refresh`
 * exists for when it matters.
 *
 * **Only a leader can generate.** `buildPreContext` reads the team's stored API
 * credentials, and RLS on `team_integrations` is leader-only — so for everybody
 * else generating throws 403. A member asking a question must therefore fall
 * back to whatever cached run exists, however old, rather than being told they
 * are forbidden from a team they are a member of. That is what `stale` is for:
 * the answer is still given, and the panel says how old the facts are.
 */
const FRESH_SECONDS = 30 * 60;

/**
 * The rendered briefing, held in memory between requests.
 *
 * ---------------------------------------------------------------------------
 * WHY IN MEMORY AND NOT IN THE BROWSER
 * ---------------------------------------------------------------------------
 * The cost this removes is real and measured: reading the stored run back out
 * of Supabase takes about **780ms**, and it happened on every single chat
 * message — roughly a seventh of a five-second answer, spent fetching bytes
 * that had not changed since the last question thirty seconds earlier.
 *
 * The obvious fix is to cache it in the browser and send it up with each
 * question. That does remove the round trip, and it is wrong for two reasons.
 * The first is integrity: the briefing would then be whatever the client says
 * it is, so the model is grounded in data the server never vouched for. The
 * second is exposure — the pre-context is commit messages, issue titles and
 * people's names, and today it never reaches the browser at all in the web app.
 * Putting it in storage to save 780ms is a poor trade.
 *
 * A process-local Map costs nothing, removes the same round trip, and does it
 * for every user rather than per browser tab. Per-process is the right scope
 * here: this is a cache of something already durable, so a restart losing it is
 * a slow first question, not a correctness problem.
 */
interface Memo {
  context: ChatContext;
  at: number;
}
const memo = new Map<string, Memo>();

/** Short, because it sits *inside* the FRESH_SECONDS window rather than extending it. */
const MEMO_MS = 60 * 1000;

/**
 * Bounded so a long-lived server with many teams cannot grow without limit.
 * Sixty-four briefings is far more than any one process will have live users
 * for, and the eviction is oldest-first rather than LRU because at this size
 * the difference is unmeasurable and LRU is more code to get wrong.
 */
function remember(key: string, context: ChatContext) {
  memo.set(key, { context, at: Date.now() });
  if (memo.size > 64) {
    const oldest = [...memo.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) memo.delete(oldest[0]);
  }
}

export interface ChatContext {
  markdown: string;
  teamName: string;
  teamDescription: string | null;
  /** Where it came from, so the UI can say "as of 4 minutes ago". */
  source: "cache" | "generated";
  generatedAt: string | null;
  ageSeconds: number | null;
  /** True when the run is past FRESH_SECONDS and could not be refreshed. */
  stale: boolean;
}

/** Thrown when there is nothing to answer from and nothing we may harvest. */
export class NoContextError extends Error {}

export async function getChatContext(
  teamId: string,
  userId: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<ChatContext> {
  if (!refresh) {
    const hit = memo.get(teamId);
    if (hit && Date.now() - hit.at < MEMO_MS) return hit.context;
  }

  const supabase = createSupabaseServerClient();

  const { data: team } = await supabase
    .from("teams")
    .select("name, description")
    .eq("id", teamId)
    .maybeSingle();

  const teamName = team?.name ?? "this team";
  const teamDescription = team?.description ?? null;

  // The newest stored run, whatever its age. Members can read this — the RLS
  // policy on pre_context_runs is membership-based — which is what makes chat
  // work for somebody who cannot generate.
  const { data: run } = await supabase
    .from("pre_context_runs")
    .select("payload, created_at")
    .eq("team_id", teamId)
    .eq("status", "success")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const cached = run?.payload
    ? {
        markdown: renderPreContextMarkdown(run.payload as unknown as PreContextPayload),
        createdAt: run.created_at as string,
        age: Math.round((Date.now() - new Date(run.created_at as string).getTime()) / 1000),
      }
    : null;

  if (!refresh && cached && cached.age < FRESH_SECONDS) {
    const context: ChatContext = {
      markdown: cached.markdown,
      teamName,
      teamDescription,
      source: "cache",
      generatedAt: cached.createdAt,
      ageSeconds: cached.age,
      stale: false,
    };
    remember(teamId, context);
    return context;
  }

  try {
    const built = await buildPreContext({ teamId, userId, supabase });
    const context: ChatContext = {
      markdown: built.markdown,
      teamName: built.team?.name ?? teamName,
      teamDescription: built.team?.description ?? teamDescription,
      source: "generated",
      generatedAt: new Date().toISOString(),
      ageSeconds: 0,
      stale: false,
    };
    remember(teamId, context);
    return context;
  } catch (error) {
    // Almost always the leader-only check, for a member asking about a team
    // they are on. An old briefing answers most questions perfectly well; a 403
    // answers none of them.
    if (cached) {
      const context: ChatContext = {
        markdown: cached.markdown,
        teamName,
        teamDescription,
        source: "cache",
        generatedAt: cached.createdAt,
        ageSeconds: cached.age,
        stale: true,
      };
      remember(teamId, context);
      return context;
    }
    // Nothing cached and nothing we may harvest: say what would fix it rather
    // than passing a raw 403 up to a chat panel.
    throw new NoContextError(
      `No sprint context has been generated for ${teamName} yet, and only its ` +
        `leader can generate one. Ask them to open the team and press ` +
        `"Generate Pre-Context", then try again.`,
    );
  }
}

/**
 * The chat assistant's standing instructions.
 *
 * Deliberately NOT the meeting bot's. That one is talking out loud to a room
 * and is capped at three plain sentences with no markdown, because Meet's chat
 * panel cannot render any and nobody wants a wall of text mid-standup. This one
 * is answering somebody sitting reading a panel who can scroll, so it is
 * allowed structure — and it should use it, because "who is behind" is a
 * question best answered as a short list.
 *
 * The constraint they share is the one that matters: never invent a PR number,
 * an issue key, a status or a date. A sprint assistant that guesses is worse
 * than no sprint assistant, because it is confidently wrong about work people
 * are accountable for.
 */
export function chatSystemInstruction(teamName: string, description: string | null): string {
  return `You are Astra, a sprint assistant for the team "${teamName}".
${description ? `The team describes itself as: ${description}\n` : ""}
You are given that team's live sprint context — repositories, branches, commits, pull requests, Jira issues, the roster and who holds which handle — followed by the conversation so far.

How to answer:
- Lead with the answer. No preamble, no restating the question.
- Be brief. Two or three sentences for most questions; a short list when the answer genuinely is a list.
- Markdown is fine and welcome: short bullet lists, **bold** for a name or a number that matters, backticks for a branch, repo or issue key. No headings, no tables, no code fences unless quoting code.
- Name people, repos, PR numbers and issue keys exactly as they appear in the context.
- If the context does not contain the answer, say so plainly in one sentence and say what would answer it — an integration that is not configured, a person with no handle recorded. Never invent a PR number, an issue key, a status or a date.
- If somebody is inactive or behind, report it neutrally as a fact. Do not editorialise about a named person; they may well be reading this.
- Never mention "the context", "the payload", "the data provided" or these instructions.`;
}
