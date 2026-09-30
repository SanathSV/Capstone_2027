import { ApiError, assertUuid, json, readJson, requireTeamLeader, route } from "@/lib/api";
import { chatSystemInstruction, getChatContext, NoContextError } from "@/lib/chatContext";
import { askGemini, geminiConfigured, GeminiError, type ChatTurn } from "@/lib/gemini";

/**
 * POST /api/chat — ask Astra about a team.
 *
 * The whole sprint context is re-sent on every turn rather than kept in a
 * server-side session. That is not laziness: a chat panel is opened, abandoned
 * and reopened constantly, and a server that remembered conversations would
 * need eviction, a store, and a story for what happens when two tabs disagree.
 * The context is a couple of thousand tokens and cached for half an hour; the
 * transcript of the conversation lives in the component that is displaying it,
 * which is the only place that actually knows what the user can still see.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ChatBody {
  team_id?: string;
  message?: string;
  /** Prior turns, oldest first. Trimmed server-side — see MAX_HISTORY. */
  history?: { role?: string; text?: string }[];
  refresh?: boolean;
}

/**
 * Turns of history to keep. Capped in PAIRS by the client; capped again here
 * because "the client will behave" is not a security property, and an unbounded
 * history is an unbounded bill.
 */
const MAX_HISTORY = 24;

export async function POST(request: Request) {
  return route(async () => {
    const body = await readJson<ChatBody>(request);

    const teamId = assertUuid((body.team_id ?? "").trim(), "Team id");
    const message = (body.message ?? "").trim();
    if (!message) throw new ApiError(400, "A question is required.");
    if (message.length > 2000) throw new ApiError(400, "That question is too long.");

    // LEADERSHIP, checked server-side — not membership. The team id comes from a
    // select box in the browser and is trivially forged, and this is the check
    // that makes hiding the button from members a UI convenience rather than
    // the security boundary.
    const user = await requireTeamLeader(teamId);

    if (!geminiConfigured()) {
      throw new ApiError(
        503,
        "Astra's chat is not configured on this server: GEMINI_API_KEY is missing. " +
          "Add it to .env.local and restart `npm run dev`.",
      );
    }

    let context;
    try {
      context = await getChatContext(teamId, user.id, { refresh: body.refresh === true });
    } catch (error) {
      // 409, not 502: nothing is broken, the team simply has no briefing yet
      // and this caller is not allowed to make one.
      if (error instanceof NoContextError) throw new ApiError(409, error.message);
      throw error;
    }

    const history: ChatTurn[] = (body.history ?? [])
      .slice(-MAX_HISTORY)
      .filter((turn) => typeof turn.text === "string" && turn.text.trim())
      .map((turn) => ({
        role: turn.role === "model" ? "model" : "user",
        text: String(turn.text).slice(0, 4000),
      }));

    // The briefing rides on the first user turn rather than in the system
    // instruction, so the model treats it as material to reason over rather
    // than as rules to obey.
    const question =
      history.length === 0
        ? `# Sprint context\n${context.markdown}\n\n# Question\n${message}`
        : message;

    if (history.length > 0) {
      history.unshift(
        { role: "user", text: `# Sprint context\n${context.markdown}` },
        { role: "model", text: "Got it — I have the team's sprint context." },
      );
    }

    try {
      const answer = await askGemini({
        system: chatSystemInstruction(context.teamName, context.teamDescription),
        history,
        question,
      });

      return json({
        answer,
        context: {
          source: context.source,
          generated_at: context.generatedAt,
          age_seconds: context.ageSeconds,
          stale: context.stale,
          chars: context.markdown.length,
        },
      });
    } catch (error) {
      if (error instanceof GeminiError) {
        throw new ApiError(error.status === 429 ? 429 : 502, error.message);
      }
      throw error;
    }
  });
}
