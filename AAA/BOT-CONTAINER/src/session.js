import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { MARK, logger, redact } from "./log.js";
import { FifoQueue } from "./queue.js";
import { SessionContext } from "./context.js";
import { WakeWordDetector } from "./wake.js";
import { assemblePrompt, ask } from "./llm.js";
import { createMeeting, insertTranscript, resolveTeam, updateMeeting } from "./db.js";
import { launchContext, signInWithPassword } from "./meet/browser.js";
import {
  dumpCaptionDiagnostics,
  flushCaptions,
  installCaptionObserver,
} from "./meet/captions.js";
import { passGoogleGate, verifySession } from "./meet/google.js";
import { sendAnswer, toPlainText } from "./meet/chat.js";
import {
  callIsAlive,
  clickJoin,
  dismissOverlays,
  enableCaptions,
  fillGuestName,
  isAlone,
  leaveCall,
  muteDevices,
  saveDebugShot,
  setCaptionLanguage,
  signedInAccount,
  startCaptionWatchdog,
  waitUntilInCall,
} from "./meet/join.js";

/**
 * One meeting, from summon to hang-up.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF THE THING
 * ---------------------------------------------------------------------------
 * A session owns exactly one browser, one meeting row, and two queues, and it
 * is the only place those are allowed to touch each other:
 *
 *   captions ──delta──> WakeWordDetector.activity()   (resets the silence timer)
 *            └─final──> transcriptQueue ──> Supabase   (durable record)
 *                    └> WakeWordDetector.feed()        (wake word + buffering)
 *                                        │
 *                                   onQuery │ (5s silence, or "that's all")
 *                                        ▼
 *                             answerQueue ──> Gemini ──> Meet chat
 *                                        └──> SessionContext.remember()
 *
 * Two separate FIFO queues rather than one, because they are serialised for
 * different reasons. Transcript writes are ordered so the record reads in the
 * order people spoke. Answers are ordered so the bot never replies to a second
 * question before the first — which, in a chat panel, would be incoherent.
 *
 * Nothing in the live path reads from Supabase. See context.js for why.
 */

export const STATUSES = [
  "queued",
  "launching",
  "joining",
  "waiting_admission",
  "in_call",
  "leaving",
  "ended",
  "failed",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class BotSession {
  constructor(summon) {
    this.id = randomUUID();
    this.summon = summon;
    this.log = logger(`[${this.id.slice(0, 8)}]`);

    this.status = "queued";
    this.error = null;
    this.startedAt = new Date();
    this.endedAt = null;
    this.joinedAt = null;

    this.team = {
      id: null,
      name: summon.teamName,
      description: summon.teamDescription,
      ref: summon.teamId,
      resolved: false,
    };
    this.meeting = null;
    this.googleAccount = null;
    /** "signed_in" | "guest" | null — how the bot actually got into the room. */
    this.joinedAs = null;
    /** Set when the saved session was refused and we fell back to a guest join. */
    this.credentialWarning = null;
    /** Whether Meet's CC toggle could actually be turned on. */
    this.captionsEnabled = null;

    this.context = new SessionContext({
      preContext: summon.preContext,
      teamName: summon.teamName,
    });

    this.transcriptQueue = new FifoQueue({
      name: "transcripts",
      onError: (error) => this.log.error("transcript write failed", error),
    });
    this.answerQueue = new FifoQueue({
      name: "answers",
      onError: (error) => this.log.error("answer failed", error),
    });

    /**
     * Every write to the Meet chat box, serialised.
     *
     * Separate from `answerQueue` because the two are serialised for different
     * reasons and at different speeds. Posting is a DOM interaction — click,
     * fill, Enter — and two of those overlapping would type half of one message
     * into the middle of another. But the greeting has to go out *now*, while
     * the person is still talking, and it must not queue behind a model call
     * that is still thinking about the previous question.
     */
    this.chatQueue = new FifoQueue({
      name: "chat",
      onError: (error) => this.log.error("chat post failed", error),
    });

    this.detector = new WakeWordDetector({
      onWake: ({ speaker, phrase }) => {
        this.log.debug(`wake word "${phrase}" from ${speaker ?? "someone"}`);
        // Straight onto the chat queue, not through the LLM: the whole point is
        // that this lands while they are still speaking. The 💬 line _say emits
        // already says what was posted, so narrating it again here would just
        // double the log for no extra information.
        this._say(config.greeting);
      },
      onConfirm: ({ query, speaker }) => {
        this.counts.confirmations += 1;
        this._say(`If I'm not wrong, you're asking: "${query}" — yes or no?`);
      },
      onReject: ({ query }) => {
        this.counts.rejected += 1;
        this.log.debug(`the room said that was not the question: "${query}"`);
        this._say(config.rejectedReply);
      },
      onQuery: (query) => this._onQuery(query),
    });

    /**
     * The last few hundred lines, in memory, purely so they can be READ BACK
     * over the API.
     *
     * This is not a second source of truth — Supabase is the record — and it is
     * not the model's working set either (that is SessionContext). It exists
     * because "is it hearing anything?" is the question people actually have
     * during a meeting, and the honest answer to it should not require grepping
     * a docker log through a pipe that buffers.
     */
    this.transcript = [];

    /** Monotonic per-session row number, printed on both the caption and the
     *  database marker so the two lines can be matched up by eye. */
    this._rowNo = 0;

    this.counts = {
      finalLines: 0,
      deltas: 0,
      questions: 0,
      answers: 0,
      confirmations: 0,
      rejected: 0,
      chatFailures: 0,
      rowsWritten: 0,
      rowsFailed: 0,
    };

    this.browser = null;
    this.page = null;
    this._stopWatchdog = null;
    this._monitor = null;
    this._closing = false;
    this._aloneSince = null;
  }

  /** The serialisable view — what /api/start-bot returns and /api/sessions lists. */
  describe() {
    return {
      session_id: this.id,
      status: this.status,
      error: this.error,
      team: {
        id: this.team.id,
        ref: this.team.ref,
        name: this.team.name,
        description: this.team.description,
        resolved: this.team.resolved,
      },
      meeting: this.meeting
        ? { id: this.meeting.id, number: this.meeting.meeting_number }
        : null,
      meet_link: this.summon.meetLink,
      google_account: this.googleAccount,
      joined_as: this.joinedAs,
      credential_warning: this.credentialWarning,
      captions_enabled: this.captionsEnabled,
      credentials: redact(
        this.summon.credentials.mode === "storage_state"
          ? this.summon.credentials.storageState
          : this.summon.credentials,
      ),
      pre_context: {
        format: "markdown",
        chars: this.summon.preContext.length,
        tokens: Math.ceil(this.summon.preContext.length / 4),
      },
      started_at: this.startedAt.toISOString(),
      joined_at: this.joinedAt?.toISOString() ?? null,
      ended_at: this.endedAt?.toISOString() ?? null,
      counts: { ...this.counts, context_turns: this.context.size },
      queues: {
        transcripts: this.transcriptQueue.stats,
        answers: this.answerQueue.stats,
        chat: this.chatQueue.stats,
      },
    };
  }

  /**
   * The conversation so far, newest last.
   *
   * Deliberately not read from Supabase: the no-reads-during-a-meeting rule
   * holds, and this has to keep working when the database is unreachable — the
   * moment you most want to know whether the bot can hear anything.
   */
  transcriptView({ limit = 100 } = {}) {
    return this.transcript.slice(-limit);
  }

  _setStatus(status, extra) {
    this.status = status;
    this.log.info(`status: ${status}${extra ? ` — ${extra}` : ""}`);
    if (this.meeting) {
      // Fire and forget: a status write must never block the meeting.
      updateMeeting(this.meeting.id, { status }).catch((error) =>
        this.log.warn("could not update meeting status", error.message),
      );
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Prepare everything that can fail *before* a browser exists.
   *
   * The endpoint awaits this and nothing more, so a caller finds out about a
   * bad team id or an unreachable database in its HTTP response rather than
   * from a log line thirty seconds later.
   */
  async prepare() {
    const looked = await resolveTeam(this.summon.teamId);
    // The database wins where it has an answer; the payload fills the gaps.
    // `resolveTeam` returns nulls for a team it could not find, so a plain
    // spread would wipe out the name and description the extension took the
    // trouble to send.
    this.team = {
      ...this.team,
      ...looked,
      ref: this.summon.teamId,
      name: looked.name ?? this.summon.teamName,
      description: looked.description ?? this.summon.teamDescription,
    };
    this.context.teamName = this.team.name;
    this.context.teamDescription = this.team.description;

    if (!this.team.resolved) {
      this.log.warn(
        `team ${this.summon.teamId} is not in Astra's teams table — the meeting ` +
          "will be recorded against team_ref with a null team_id",
      );
    }

    this.meeting = await createMeeting({
      teamId: this.team.id,
      teamRef: this.team.ref,
      meetLink: this.summon.meetLink,
      sessionId: this.id,
    });

    this.log.info(
      `${MARK.db} supabase.meetings ✓ insert #${this.meeting.meeting_number} ` +
        `(${this.meeting.id}) for ${this.team.name ?? this.team.ref}`,
    );
    this.log.info(`meeting #${this.meeting.meeting_number} — ${this.summon.meetLink}`);
    return this.meeting;
  }

  /** Run the meeting. Never rejects — failures land in `this.error`. */
  async run() {
    try {
      await this._join();
      await this._listen();
    } catch (error) {
      this.error = error.message;
      this._setStatus("failed", error.message);
      this.log.error("session failed", error);
      if (this.page) await saveDebugShot(this.page, `failed-${Date.now()}`, this.log);
    } finally {
      await this._teardown();
    }
    return this.describe();
  }

  async _join() {
    this._setStatus("launching");
    const { browser, context } = await launchContext({
      credentials: this.summon.credentials,
      log: this.log,
    });
    this.browser = browser;
    this.page = await context.newPage();

    if (this.summon.credentials.mode === "password") {
      await signInWithPassword(this.page, this.summon.credentials, this.log);
    }

    // Install before navigating: `addInitScript` then covers the reloads Meet
    // performs on the way into a call, so no caption can appear before the
    // observer does.
    await installCaptionObserver(context, this.page, (message) => this._onCaption(message));

    // Check the credential BEFORE opening the meeting. Three seconds here buys
    // an accurate error instead of the whole join timeout spent hunting for a
    // Join button on a sign-in page -- and it means nobody in the room watches a
    // bot appear and vanish.
    if (this.summon.credentials.mode === "storage_state" && config.verifySession) {
      const check = await verifySession(this.page, {
        email: this.summon.credentials.email,
        log: this.log,
      });
      if (!check.ok) await this._handleDeadSession(check.reason, context);
    }

    this._setStatus("joining");
    await this.page.goto(this.summon.meetLink, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(3000);

    // Meet bounces to accounts.google.com when it does not like the session, so
    // the same gate can appear here even after a clean pre-check.
    const gate = await passGoogleGate(this.page, {
      email: this.summon.credentials.email,
      log: this.log,
    });
    if (!gate.ok) {
      await this._handleDeadSession(gate.reason, context);
      await this.page.goto(this.summon.meetLink, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(3000);
    } else if (gate.recovered) {
      // We clicked through a chooser and are now somewhere else entirely.
      await this.page.goto(this.summon.meetLink, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(3000);
    }

    await dismissOverlays(this.page, this.log);

    this.googleAccount = await signedInAccount(this.page);
    if (this.googleAccount) {
      this.joinedAs = "signed_in";
      this.log.info(`signed in as ${this.googleAccount}`);
    } else {
      this.joinedAs = "guest";
      // No session: Meet offers a name box. Filling it is the difference
      // between "Astra Notetaker is asking to join" and an anonymous guest
      // nobody will admit.
      await fillGuestName(this.page, config.displayName, this.log);
    }

    await muteDevices(this.page, this.log);

    if (!(await clickJoin(this.page, this.log))) {
      await saveDebugShot(this.page, `no-join-button-${Date.now()}`, this.log);

      // Before blaming the meeting: is this actually a Google sign-in screen?
      // "No Join button" is what a sign-in page looks like to a Meet selector,
      // and reporting it as a bad link sends people to check the one thing that
      // was never wrong.
      const late = await passGoogleGate(this.page, {
        email: this.summon.credentials.email,
        log: this.log,
      });
      if (!late.ok) throw new Error(late.reason);

      throw new Error(
        "Never found a Join button. The link may be wrong, or the meeting has not started.",
      );
    }

    this._setStatus("waiting_admission");
    const admitted = await waitUntilInCall(this.page, this.log);
    if (!admitted.ok) throw new Error(`Could not get into the call: ${admitted.reason}`);

    this.joinedAt = new Date();
    this._setStatus("in_call");
    await this._markMeetingWrite("joined_at + account", {
      status: "in_call",
      joined_at: this.joinedAt.toISOString(),
      google_account: this.googleAccount,
    });

    // Captions are the whole job. Meet's CC toggle is per-participant, so if the
    // bot cannot switch its own on, nobody else in the room can do it for it and
    // the meeting will produce an empty transcript. That is worth being loud
    // about rather than logging once and transcribing silence for an hour.
    this.captionsEnabled = await enableCaptions(this.page, this.log);
    if (!this.captionsEnabled) {
      this.log.error(
        "COULD NOT TURN CAPTIONS ON — this meeting will produce an empty transcript. " +
          "Meet's CC toggle is per-participant, so nobody else can enable it for the bot.",
      );
      this._say(
        "I could not switch captions on for myself, so I will not be able to " +
          "transcribe or answer questions in this meeting.",
      );
      await this._markMeetingWrite("captions unavailable", {
        error: "Could not enable Google Meet captions; no transcript was possible.",
      });
    }
    // After enabling, not before: the settings panel this opens does not exist
    // until captions are on.
    if (config.captionLanguage) {
      await setCaptionLanguage(this.page, config.captionLanguage, this.log).catch(() => {});
    }
    this._stopWatchdog = startCaptionWatchdog(this.page, this.log);
    this._armCaptionDiagnostics();
    this.detector.start();

    await this._announce();
  }

  /**
   * The saved Google session was refused.
   *
   * Rather than abandon the standup, drop the dead cookies and go back in as a
   * guest: it needs admitting by a human and joins under BOT_DISPLAY_NAME, but
   * it still captions, transcribes and answers. A meeting with a slightly
   * awkward notetaker beats a meeting with none because a cookie went stale
   * overnight.
   *
   * The reason is kept on the session either way, so the popup and the meeting
   * row both say the credential needs renewing rather than leaving someone to
   * discover it again tomorrow.
   */
  async _handleDeadSession(reason, context) {
    this.credentialWarning = reason;
    this.log.error(reason);

    if (!config.allowGuestFallback) {
      throw new Error(reason);
    }

    this.log.warn("falling back to a guest join — the bot will need admitting by hand");
    // The cookies are what Google is refusing; carrying them into the guest
    // attempt just walks back into the same chooser.
    await context.clearCookies().catch(() => {});
    this.joinedAs = "guest";
    this.googleAccount = null;

    await updateMeeting(this.meeting.id, { error: reason }).catch(() => {});
  }

  /**
   * If nothing has been heard after a while, say why — with evidence.
   *
   * A bot that transcribes nothing looks identical whether the room is quiet,
   * captions are off, or Google has rotated its class names again. Only the
   * last of those is a bug, and it is the only one that leaves no trace: the
   * observer runs happily and matches nothing. So once, after a grace period,
   * the caption region is dumped to disk and summarised in the log.
   *
   * Once, not on a timer: a genuinely quiet meeting would otherwise fill the
   * log and the disk with identical dumps.
   */
  _armCaptionDiagnostics() {
    if (!config.debugCaptions) return;
    const timer = setTimeout(async () => {
      if (this._closing || this.counts.finalLines > 0) return;
      this.log.warn(
        `no captions after ${Math.round(config.captionDiagnosticMs / 1000)}s — ` +
          "either the room is silent, captions are off, or the selectors are stale",
      );
      await dumpCaptionDiagnostics(this.page, this.log, { dir: config.dataDir }).catch(
        (error) => this.log.warn(`diagnostics failed: ${error.message}`),
      );
    }, config.captionDiagnosticMs);
    timer.unref?.();
    this._captionDiagTimer = timer;
  }

  /**
   * Post to the meeting chat.
   *
   * The only place anything writes to the chat box, so two messages can never
   * be typed into it at once. Returns the queued promise for callers that want
   * to know it landed; most do not, and must not block on it.
   */
  _say(text, options = {}) {
    this.log.info(`${MARK.chat} ${String(text).replace(/\s+/g, " ")}`);
    this.transcript.push({ at: new Date().toISOString(), kind: "chat", speaker: "Astra", text });
    this._trimTranscript();
    return this.chatQueue.push(
      () => sendAnswer(this.page, text, this.log, options),
      String(text).slice(0, 40),
    );
  }

  /**
   * Say hello in the chat.
   *
   * Not decoration. A bot that transcribes a meeting without telling anyone is
   * a consent problem, and the room has no other way to learn the wake word.
   */
  async _announce() {
    const words = config.wakeWords.slice(0, 2).map((w) => `"${w}"`).join(" or ");
    const line =
      `Astra has joined and is taking notes for ${this.team.name ?? "this team"}. ` +
      `Say ${words} to ask me something; I answer here in the chat.`;
    await this._say(line, { prefix: "🤖 " });
  }

  /** Watch the call until it ends, the room empties, or the ceiling is hit. */
  async _listen() {
    const deadline = Date.now() + config.maxMeetingMs;

    while (!this._closing && Date.now() < deadline) {
      await sleep(5000);
      if (this._closing) break;

      if (!(await callIsAlive(this.page))) {
        this.log.info("the call ended");
        break;
      }

      if (config.aloneLeaveMs > 0) {
        const alone = await isAlone(this.page);
        if (alone === true) {
          this._aloneSince ??= Date.now();
          if (Date.now() - this._aloneSince >= config.aloneLeaveMs) {
            this.log.info("everyone else has left — hanging up");
            break;
          }
        } else if (alone === false) {
          this._aloneSince = null;
        }
        // `null` is unknown: leave the timer where it is rather than resetting
        // it on an unreadable page.
      }
    }

    if (Date.now() >= deadline) {
      this.log.warn(`hit the ${Math.round(config.maxMeetingMs / 60000)}-minute ceiling`);
    }
  }

  // =========================================================================
  // Persistence, and saying so
  // =========================================================================

  /**
   * Queue one transcript row, and mark it in the log on the way in and out.
   *
   * The single place transcript rows are written, which is why the marker can
   * be trusted: if a line appears in the meeting and not here, it was never
   * offered to the database at all.
   *
   * The two markers are deliberately separate events rather than one line after
   * the fact. A caption is *heard* at one moment and *stored* at another — the
   * queue serialises writes, so under load there is real lag between them — and
   * collapsing them would hide exactly the delay you would be debugging.
   */
  _persist({ kind, speaker, content, spokenAt }) {
    const no = ++this._rowNo;

    this.transcript.push({
      n: no,
      at: spokenAt ?? new Date().toISOString(),
      kind,
      speaker: speaker || "Unknown",
      text: content,
    });
    this._trimTranscript();

    if (config.logTranscript) {
      this.log.info(
        `${MARK.caption} #${String(no).padEnd(3)} ${kind.padEnd(8)} ` +
          `${(speaker || "Unknown").padEnd(14)} » ${content}`,
      );
    }

    return this.transcriptQueue.push(async () => {
      const started = Date.now();
      try {
        await insertTranscript({
          meetingId: this.meeting.id,
          speaker,
          content,
          spokenAt: spokenAt ?? new Date().toISOString(),
          kind,
        });
        this.counts.rowsWritten += 1;
        if (config.logDbWrites) {
          this.log.info(
            `${MARK.db} supabase.transcripts ✓ #${no} ${kind} · ${Date.now() - started}ms`,
          );
        }
      } catch (error) {
        this.counts.rowsFailed += 1;
        // Always logged, whatever BOT_LOG_DB says: a silent dropped row is the
        // one failure that leaves no trace anywhere else.
        this.log.error(
          `${MARK.db} supabase.transcripts ✗ #${no} ${kind} — ${error.message}`,
        );
        throw error; // the queue counts it; it does not stall behind it
      }
    }, `#${no} ${kind}`);
  }

  /** Bounded: a four-hour meeting must not grow the process without limit. */
  _trimTranscript() {
    const max = config.transcriptBuffer;
    if (this.transcript.length > max) this.transcript.splice(0, this.transcript.length - max);
  }

  /** Mark a write to the `meetings` row, which is the other thing we persist. */
  async _markMeetingWrite(what, patch) {
    const started = Date.now();
    try {
      await updateMeeting(this.meeting.id, patch);
      if (config.logDbWrites) {
        this.log.info(`${MARK.db} supabase.meetings ✓ ${what} · ${Date.now() - started}ms`);
      }
    } catch (error) {
      this.log.warn(`${MARK.db} supabase.meetings ✗ ${what} — ${error.message}`);
    }
  }

  // =========================================================================
  // Caption pipeline
  // =========================================================================

  _onCaption(message) {
    if (message.type === "delta") {
      this.counts.deltas += 1;
      // Interim text is the proof that somebody is still talking. It is never
      // persisted and never sent to the model — its only job is to hold the
      // five-second silence window open mid-sentence.
      this.detector.activity(message.ts);
      return;
    }

    if (message.type !== "final") return;

    this.counts.finalLines += 1;
    const speaker = message.speaker || "Unknown";
    const text = String(message.text || "").trim();
    if (!text) return;

    // Durable record, strictly in order. The caption is printed here too — see
    // _persist.
    this._persist({
      kind: "speech",
      speaker,
      content: text,
      spokenAt: new Date(message.ts).toISOString(),
    });

    // Wake word / query buffering.
    this.detector.feed({ speaker, text, at: message.ts });
  }

  _onQuery({ query, speaker, reason, confirmed }) {
    this.counts.questions += 1;
    this.log.info(
      `question from ${speaker ?? "someone"} (${reason}` +
        `${confirmed ? ", confirmed" : ""}): "${query}"`,
    );

    // Serialised so two questions in quick succession are answered in the order
    // they were asked, rather than whichever the model finishes first.
    this.answerQueue.push(() => this._answer({ query, speaker }), query.slice(0, 40));
  }

  async _answer({ query, speaker }) {
    // The question itself belongs in the transcript, marked as such, so the
    // record shows what the bot was actually asked.
    this._persist({ kind: "question", speaker: speaker ?? "Unknown", content: query });

    const prompt = assemblePrompt({
      preContext: this.context.preContext,
      history: this.context.history(),
      query,
      speaker,
      teamName: this.team.name,
      teamDescription: this.team.description,
    });

    let answer;
    const askedAt = Date.now();
    try {
      answer = await ask(prompt);
      this.log.info(
        `${MARK.llm} gemini ← ${Date.now() - askedAt}ms · ${config.geminiModel} · ` +
          `prompt ~${Math.ceil(prompt.length / 4)} tokens`,
      );
    } catch (error) {
      // A truncated answer still has most of an answer in it. Posting what
      // there is beats telling the room the bot failed, as long as the cut is
      // marked so nobody quotes half a sentence as if it were the whole one.
      if (error.truncated && error.text) {
        this.log.warn(`answer was truncated: ${error.message}`);
        answer = `${error.text.trim()} […]`;
      } else {
        this.log.error("Gemini call failed", error);
        // Say something. Silence after a wake word is indistinguishable from a
        // crashed bot, and somebody will keep asking. The bot has already
        // greeted them and read the question back, so staying quiet now is the
        // most confusing thing it could do.
        await this._say(
          "I could not reach my model just then, so I have not got an answer for that " +
            "one. The question is in the transcript.",
        );
        return;
      }
    }

    const clean = toPlainText(answer);
    this.counts.answers += 1;

    const sent = await this._say(answer);
    if (!sent) this.counts.chatFailures += 1;

    // State update: this pair is what makes "and what about his PR?" work on
    // the next question.
    this.context.remember({ query, response: clean, speaker });

    this._persist({ kind: "answer", speaker: "Astra", content: clean });
  }

  // =========================================================================
  // Shutdown
  // =========================================================================

  /** Ask the session to wind up. Safe to call twice. */
  stop(reason = "stopped by request") {
    if (this._closing) return;
    this.log.info(reason);
    this._closing = true;
  }

  async _teardown() {
    if (this.status !== "failed") this._setStatus("leaving");

    this.detector.stop();
    this._stopWatchdog?.();
    if (this._captionDiagTimer) clearTimeout(this._captionDiagTimer);

    // Flush before the browser closes, or the last thing anybody said dies with
    // the page.
    if (this.page && !this.page.isClosed()) {
      // Anything still queued for the chat has to be posted while the page is
      // still in the call; after leaveCall there is no chat box to type into.
      await this.chatQueue.drain().catch(() => {});
      await flushCaptions(this.page);
      await sleep(600);
      await leaveCall(this.page, this.log);
    }

    // Drain in this order: an answer still in flight enqueues a chat post and a
    // transcript row of its own, so the queues it feeds have to be drained
    // after it rather than alongside it.
    await this.answerQueue.drain().catch(() => {});
    await this.chatQueue.drain().catch(() => {});
    await this.transcriptQueue.drain().catch(() => {});

    const summary = await this._summarise().catch((error) => {
      this.log.warn("could not summarise the meeting", error.message);
      return null;
    });

    this.endedAt = new Date();
    if (this.meeting) {
      await updateMeeting(this.meeting.id, {
        status: this.status === "failed" ? "failed" : "ended",
        ended_at: this.endedAt.toISOString(),
        summary,
        error: this.error,
        transcript_lines: this.counts.finalLines,
        questions_answered: this.counts.answers,
      }).catch((error) => this.log.warn("could not close the meeting row", error.message));
    }

    try {
      await this.browser?.close();
    } catch {
      /* already gone */
    }

    if (this.status !== "failed") this._setStatus("ended");
    this.log.info(
      `${MARK.db} supabase totals: ${this.counts.rowsWritten} row(s) written, ` +
        `${this.counts.rowsFailed} failed · meeting ${this.meeting?.id ?? "—"}`,
    );
    this.log.info(
      `done — ${this.counts.finalLines} caption line(s), ` +
        `${this.counts.questions} question(s), ${this.counts.answers} answer(s)`,
    );
  }

  /**
   * A one-paragraph summary for `meetings.summary`.
   *
   * Built from the in-memory Q&A window, not from the transcripts table — the
   * no-reads rule holds right to the end. That means it summarises what the bot
   * was *asked*, which is the useful part; the full record is in `transcripts`.
   */
  async _summarise() {
    if (!this.context.size) return null;
    const transcriptOfQuestions = this.context.turns
      .map((turn, i) => `${i + 1}. Q: ${turn.query}\n   A: ${turn.response}`)
      .join("\n");

    const prompt =
      `Write a 2-3 sentence summary of this meeting for a sprint log. Plain prose, ` +
      `no markdown, no preamble.\n\nTeam: ${this.team.name ?? this.team.ref}\n\n` +
      `Questions asked of the assistant and its answers:\n${transcriptOfQuestions}`;

    const summary = await ask(prompt);
    return toPlainText(summary).slice(0, 4000);
  }
}

// ===========================================================================
// The registry
// ===========================================================================

/**
 * Live sessions, in module scope.
 *
 * In-memory is right here: a session owns a browser process belonging to *this*
 * container, so a session that outlived a restart would be a session whose
 * browser nobody can find. A restart loses the job; the meeting row on Supabase
 * stays as the record of what happened.
 */
const sessions = new Map();

export function registerSession(session) {
  sessions.set(session.id, session);
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}

/** The session objects themselves, oldest first. For the transcript endpoint. */
export function allSessions() {
  return [...sessions.values()];
}

export function listSessions() {
  return [...sessions.values()].map((session) => session.describe());
}

export function activeCount() {
  return [...sessions.values()].filter(
    (s) => !["ended", "failed"].includes(s.status),
  ).length;
}

/** Drop finished sessions so a long-lived container does not grow forever. */
export function reapSessions({ keepMs = 30 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - keepMs;
  for (const [id, session] of sessions) {
    if (session.endedAt && session.endedAt.getTime() < cutoff) sessions.delete(id);
  }
}

export async function stopAll(reason) {
  for (const session of sessions.values()) session.stop(reason);
}
