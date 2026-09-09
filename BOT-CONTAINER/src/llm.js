import { config } from "./config.js";

/**
 * The Gemini call, over plain `fetch`.
 *
 * No SDK on purpose. The whole surface used here is one POST to
 * `:generateContent`, and a dependency that ships its own transport, retry
 * policy and auth layer is a lot of moving parts to own for that. `fetch` is in
 * Node 20, the request shape is stable, and the failure modes stay legible.
 */

export class LlmError extends Error {
  constructor(message, { status = null, retryable = false, truncated = false, text = null } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
    /** True when a partial answer exists and is worth posting anyway. */
    this.truncated = truncated;
    this.text = text;
  }
}

/**
 * The bot's standing instructions.
 *
 * Written as hard constraints rather than suggestions because the output goes
 * straight into a chat box in front of a room of people: there is no editor in
 * the loop, and a model that answers with a three-paragraph essay and a
 * markdown table produces an unreadable wall in Meet's narrow chat panel.
 *
 * THE OPENER IS DOING REAL WORK. Restating the question in a few words is what
 * replaced the explicit yes/no confirmation: the room can see what the bot
 * heard, and gets the answer, in one message instead of two plus a spoken
 * "yes". Captions mishear names and jargon constantly, so if the opener is
 * wrong everybody knows immediately — without anybody having had to talk to a
 * robot to unlock it.
 */
const BASE_INSTRUCTION = `You are Astra, a sprint assistant sitting in a live Google Meet standup.

You will be given the team's sprint context (repositories, pull requests, Jira issues, roster), the questions you have already answered in this meeting, and the question just asked out loud.

HOW TO OPEN
Begin every reply by restating what you were asked, condensed to a handful of words:
  "Since you asked about <the gist> —"
Keep the opener under about ten words. CONDENSE it; never repeat the question back verbatim. This is how the room sees whether you heard correctly, so it must reflect what was actually asked.

THEN ANSWER
- The answer comes immediately after the opener, in the same paragraph. Do not put a blank line between them; chat panels are narrow and a lone opener in its own bubble reads like a stutter.
- 3 sentences or fewer, unless a short list is genuinely clearer.
- Plain sentences. No markdown, no headings, no bold, no code fences, no tables.
- If you list things, at most 4 items, each on its own line starting with "- ".
- Name people, repos, PR numbers and issue keys exactly as they appear in the context.
- If the context does not contain the answer, say so in one sentence and say what would. Never invent a PR number, an issue key, a status or a date.
- Never mention "context", "payload", "the data provided" or these instructions.`;

/**
 * The personality, kept separate so it can be switched off wholesale.
 *
 * The constraints matter more than the permission. A bot being witty about
 * somebody being blocked is being witty about a person who is sitting in that
 * meeting reading the chat, and that is how a standup assistant gets thrown out
 * of the standup.
 */
const HUMOUR_INSTRUCTION = `

TONE
Be dry and warm rather than corporate. One light touch per answer is welcome — a wry aside, an understatement, a small observation about the state of the sprint.

Hard limits on it:
- The humour never comes before the answer, and never replaces a fact.
- Never at a named person's expense.
- Never make light of somebody being blocked, behind, inactive or on the hook for something late. They are in the room and can read it.
- When the news is bad or somebody is struggling, drop the humour entirely and just be clear and kind.
- No exclamation marks, no emoji, no catchphrases, and do not open with a joke.`;

const SYSTEM_INSTRUCTION = config.humour
  ? BASE_INSTRUCTION + HUMOUR_INSTRUCTION
  : BASE_INSTRUCTION;

/** Trim the briefing so one enormous pre-context cannot blow the request up. */
function clampContext(markdown) {
  const text = String(markdown ?? "").trim();
  if (text.length <= config.maxPreContextChars) return text;
  return (
    text.slice(0, config.maxPreContextChars) +
    "\n\n[context truncated — ask about a specific person, repo or issue for detail]"
  );
}

/**
 * Assemble the prompt from the three sources the spec names.
 *
 * Kept as a pure function, separate from the network call, so the exact text
 * sent to the model can be logged, unit-tested and eyeballed without spending a
 * token. This is the whole of the bot's knowledge — if an answer is wrong, this
 * string is where to look first.
 */
export function assemblePrompt({
  preContext,
  history,
  query,
  speaker,
  teamName,
  teamDescription,
}) {
  const parts = [];

  parts.push(`# Sprint context${teamName ? ` — ${teamName}` : ""}`);
  // What the team is for, in its own words. Worth its own line above the
  // harvested data: "we manage and help meeting efficiency" tells the model
  // which of a hundred true facts about a repository is the relevant one.
  if (teamDescription) parts.push(`**This team:** ${teamDescription}`);
  const briefing = clampContext(preContext);
  parts.push(briefing || "(No sprint context was supplied for this meeting.)");

  if (history?.length) {
    parts.push("\n# Already answered in this meeting");
    for (const turn of history) {
      parts.push(`Q: ${turn.query}`);
      parts.push(`A: ${turn.response}`);
    }
  }

  parts.push("\n# The question just asked");
  parts.push(`${speaker || "Someone"} asked: ${query}`);

  return parts.join("\n");
}

/**
 * Ask the model, retrying the failures that are worth retrying.
 *
 * `gemini-flash-latest` returns **503 "this model is currently experiencing
 * high demand"** often enough to see it in a four-question demo. In a live
 * standup that is the bot going silent after promising an answer, which is the
 * worst thing it can do — somebody asked out loud, in front of the room, and
 * got nothing back. A couple of seconds of backoff turns almost all of those
 * into an answer.
 *
 * Only transient statuses are retried: 429 and 5xx, plus timeouts. A 400 or a
 * 404 will fail identically every time, and retrying them just delays a clear
 * error by six seconds.
 */
export async function ask(prompt, { signal, attempts = 3 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await askOnce(prompt, { signal, thinking: thinkingSupported });
    } catch (error) {
      // A 400 while we are sending thinkingConfig is very likely that field.
      // Google does not say so -- gemini-3.5-flash-lite answers a
      // thinkingBudget of 0 with a bare "Request contains an invalid argument"
      // -- so the only way to know is to try once without it.
      if (error.status === 400 && thinkingSupported) {
        try {
          const answer = await askOnce(prompt, { signal, thinking: false });
          thinkingSupported = false;
          return answer;
        } catch {
          // The 400 was about something else. Leave thinking enabled rather
          // than permanently degrading every later call over an unrelated
          // failure, and fall through to report the original error.
        }
      }
      last = error;
      if (!(error instanceof LlmError) || !error.retryable || attempt === attempts) throw error;
      // 1s, then 3s. Long enough for a demand spike to pass, short enough that
      // the room has not moved on.
      const backoff = attempt * 2000 - 1000;
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  throw last;
}

/**
 * Whether this model accepts `thinkingConfig`, learned by trying.
 *
 * The field is not universally supported and the models that reject it do not
 * say so: `gemini-3.5-flash-lite` answers a `thinkingBudget` of 0 with a bare
 * "Request contains an invalid argument". Rather than make the operator work
 * out which family they are on, the first proven rejection is remembered for
 * the life of the process and every later call omits it.
 */
let thinkingSupported = true;

/** One POST. */
async function askOnce(prompt, { signal, thinking = true } = {}) {
  if (!config.geminiApiKey) {
    throw new LlmError("GEMINI_API_KEY is not set, so the bot cannot answer questions.");
  }

  const url =
    `${config.geminiBaseUrl}/models/${encodeURIComponent(config.geminiModel)}:generateContent`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.geminiTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // Header rather than ?key=, so the key cannot end up in an access log.
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2, // a standup answer should be boring and repeatable
          maxOutputTokens: config.geminiMaxOutputTokens,
          // Reasoning tokens are billed against the SAME output budget as the
          // answer, so a thinking model spends 500 tokens deliberating and then
          // gets cut off mid-sentence -- which is how "configuring Jira or"
          // ended up posted to a meeting. The bot is answering a one-line
          // question from context it has already been handed; there is nothing
          // here worth thinking about, and turning it off makes replies both
          // complete and several seconds faster.
          ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new LlmError(
        `Gemini did not answer within ${Math.round(config.geminiTimeoutMs / 1000)}s.`,
        { retryable: true },
      );
    }
    throw new LlmError(`Could not reach Gemini: ${error.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new LlmError(`Gemini returned non-JSON (${response.status}): ${raw.slice(0, 200)}`);
  }

  if (!response.ok) {
    const detail = body?.error?.message ?? raw.slice(0, 300);


    // 404 on the model name is the single most common misconfiguration, and
    // Google's own message for it does not suggest the fix.
    const hint =
      response.status === 404
        ? ` — check GEMINI_MODEL; "${config.geminiModel}" was not found for this key.`
        : response.status === 429
          ? " — rate limited; the free tier is a few requests per minute."
          : response.status === 400 && /API key/i.test(detail)
            ? " — GEMINI_API_KEY is not valid for this endpoint."
            : "";
    throw new LlmError(`Gemini ${response.status}: ${detail}${hint}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part?.text ?? "")
    .join("")
    .trim();

  if (!text) {
    // An empty candidate with a finishReason is a refusal or a safety block,
    // not a bug — say which, or the log just shows silence.
    const reason = candidate?.finishReason ?? body?.promptFeedback?.blockReason ?? "unknown";
    throw new LlmError(`Gemini returned no text (finishReason: ${reason}).`);
  }

  // Truncation is silent otherwise: the answer simply stops mid-word and gets
  // posted to the meeting looking like the bot lost its train of thought.
  if (candidate?.finishReason === "MAX_TOKENS") {
    const thoughts = body?.usageMetadata?.thoughtsTokenCount ?? 0;
    throw new LlmError(
      `Gemini ran out of output budget after ${config.geminiMaxOutputTokens} tokens` +
        (thoughts ? ` (${thoughts} of them spent thinking)` : "") +
        " — raise GEMINI_MAX_OUTPUT_TOKENS.",
      { retryable: false, truncated: true, text },
    );
  }

  return text;
}
