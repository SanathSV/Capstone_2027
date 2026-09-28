/**
 * Gemini, from the dashboard.
 *
 * A second, deliberately separate implementation from BOT-CONTAINER's. They
 * answer different questions — the bot is talking to a room mid-standup and is
 * tuned for three sentences and no markdown, this one is answering a person
 * reading a chat panel who can scroll — and sharing one module across two
 * processes with different runtimes, different deploy targets and different
 * output rules would couple them for the sake of one `fetch`.
 *
 * What IS shared is the hard-won configuration: no thinking budget, retry on
 * transient failures, key in a header. Those were each a bug once.
 */

const BASE_URL =
  process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta";
const MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-latest";
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 30_000);
const MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS ?? 1024);

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Learned by trying: not every model accepts `thinkingConfig`. See below. */
let thinkingSupported = true;

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

/**
 * Ask Gemini, retrying the failures worth retrying.
 *
 * `gemini-flash-latest` returns 503 "experiencing high demand" often enough to
 * see it in a handful of requests, and a chat panel that gives up on the first
 * one looks broken. 429 and 5xx get two retries with backoff; a 400 or 404 will
 * fail identically every time and is surfaced immediately.
 */
export async function askGemini(
  { system, history, question }: { system: string; history: ChatTurn[]; question: string },
  { attempts = 3 }: { attempts?: number } = {},
): Promise<string> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await once({ system, history, question }, thinkingSupported);
    } catch (error) {
      last = error;
      const err = error as GeminiError;

      // A 400 while we are sending thinkingConfig is very likely that field.
      // Google does not say so — gemini-3.5-flash-lite answers a thinkingBudget
      // of 0 with a bare "Request contains an invalid argument" — so the only
      // way to know is to try once without it.
      if (err.status === 400 && thinkingSupported) {
        try {
          const answer = await once({ system, history, question }, false);
          thinkingSupported = false;
          return answer;
        } catch {
          // The 400 was about something else; leave thinking on rather than
          // degrading every later call over an unrelated failure.
        }
      }

      if (!(error instanceof GeminiError) || !err.retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000 - 1000));
    }
  }
  throw last;
}

async function once(
  { system, history, question }: { system: string; history: ChatTurn[]; question: string },
  thinking: boolean,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiError(
      "GEMINI_API_KEY is not set on the server, so Astra cannot answer. Add it to " +
        ".env.local and restart `npm run dev`.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/models/${encodeURIComponent(MODEL)}:generateContent`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        // A header rather than ?key=, so the key cannot end up in an access log.
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
          { role: "user", parts: [{ text: question }] },
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // Reasoning tokens are billed against the SAME output budget as the
          // answer, so a thinking model spends the budget deliberating and then
          // gets cut off mid-sentence. There is nothing here worth thinking
          // about — the facts are in the prompt already.
          ...(thinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      throw new GeminiError(
        `Gemini did not answer within ${Math.round(TIMEOUT_MS / 1000)}s.`,
        null,
        true,
      );
    }
    throw new GeminiError(`Could not reach Gemini: ${err.message}`, null, true);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let body: {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new GeminiError(`Gemini returned non-JSON (${response.status}): ${raw.slice(0, 200)}`);
  }

  if (!response.ok) {
    const detail = body.error?.message ?? raw.slice(0, 300);
    const hint =
      response.status === 404
        ? ` — check GEMINI_MODEL; "${MODEL}" was not found for this key.`
        : response.status === 429
          ? " — rate limited; the free tier allows a few requests a minute."
          : "";
    throw new GeminiError(
      `Gemini ${response.status}: ${detail}${hint}`,
      response.status,
      response.status === 429 || response.status >= 500,
    );
  }

  const candidate = body.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    // An empty candidate with a finishReason is a refusal or a safety block,
    // not a bug — say which, or the panel just shows silence.
    const reason = candidate?.finishReason ?? body.promptFeedback?.blockReason ?? "unknown";
    throw new GeminiError(`Gemini returned no text (finishReason: ${reason}).`);
  }

  if (candidate?.finishReason === "MAX_TOKENS") return `${text} […]`;
  return text;
}
