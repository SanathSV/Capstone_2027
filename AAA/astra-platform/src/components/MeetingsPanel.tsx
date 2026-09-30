"use client";

import { useCallback, useEffect, useState } from "react";
import { Drawer } from "./Drawer";
import type { Meeting, MeetingDetail, TranscriptKind } from "@/lib/db/types";

/**
 * The team's meeting history, and the transcript of any one of them.
 *
 * Two loads rather than one: the list arrives with the page, and a transcript
 * is fetched only when a meeting is opened. A team with fifty standups behind
 * it has tens of thousands of transcript rows, and shipping all of them to
 * render a list of dates would be absurd — the list needs a number and a
 * timestamp, and the row already carries both.
 */
export function MeetingsPanel({ meetings }: { meetings: Meeting[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (meetings.length === 0) {
    return (
      <section className="card p-6">
        <PanelHeading count={0} />
        <p className="mt-3 text-[13px] leading-relaxed text-slate-400">
          No meetings yet. Summon the bot into a Google Meet from the Astra Chrome
          extension and the transcript will appear here once it has been in the call.
        </p>
      </section>
    );
  }

  return (
    <section className="card overflow-hidden">
      <div className="px-6 pt-6">
        <PanelHeading count={meetings.length} />
      </div>

      <ul className="mt-4 divide-y divide-ink-600/60">
        {meetings.map((meeting) => (
          <li key={meeting.id}>
            <button
              type="button"
              onClick={() => setOpenId(meeting.id)}
              className="flex w-full items-center gap-4 px-6 py-3.5 text-left transition
                         duration-200 ease-emphasized hover:bg-ink-800/60"
            >
              <span
                aria-hidden="true"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink-700
                           text-xs font-semibold tabular-nums text-slate-300"
              >
                #{meeting.meeting_number}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">
                    {formatWhen(meeting.joined_at ?? meeting.created_at)}
                  </span>
                  <StatusChip meeting={meeting} />
                </span>
                <span className="mt-0.5 block truncate text-xs text-slate-400">
                  {meeting.summary ??
                    meeting.error ??
                    (isLive(meeting)
                      ? "In progress — the bot is still in this call"
                      : `${meeting.transcript_lines} line${meeting.transcript_lines === 1 ? "" : "s"} recorded`)}
                </span>
              </span>

              <span className="hidden shrink-0 items-center gap-4 text-xs tabular-nums text-slate-400 sm:flex">
                <Stat value={isLive(meeting) ? null : meeting.transcript_lines} label="lines" />
                <Stat value={isLive(meeting) ? null : meeting.questions_answered} label="asked" />
                <span>{formatDuration(meeting)}</span>
              </span>

              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-slate-500"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      {openId && <TranscriptDrawer meetingId={openId} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function PanelHeading({ count }: { count: number }) {
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-medium text-slate-100">Meetings</h2>
        {count > 0 && (
          <span className="grid h-6 min-w-6 place-items-center rounded-full bg-ink-700 px-2 text-[11px] font-medium tabular-nums text-slate-300">
            {count}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-slate-500">
        Every call the bot has sat in. Open one to read what was said.
      </p>
    </div>
  );
}

/** A meeting the bot has not finished yet: its counters are not written. */
function isLive(meeting: Meeting) {
  return meeting.status !== "ended" && meeting.status !== "failed";
}

function Stat({ value, label }: { value: number | null; label: string }) {
  return (
    <span className="text-right">
      <span className="block font-medium text-slate-300">{value ?? "—"}</span>
      <span className="block text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </span>
  );
}

function StatusChip({ meeting }: { meeting: Meeting }) {
  if (meeting.status === "ended") {
    return (
      <span className="chip border-signal-green/25 bg-signal-green/10 py-0.5 text-[10px] text-signal-green">
        Completed
      </span>
    );
  }
  if (meeting.status === "failed") {
    return (
      <span className="chip border-signal-red/25 bg-signal-red/10 py-0.5 text-[10px] text-signal-red">
        Failed
      </span>
    );
  }
  // Anything else means the bot is still in there — or the container died
  // mid-meeting and never got to write a closing status, which looks the same
  // from here and is worth not claiming otherwise about.
  return (
    <span className="chip border-astra-300/25 bg-astra-500/15 py-0.5 text-[10px] text-astra-300">
      {meeting.status.replace(/_/g, " ")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

function TranscriptDrawer({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
      setDetail(body as MeetingDetail);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [meetingId]);

  useEffect(() => {
    void load();
  }, [load]);

  const meeting = detail?.meeting;

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-3xl"
      title={meeting ? `Meeting #${meeting.meeting_number}` : "Meeting"}
      subtitle={meeting ? formatWhen(meeting.joined_at ?? meeting.created_at) : "Loading…"}
      headerExtra={
        detail && (
          <button
            type="button"
            onClick={() => copyTranscript(detail)}
            className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
          >
            Copy
          </button>
        )
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <p className="rounded-xl border border-signal-red/30 bg-signal-red/10 px-4 py-3 text-sm text-signal-red">
            {error}
          </p>
        )}

        {!detail && !error && <TranscriptSkeleton />}

        {meeting && (
          <>
            <MeetingMeta meeting={meeting} lineCount={detail!.transcript.length} />

            {detail!.transcript.length === 0 ? (
              <p className="mt-6 rounded-xl border border-dashed border-ink-600 px-4 py-8 text-center text-[13px] text-slate-400">
                {meeting.status === "failed"
                  ? "Nothing was recorded — the bot never got into the call."
                  : "Nothing was recorded. Either the room was silent, or captions were never switched on for the bot."}
              </p>
            ) : (
              <ol className="mt-6 space-y-4">
                {detail!.transcript.map((line, index, all) => {
                  // Only label a speaker when they change. A standup where one
                  // person talks for two minutes produces twenty rows, and
                  // repeating their name on every one turns a conversation into
                  // a form.
                  const newSpeaker =
                    index === 0 ||
                    all[index - 1].speaker_name !== line.speaker_name ||
                    all[index - 1].kind !== line.kind;

                  return (
                    <li key={line.id} className={newSpeaker ? "" : "-mt-2.5"}>
                      {newSpeaker && (
                        <div className="mb-1 flex items-baseline gap-2">
                          <span
                            className={`text-xs font-medium ${
                              line.kind === "answer" ? "text-astra-300" : "text-slate-300"
                            }`}
                          >
                            {line.speaker_name}
                          </span>
                          <KindTag kind={line.kind} />
                          <span className="text-[10px] tabular-nums text-slate-600">
                            {new Date(line.spoken_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })}
                          </span>
                        </div>
                      )}
                      <p
                        className={`text-[13px] leading-relaxed ${
                          line.kind === "answer"
                            ? "rounded-xl border border-astra-300/20 bg-astra-500/10 px-3 py-2 text-slate-200"
                            : line.kind === "question"
                              ? "text-slate-200"
                              : "text-slate-300"
                        }`}
                      >
                        {line.content}
                      </p>
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

function MeetingMeta({ meeting, lineCount }: { meeting: Meeting; lineCount: number }) {
  // `transcript_lines` is written by the container on teardown, so it is still
  // 0 for a meeting that is happening right now — while the rows themselves are
  // already in the table. Reporting the stored counter beside a visible
  // transcript reads as a bug. The number of lines actually loaded is the one
  // true statement available here.
  const lines = Math.max(meeting.transcript_lines, lineCount);

  const rows: [string, React.ReactNode][] = [
    ["Status", <StatusChip key="s" meeting={meeting} />],
    ["Joined", meeting.joined_at ? formatWhen(meeting.joined_at) : "—"],
    ["Ended", meeting.ended_at ? formatWhen(meeting.ended_at) : "—"],
    ["Duration", formatDuration(meeting)],
    ["Lines", String(lines)],
    ["Questions answered", String(meeting.questions_answered)],
    ["Bot account", meeting.google_account ?? "joined as a guest"],
    [
      "Meet link",
      <a
        key="l"
        href={meeting.meet_link}
        target="_blank"
        rel="noreferrer"
        className="mono text-astra-300 underline-offset-2 hover:underline"
      >
        {meeting.meet_link.replace("https://", "")}
      </a>,
    ],
  ];

  return (
    <div className="space-y-4">
      {meeting.summary && (
        <div className="rounded-xl border border-ink-600/70 bg-ink-800/60 p-4">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Summary
          </p>
          <p className="text-[13px] leading-relaxed text-slate-200">{meeting.summary}</p>
        </div>
      )}

      {meeting.error && (
        <p className="rounded-xl border border-signal-amber/30 bg-signal-amber/10 px-4 py-3 text-[13px] leading-relaxed text-signal-amber">
          {meeting.error}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-xs sm:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-slate-500">{label}</dt>
            <dd className="mt-0.5 truncate text-slate-300">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function KindTag({ kind }: { kind: TranscriptKind }) {
  if (kind === "speech") return null;
  const look: Record<string, string> = {
    question: "border-ink-600 bg-ink-700 text-slate-400",
    answer: "border-astra-300/25 bg-astra-500/15 text-astra-300",
    system: "border-ink-600 bg-ink-700 text-slate-400",
  };
  return (
    <span className={`chip py-0 text-[9px] uppercase tracking-wide ${look[kind] ?? ""}`}>
      {kind}
    </span>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="shimmer h-4 rounded bg-ink-800" style={{ width: `${55 + ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function copyTranscript(detail: MeetingDetail) {
  const { meeting, transcript } = detail;
  const text = [
    `Meeting #${meeting.meeting_number} — ${formatWhen(meeting.joined_at ?? meeting.created_at)}`,
    meeting.meet_link,
    meeting.summary ? `\nSummary: ${meeting.summary}` : "",
    "",
    ...transcript.map(
      (line) =>
        `[${new Date(line.spoken_at).toLocaleTimeString()}] ${line.speaker_name}` +
        `${line.kind === "speech" ? "" : ` (${line.kind})`}: ${line.content}`,
    ),
  ].join("\n");
  void navigator.clipboard?.writeText(text);
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(meeting: Meeting) {
  if (!meeting.joined_at || !meeting.ended_at) return "—";
  const ms = new Date(meeting.ended_at).getTime() - new Date(meeting.joined_at).getTime();
  if (ms < 0) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
