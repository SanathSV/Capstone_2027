"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Drawer } from "./Drawer";

/**
 * Ask Astra about a team, in a side panel.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PROVIDER RATHER THAN A COMPONENT PER CARD
 * ---------------------------------------------------------------------------
 * The chat button lives on every team card, and on the team page. If each of
 * those rendered its own panel, the dashboard would mount one chat per team —
 * each with its own conversation, none of which survives navigating away, and
 * all of them stacked in the DOM. One panel, mounted once in the app shell,
 * with a team id passed to it: switching teams is then a state change rather
 * than a remount, which is exactly what makes the switcher inside the panel
 * possible at all.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CONVERSATION LIVES
 * ---------------------------------------------------------------------------
 * Here, in component state, keyed by team. Not on the server: a chat panel is
 * opened, abandoned and reopened constantly, and a server that remembered
 * conversations would need eviction, a store, and an answer for two tabs
 * disagreeing. The whole history is re-sent with each question — a couple of
 * thousand tokens against a context that is cached for half an hour anyway.
 *
 * Keeping it per-team matters: switching from one team to another and back
 * should not hand you somebody else's conversation, and it should not throw
 * away the one you were having.
 */

export interface ChatTeam {
  id: string;
  name: string;
  i_lead: boolean;
}

interface Message {
  role: "user" | "model";
  text: string;
  /** Set on a failed turn so it can be shown differently and retried. */
  failed?: boolean;
}

interface ChatState {
  open: (teamId?: string) => void;
  /** False when the shell has no teams to talk about — the button hides. */
  available: boolean;
  /** Astra is scoped to teams you LEAD; a member's card gets no button. */
  canAsk: (teamId?: string) => boolean;
}

const Ctx = createContext<ChatState>({
  open: () => {},
  available: false,
  canAsk: () => false,
});

export function useTeamChat() {
  return useContext(Ctx);
}

export function TeamChatProvider({
  teams,
  children,
}: {
  teams: ChatTeam[];
  children: React.ReactNode;
}) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  // Per team, so switching away and back does not lose the thread.
  const [threads, setThreads] = useState<Record<string, Message[]>>({});

  /**
   * Open the panel, defaulting to the team you are looking at.
   *
   * The header button passes no id, and falling back to `teams[0]` made it
   * arbitrary: standing on a team page and pressing "Ask Astra" would open a
   * conversation about a completely different team, which is both confusing and
   * — if that other team has no pre-context — an error for no reason. Reading
   * the id out of the URL costs nothing and makes the button mean what it
   * looks like it means.
   */
  const open = useCallback(
    (teamId?: string) => {
      if (teamId) return setOpenFor(teamId);
      const fromUrl = window.location.pathname.match(
        /\/teams\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      )?.[1];
      const onThisPage = fromUrl && teams.some((t) => t.id === fromUrl) ? fromUrl : null;
      setOpenFor(onThisPage ?? teams[0]?.id ?? null);
    },
    [teams],
  );

  const value = useMemo(
    () => ({
      open,
      available: teams.length > 0,
      // No id means the header button, which needs only *a* team.
      canAsk: (teamId?: string) =>
        teamId ? teams.some((t) => t.id === teamId) : teams.length > 0,
    }),
    [open, teams],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {openFor && (
        <ChatPanel
          teams={teams}
          teamId={openFor}
          onTeamChange={setOpenFor}
          onClose={() => setOpenFor(null)}
          threads={threads}
          setThreads={setThreads}
        />
      )}
    </Ctx.Provider>
  );
}

function ChatPanel({
  teams,
  teamId,
  onTeamChange,
  onClose,
  threads,
  setThreads,
}: {
  teams: ChatTeam[];
  teamId: string;
  onTeamChange: (id: string) => void;
  onClose: () => void;
  threads: Record<string, Message[]>;
  setThreads: React.Dispatch<React.SetStateAction<Record<string, Message[]>>>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const team = teams.find((t) => t.id === teamId);
  const messages = threads[teamId] ?? [];

  // Follow the conversation down as it grows. `behavior: smooth` only after the
  // first paint, so opening a panel with history does not animate a scroll the
  // user did not ask for.
  const firstRender = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: firstRender.current ? "auto" : "smooth" });
    firstRender.current = false;
  }, [messages.length, busy, teamId]);

  useEffect(() => {
    setError(null);
    setContextNote(null);
    firstRender.current = true;
  }, [teamId]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;

    const history = messages.filter((m) => !m.failed);
    setThreads((prev) => ({ ...prev, [teamId]: [...history, { role: "user", text }] }));
    setDraft("");
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team_id: teamId,
          message: text,
          history: history.map((m) => ({ role: m.role, text: m.text })),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);

      setThreads((prev) => ({
        ...prev,
        [teamId]: [...(prev[teamId] ?? []), { role: "model", text: body.answer as string }],
      }));

      const age = body.context?.age_seconds as number | undefined;
      const stale = body.context?.stale === true;
      setContextNote(
        body.context?.source === "generated"
          ? "Context harvested just now"
          : age == null
            ? null
            : // `stale` means we could not refresh — almost always because only
              // the leader may harvest. Saying so is the difference between an
              // answer you can weigh and one you have to guess about.
              `Context from ${describeAge(age)}${stale ? " · only the leader can refresh it" : ""}`,
      );
    } catch (caught) {
      setError((caught as Error).message);
      // Mark the question as failed rather than dropping it: the text is still
      // on screen, and Retry re-sends exactly it.
      setThreads((prev) => {
        const thread = [...(prev[teamId] ?? [])];
        const last = thread[thread.length - 1];
        if (last?.role === "user") thread[thread.length - 1] = { ...last, failed: true };
        return { ...prev, [teamId]: thread };
      });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-xl"
      title="Ask Astra"
      subtitle={contextNote ?? `About ${team?.name ?? "a team"} — it has the sprint context.`}
      headerExtra={
        // The switcher lives in the header rather than as a row of tabs: teams
        // can be numerous, and a select degrades to a scroll list where tabs
        // would wrap and push the conversation down the panel.
        <select
          value={teamId}
          onChange={(event) => onTeamChange(event.target.value)}
          aria-label="Team"
          className="input h-9 shrink-0 !w-auto max-w-[11rem] py-0 pr-8 text-xs"
        >
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      }
    >
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <ContextDisclosure teamId={teamId} teamName={team?.name} />

        {messages.length === 0 && !busy && (
          <Suggestions teamName={team?.name} onPick={(q) => void send(q)} />
        )}

        {messages.map((message, index) => (
          <Bubble key={index} message={message} />
        ))}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-astra-300"
                  style={{ animationDelay: `${i * 140}ms` }}
                />
              ))}
            </span>
            Thinking…
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-signal-red/30 bg-signal-red/10 px-4 py-3 text-xs text-signal-red">
            <p className="leading-relaxed">{error}</p>
            <button
              type="button"
              onClick={() => {
                const lastUser = [...messages].reverse().find((m) => m.role === "user");
                if (lastUser) void send(lastUser.text);
              }}
              className="mt-2 font-medium underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
        className="shrink-0 border-t border-ink-600/70 p-4"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // chat input has, and the one people's fingers already know.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            placeholder={`Ask about ${team?.name ?? "this team"}…`}
            className="input max-h-32 min-h-[2.75rem] flex-1 resize-none py-3"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="btn-primary h-11 w-11 shrink-0 !px-0"
          >
            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
          Answers come from this team&rsquo;s live sprint context — GitHub, Jira and the
          roster. Astra can still be wrong; check anything you are about to act on.
        </p>
      </form>
    </Drawer>
  );
}

/**
 * The briefing itself, cached per team for the life of the TAB.
 *
 * ---------------------------------------------------------------------------
 * WHY sessionStorage, AND WHY IT DOES NOT FEED THE MODEL
 * ---------------------------------------------------------------------------
 * This exists so the leader can *see* what Astra is working from — "does it
 * actually know about the auth PR?" is the first question anybody asks of an
 * assistant that gets something wrong, and it should not cost a round trip
 * every time the panel is opened.
 *
 * What it deliberately does NOT do is travel back up with the question. The
 * server assembles the briefing itself from the stored run; if the client sent
 * its copy, the model would be grounded in whatever the browser said, which is
 * both an integrity hole and an audit one. The saving people expect from a
 * client cache — not re-reading Supabase on every message — is real, and is
 * taken server-side in `chatContext.ts` instead, where it benefits everyone
 * rather than one tab.
 *
 * `sessionStorage`, not `localStorage`: this is commit messages, issue titles
 * and people's names. It should die with the tab rather than sit on the disk of
 * a shared machine until someone clears their browser.
 */
const CTX_KEY = (teamId: string) => `astra.ctx.${teamId}`;

interface CachedContext {
  markdown: string;
  generatedAt: string | null;
  fetchedAt: number;
}

function readCachedContext(teamId: string): CachedContext | null {
  try {
    const raw = sessionStorage.getItem(CTX_KEY(teamId));
    return raw ? (JSON.parse(raw) as CachedContext) : null;
  } catch {
    // Private windows and storage-blocking extensions both throw on access
    // rather than returning null. A missing cache is never fatal here.
    return null;
  }
}

function writeCachedContext(teamId: string, value: CachedContext) {
  try {
    sessionStorage.setItem(CTX_KEY(teamId), JSON.stringify(value));
  } catch {
    /* quota, or storage disabled — the panel simply fetches again next time */
  }
}

/** What Astra is working from, collapsed by default. */
function ContextDisclosure({ teamId, teamName }: { teamId: string; teamName?: string }) {
  const [cached, setCached] = useState<CachedContext | null>(null);
  const [openBody, setOpenBody] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        // chat-context, not precontext: the latter re-harvests anything older
        // than ten minutes, so merely opening this panel would fire a
        // three-API run. This returns the same bytes the last answer used.
        const response = await fetch(
          `/api/teams/${teamId}/chat-context${refresh ? "?refresh=1" : ""}`,
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? String(response.status));
        const value: CachedContext = {
          markdown: (body.markdown as string) ?? "",
          generatedAt: (body.generated_at as string) ?? null,
          fetchedAt: Date.now(),
        };
        writeCachedContext(teamId, value);
        setCached(value);
      } catch {
        // Not worth an error state: this panel is a convenience, and the chat
        // itself works whether or not the briefing can be displayed.
      } finally {
        setLoading(false);
      }
    },
    [teamId],
  );

  // Cache first, network only if there is nothing to show. This is the
  // "if it is not in the browser then poll" part, and it is why reopening the
  // panel for a team you have already asked about costs nothing.
  useEffect(() => {
    const hit = readCachedContext(teamId);
    setCached(hit);
    setOpenBody(false);
    if (!hit) void load();
  }, [teamId, load]);

  if (!cached && !loading) return null;

  const tokens = cached ? Math.ceil(cached.markdown.length / 4) : 0;

  return (
    <div className="rounded-xl border border-ink-600/70 bg-ink-800/50">
      <button
        type="button"
        onClick={() => setOpenBody((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[11px] text-slate-400
                   transition duration-200 ease-emphasized hover:text-slate-200"
      >
        <svg
          viewBox="0 0 24 24"
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${openBody ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="flex-1">
          {loading && !cached
            ? "Loading what Astra knows…"
            : `What Astra knows about ${teamName ?? "this team"}`}
        </span>
        {cached && (
          <span className="shrink-0 tabular-nums text-slate-500">
            ~{tokens} tokens
            {cached.generatedAt
              ? ` · ${describeAge(Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 1000))}`
              : ""}
          </span>
        )}
      </button>

      {openBody && cached && (
        <div className="border-t border-ink-600/70 px-3.5 py-3">
          <pre className="mono max-h-64 overflow-auto whitespace-pre-wrap break-words text-slate-400">
            {cached.markdown || "(empty)"}
          </pre>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={loading}
            className="mt-2 text-[11px] font-medium text-astra-300 underline-offset-2
                       hover:underline disabled:opacity-50"
          >
            {loading ? "Harvesting…" : "Re-harvest from GitHub and Jira"}
          </button>
        </div>
      )}
    </div>
  );
}

function describeAge(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function Bubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p
          className={`max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md px-4 py-2.5 text-[13px] leading-relaxed ${
            message.failed
              ? "bg-ink-800 text-slate-500 line-through decoration-slate-600"
              : "bg-astra-500 text-white"
          }`}
        >
          {message.text}
        </p>
      </div>
    );
  }

  return (
    // data-astra-role, not a Tailwind class, is what tests select on: the
    // classes here are presentation and will change with the next design pass,
    // and a test coupled to `gap-2.5` fails for reasons that say nothing about
    // whether the chat works.
    <div data-astra-role="answer" className="flex gap-2.5">
      <span
        aria-hidden="true"
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-astra-500/15 ring-1 ring-inset ring-astra-300/25"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4 text-astra-300" fill="currentColor">
          <path d="M12 2 14.4 9.6 22 12 14.4 14.4 12 22 9.6 14.4 2 12 9.6 9.6Z" />
        </svg>
      </span>
      <div data-astra-role="answer-text" className="min-w-0 flex-1 text-[13px] leading-relaxed text-slate-200">
        <Markdown text={message.text} />
      </div>
    </div>
  );
}

/**
 * Just enough Markdown for what the model is told it may use.
 *
 * A parser library for **bold**, `code` and "- " bullets would be several
 * hundred kilobytes to render three constructs. The system instruction rules
 * out headings, tables and fenced code, so this handles what is left — and text
 * that slips through unmatched renders as itself rather than disappearing,
 * which is the right failure for a chat panel.
 */
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);

  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const isList = lines.every((line) => /^\s*[-*•]\s+/.test(line));

        if (isList) {
          return (
            <ul key={bi} className={`space-y-1 ${bi > 0 ? "mt-2" : ""}`}>
              {lines.map((line, li) => (
                <li key={li} className="flex gap-2">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-500" />
                  <span>{inline(line.replace(/^\s*[-*•]\s+/, ""))}</span>
                </li>
              ))}
            </ul>
          );
        }

        return (
          <p key={bi} className={bi > 0 ? "mt-2" : ""}>
            {lines.map((line, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {inline(line)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}

function inline(text: string): React.ReactNode[] {
  // One pass, one regex: **bold** or `code`. Splitting on a capturing group
  // keeps the delimiters in the array, so the odd indices are the matches.
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={i} className="rounded bg-ink-700 px-1 py-0.5 font-mono text-[11.5px] text-slate-200">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function Suggestions({
  teamName,
  onPick,
}: {
  teamName?: string;
  onPick: (question: string) => void;
}) {
  const questions = [
    "What happened this sprint?",
    "Who has the most commits, and is anyone inactive?",
    "What is still unmerged or waiting for review?",
    "Is anyone blocked?",
  ];

  return (
    <div className="py-4">
      <p className="text-[13px] leading-relaxed text-slate-400">
        Ask me anything about <span className="text-slate-200">{teamName ?? "this team"}</span>.
        I have the same sprint context the meeting bot is briefed with — repositories,
        branches, pull requests, Jira issues and who holds which handle.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {questions.map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => onPick(question)}
            className="chip transition duration-200 ease-emphasized hover:border-astra-300/40 hover:bg-astra-500/15 hover:text-astra-300"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The button that opens the panel. Small enough to sit on a team card. */
export function ChatButton({
  teamId,
  className = "",
  label,
}: {
  teamId?: string;
  className?: string;
  label?: string;
}) {
  const { open, canAsk } = useTeamChat();
  // Hidden rather than disabled on a team you only belong to. A disabled
  // control invites "why?" and there is no answer the person can act on — they
  // cannot make themselves the leader.
  if (!canAsk(teamId)) return null;

  return (
    <button
      type="button"
      title="Ask Astra about this team"
      onClick={(event) => {
        // On a team CARD the whole tile is a link; without this, asking a
        // question would also navigate away from the answer.
        event.preventDefault();
        event.stopPropagation();
        open(teamId);
      }}
      className={
        className ||
        `inline-flex items-center gap-1.5 rounded-full border border-ink-600 px-3 py-1 text-xs
         font-medium text-slate-400 transition duration-200 ease-emphasized
         hover:border-astra-300/40 hover:bg-astra-500/15 hover:text-astra-300`
      }
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.9">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.2-.6L3 21l1.8-5.2A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5Z" strokeLinejoin="round" />
      </svg>
      {label ?? "Ask"}
    </button>
  );
}
