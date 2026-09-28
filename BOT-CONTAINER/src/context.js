import { config } from "./config.js";

/**
 * The in-memory conversation window for one live meeting.
 *
 * ---------------------------------------------------------------------------
 * WHY IN MEMORY, AND WHY A FIXED WINDOW
 * ---------------------------------------------------------------------------
 * The bot needs to understand "and what about his PR?" — which means it needs
 * the previous question and answer. There are two places that could come from:
 *
 *   (a) query the `transcripts` table back out of Supabase, or
 *   (b) keep it in a local array.
 *
 * (a) is what the container deliberately does not do. It puts a database
 * round-trip between someone finishing a sentence and the bot replying, it
 * costs a query per question, and the cost grows with the length of the
 * meeting — so the bot gets slower exactly as the standup drags on. A standup
 * lasts fifteen minutes and generates a handful of questions; that fits in a
 * few kilobytes of RAM, and the process is torn down when the call ends anyway.
 *
 * The window is capped in *pairs* rather than messages, because half a turn is
 * worse than no turn: a question without its answer tells the model what was
 * asked and not what was already said back, and it will happily repeat itself.
 *
 * The full transcript still goes to Supabase, line by line. This array is the
 * working set; that table is the record.
 */

export class SessionContext {
  constructor({
    preContext = "",
    teamName = null,
    teamDescription = null,
    maxTurns = config.maxContextTurns,
  } = {}) {
    /** Static briefing from the summon payload. Never mutated. */
    this.preContext = preContext;
    this.teamName = teamName;
    /** What the team is FOR, in its own words. Steers answers noticeably. */
    this.teamDescription = teamDescription;
    this.maxTurns = Math.max(1, maxTurns);
    /** [{ query, response, speaker, at }] — oldest first. */
    this.turns = [];
    this.totalQuestions = 0;
  }

  /** Record a completed exchange. The oldest turn falls off the end. */
  remember({ query, response, speaker = null }) {
    this.turns.push({
      query: String(query).trim(),
      response: String(response).trim(),
      speaker,
      at: new Date().toISOString(),
    });
    this.totalQuestions += 1;
    while (this.turns.length > this.maxTurns) this.turns.shift();
  }

  /** The window, oldest first, for prompt assembly. */
  history() {
    return this.turns.map(({ query, response }) => ({ query, response }));
  }

  get size() {
    return this.turns.length;
  }

  /**
   * A rough token count for the whole prompt, for logging.
   *
   * Four characters per token is the usual English approximation and is good
   * enough to answer the only question anyone asks of it — "is this about to
   * get expensive?".
   */
  estimateTokens() {
    const chars =
      this.preContext.length +
      this.turns.reduce((sum, t) => sum + t.query.length + t.response.length, 0);
    return Math.ceil(chars / 4);
  }
}
