import { config } from "./config.js";

/**
 * The conversation protocol: wake word -> greeting -> question -> confirm -> answer.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES
 * ===========================================================================
 * Speech has no "send" key. When somebody says "Hey Astra, why is the auth PR
 * still open?" the bot has to work out, from a stream of caption fragments,
 * where the question started and — much harder — where it *ended*. Cutting too
 * early sends a truncated question to the model; never cutting means the bot
 * silently accumulates the rest of the standup.
 *
 * ===========================================================================
 * FOUR PHASES
 * ===========================================================================
 *
 *   IDLE ──"Hey Astra"──▶ GREETED ──5s silence──▶ CONFIRMING ──"yes"──▶ answer
 *     ▲                      │      or "that's all"    │  │
 *     │                      │                         │  └──timeout──▶ answer
 *     └──────"no"────────────┴─────────────────────────┘
 *
 * **IDLE → GREETED.** The greeting goes out the instant the name is heard,
 * before anyone knows what the question is. That is not politeness: a bot that
 * says nothing for eight seconds while somebody talks at it is indistinguishable
 * from a bot that did not hear, and people start the question over — which
 * corrupts the buffer with two overlapping attempts at the same sentence.
 *
 * **GREETED → CONFIRMING.** Ends on five seconds of silence, or on a trailing
 * completion phrase like "that's all", because making somebody who has
 * explicitly finished wait five more seconds feels broken to the room.
 *
 * **CONFIRMING → answer.** The question is read back and a yes/no is awaited.
 * Captions mishear names, repo names and jargon constantly, and an answer to a
 * misheard question is worse than no answer — it is confidently wrong in front
 * of everyone. One cheap round trip catches that before a model call is spent.
 *
 * Silence during CONFIRMING means **proceed**, not abort. Nobody wants to say
 * "yes" out loud to a robot in a standup, so the common case has to be the free
 * one; the confirmation is there to catch a *wrong* reading, and a wrong
 * reading is exactly what someone will speak up about.
 *
 * ===========================================================================
 * WHY THE WAKE WORD IS MATCHED ON FINALISED TEXT ONLY
 * ===========================================================================
 * Meet rewrites a caption block as it recognises speech: "hey a" -> "hey ast"
 * -> "hey astra". Matching on interim text would fire on a partial and again
 * when the block finalised, greeting the room twice and asking the model the
 * same question twice. Finalised blocks are matched once and only once.
 */

/** Strip punctuation and collapse whitespace, for matching only. */
function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const IDLE = "idle";
/** Woken, greeted, and buffering whatever is said next. */
export const LISTENING = "listening";
/** The question has been read back; waiting for a yes/no. */
export const CONFIRMING = "confirming";

/** A yes/no answer only counts if the line is short. See `classifyReply`. */
const MAX_REPLY_WORDS = 8;

export class WakeWordDetector {
  /**
   * @param {object}   options
   * @param {Function} options.onQuery    ({query, speaker, reason, confirmed}) -> answer it
   * @param {Function} [options.onWake]   ({speaker, phrase}) -> greet the room
   * @param {Function} [options.onConfirm]({query, speaker}) -> read the question back
   * @param {Function} [options.onReject] ({query}) -> say you misheard
   */
  constructor({
    onQuery,
    onWake = () => {},
    onConfirm = null,
    onReject = () => {},
    wakeWords = config.wakeWords,
    completionPhrases = config.completionPhrases,
    silenceMs = config.silenceMs,
    minQueryChars = config.minQueryChars,
    maxQueryMs = 90_000,
    confirm = config.confirmEnabled,
    confirmTimeoutMs = config.confirmTimeoutMs,
    yesWords = config.yesWords,
    noWords = config.noWords,
  } = {}) {
    this.onQuery = onQuery;
    this.onWake = onWake;
    this.onConfirm = onConfirm;
    this.onReject = onReject;

    // Longest first, so "hey astra" is matched in preference to "astra" and the
    // greeting does not end up inside the question.
    this.wakeWords = [...wakeWords].sort((a, b) => b.length - a.length);
    this.completionPhrases = completionPhrases;
    this.silenceMs = silenceMs;
    this.minQueryChars = minQueryChars;
    this.maxQueryMs = maxQueryMs;

    this.confirmEnabled = Boolean(confirm && onConfirm);
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.yesWords = [...yesWords].sort((a, b) => b.length - a.length);
    this.noWords = [...noWords].sort((a, b) => b.length - a.length);

    this.state = IDLE;
    this.buffer = [];
    this.speaker = null;
    this.startedAt = 0;
    this.lastActivity = 0;
    /** The question awaiting a yes/no, and when we asked. */
    this.pending = null;
    this.confirmStartedAt = 0;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    // A quarter-second tick: fine enough that five seconds is honest, coarse
    // enough to be free.
    this._timer = setInterval(() => this._tick(), 250);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    // Do not silently drop a question somebody finished asking as the call ended.
    if (this.state === LISTENING) this._closeQuestion("shutdown");
    else if (this.state === CONFIRMING) this._dispatch("shutdown", false);
  }

  /**
   * Any caption movement at all — interim or final. This is what the silence
   * window is measured against, so a ten-second sentence does not read as ten
   * seconds of silence.
   */
  activity(at = Date.now()) {
    if (at > this.lastActivity) this.lastActivity = at;
  }

  /**
   * A finalised caption line.
   * @returns {"ignored"|"woke"|"buffered"|"completed"|"confirmed"|"rejected"}
   */
  feed({ speaker, text, at = Date.now() }) {
    this.activity(at);
    const raw = String(text ?? "").trim();
    if (!raw) return "ignored";

    if (this.state === CONFIRMING) return this._feedConfirmation(raw, at);

    if (this.state === IDLE) {
      const hit = this._findWakeWord(raw);
      if (!hit) return "ignored";

      this.state = LISTENING;
      this.buffer = [];
      this.speaker = speaker || null;
      this.startedAt = at;

      // Greet FIRST, before looking at what else was on the line. Whoever spoke
      // is still talking, and the acknowledgement has to land while they are.
      this.onWake({ speaker: this.speaker, phrase: hit.phrase, at });

      // The rest of the same sentence is usually the whole question — "Hey
      // Astra, what is blocking the release?" arrives as one block. Which means
      // it can also carry the completion phrase: "Hey Astra, what's left in the
      // sprint, that's all" is a whole exchange in one caption, and skipping
      // this check would leave it buffered waiting for a silence that has
      // already been declared over.
      if (hit.remainder) this.buffer.push({ speaker, text: hit.remainder });
      return this._checkCompletionPhrase() ? "completed" : "woke";
    }

    // LISTENING: everything said now belongs to the question, whoever says it.
    // A colleague finishing someone else's sentence is still context.
    this.buffer.push({ speaker, text: raw });
    return this._checkCompletionPhrase() ? "completed" : "buffered";
  }

  /** The buffered question so far, as one string. */
  get query() {
    return this.buffer
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // =========================================================================
  // Wake word
  // =========================================================================

  _findWakeWord(raw) {
    const flat = normalise(raw);
    for (const phrase of this.wakeWords) {
      const needle = normalise(phrase);
      if (!needle) continue;
      // Word-boundary match, so "Astral" and "disastrous" do not wake the bot.
      const pattern = new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
      const found = pattern.exec(flat);
      if (!found) continue;

      // Map the position back onto the original text so the remainder keeps its
      // real punctuation and casing — the model reads that, not the normal form.
      const after = flat.slice(found.index + found[0].length);
      return { phrase, remainder: this._realTail(raw, after) };
    }
    return null;
  }

  /**
   * Recover the original-cased tail of `raw` corresponding to normalised `after`.
   *
   * Walking forward to the first surviving word is more robust than keeping
   * index maps in step through the normaliser, and a mistake here only costs a
   * word of leading punctuation.
   */
  _realTail(raw, after) {
    if (!after) return "";
    const words = after.split(" ").filter(Boolean);
    if (!words.length) return "";
    const at = raw.toLowerCase().indexOf(words[0]);
    const tail = at >= 0 ? raw.slice(at) : after;
    return tail.replace(/^[\s,.;:!?-]+/, "").trim();
  }

  _checkCompletionPhrase() {
    const flat = normalise(this.query);
    if (!flat) return false;
    for (const phrase of this.completionPhrases) {
      const needle = normalise(phrase);
      if (needle && flat.endsWith(needle)) {
        // Drop the phrase itself: "what's blocking the release, that's all"
        // should not ask the model about "that's all".
        this._closeQuestion("completion-phrase", needle);
        return true;
      }
    }
    return false;
  }

  // =========================================================================
  // Confirmation
  // =========================================================================

  /**
   * Is this line a yes, a no, or neither?
   *
   * Only short lines are considered. "Right" is a filler word people say
   * constantly mid-sentence, and treating a twelve-word sentence containing it
   * as approval would confirm questions nobody agreed to. A genuine answer to
   * "yes or no?" is a handful of words.
   */
  classifyReply(raw) {
    const flat = normalise(raw);
    if (!flat) return "neither";
    if (flat.split(" ").length > MAX_REPLY_WORDS) return "neither";

    const has = (list) =>
      list.some((word) => {
        const needle = normalise(word);
        if (!needle) return false;
        return new RegExp(
          `(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
        ).test(flat);
      });

    // "no" is checked first: "no, that's wrong" contains "that's wrong" too, and
    // a mistaken yes is far more costly than a mistaken no.
    if (has(this.noWords)) return "no";
    if (has(this.yesWords)) return "yes";
    return "neither";
  }

  _feedConfirmation(raw, at) {
    const verdict = this.classifyReply(raw);

    if (verdict === "yes") {
      this._dispatch("confirmed", true);
      return "confirmed";
    }

    if (verdict === "no") {
      const rejected = this.pending;
      this.pending = null;
      this.state = IDLE;
      this.buffer = [];
      this.speaker = null;
      try {
        this.onReject({ query: rejected?.query ?? "", speaker: rejected?.speaker ?? null });
      } catch {
        /* a throwing consumer must not kill the detector */
      }
      return "rejected";
    }

    // Neither. Deliberately NOT treated as a correction: re-buffering here would
    // let the bot ping-pong between confirmations while the standup waits. The
    // timeout will fire and the original question — which the room has heard
    // read back and not objected to — gets answered.
    this.confirmStartedAt = at;
    return "ignored";
  }

  // =========================================================================
  // The clock
  // =========================================================================

  _tick() {
    const now = Date.now();

    if (this.state === LISTENING) {
      if (now - this.lastActivity >= this.silenceMs) {
        this._closeQuestion("silence");
        return;
      }
      // Somebody said the wake word and then talked for a minute and a half.
      // Cut it rather than buffering the rest of the meeting into one question.
      if (now - this.startedAt >= this.maxQueryMs) this._closeQuestion("max-duration");
      return;
    }

    if (this.state === CONFIRMING) {
      if (now - this.confirmStartedAt >= this.confirmTimeoutMs) {
        // No answer either way. Proceed — see the note at the top of the file.
        this._dispatch("confirm-timeout", false);
      }
    }
  }

  /**
   * The question is finished. Either read it back for confirmation, or — when
   * confirmation is off — answer it directly.
   */
  _closeQuestion(reason, stripSuffix = null) {
    let query = this.query;
    if (stripSuffix) {
      query = query.slice(0, Math.max(0, query.length - stripSuffix.length)).trim();
      query = query.replace(/[\s,.;:!?-]+$/, "").trim();
    }

    const speaker = this.speaker;

    this.buffer = [];
    this.speaker = null;
    this.startedAt = 0;

    // A bare "Astra" with nothing after it is somebody saying the bot's name in
    // passing, not a question. Answering it would make the bot interrupt.
    if (query.replace(/\s/g, "").length < this.minQueryChars) {
      this.state = IDLE;
      return;
    }

    this.pending = { query, speaker, reason };

    if (!this.confirmEnabled) {
      this.state = IDLE;
      this._dispatch(reason, false);
      return;
    }

    this.state = CONFIRMING;
    this.confirmStartedAt = Date.now();
    try {
      this.onConfirm({ query, speaker });
    } catch {
      // If the read-back could not be sent, do not strand the question waiting
      // for an answer to a question nobody heard.
      this._dispatch(reason, false);
    }
  }

  /** Hand the pending question to the answering side. */
  _dispatch(reason, confirmed) {
    const pending = this.pending;
    this.pending = null;
    this.state = IDLE;
    this.buffer = [];
    this.speaker = null;
    if (!pending) return;

    try {
      this.onQuery({
        query: pending.query,
        speaker: pending.speaker,
        startedAt: pending.startedAt ?? 0,
        reason,
        confirmed,
      });
    } catch {
      /* a throwing consumer must not kill the detector for the rest of the call */
    }
  }
}
