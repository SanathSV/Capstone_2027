"use client";

import { useMemo, useState } from "react";
import { CheckSquare, FileText, Zap } from "lucide-react";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { sessions, type MeetingSession, type SessionStatus } from "@/lib/mock-data";
import { cn, formatDuration, formatNumber, formatTimestamp } from "@/lib/utils";

const statusTone: Record<SessionStatus, BadgeTone> = {
  live: "active",
  processing: "indigo",
  completed: "neutral",
  failed: "danger",
};

const statusLabel: Record<SessionStatus, string> = {
  live: "Live",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

type Filter = "all" | "live" | "completed";

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "live", label: "Active" },
  { id: "completed", label: "Past" },
];

function matches(session: MeetingSession, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "live") return session.status === "live" || session.status === "processing";
  return session.status === "completed" || session.status === "failed";
}

export function SessionTable() {
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(
    () => sessions.filter((session) => matches(session, filter)),
    [filter],
  );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Meeting sessions</CardTitle>
          <CardDescription>
            Every call the bot has joined, with what it extracted from each one.
          </CardDescription>
        </div>

        <div
          role="tablist"
          aria-label="Filter sessions"
          className="flex items-center gap-1 rounded-lg border border-slate-800/80 bg-slate-950/60 p-1"
        >
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                filter === item.id
                  ? "bg-slate-800 text-white"
                  : "text-slate-500 hover:text-slate-300",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </CardHeader>

      <Table className="min-w-[860px]">
        <TableHead>
          <TableRow className="hover:bg-transparent">
            <TableHeaderCell>Meeting</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Started</TableHeaderCell>
            <TableHeaderCell className="text-right">Duration</TableHeaderCell>
            <TableHeaderCell className="text-right">Transcript</TableHeaderCell>
            <TableHeaderCell className="text-right">Triggers</TableHeaderCell>
            <TableHeaderCell className="text-right">Action items</TableHeaderCell>
          </TableRow>
        </TableHead>

        <TableBody>
          {rows.map((session) => (
            <TableRow key={session.id}>
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-white">{session.title}</span>
                  <span className="font-mono text-[11px] text-slate-600">
                    {session.meetingCode} · {session.participants} participants
                  </span>
                </div>
              </TableCell>

              <TableCell>
                <Badge tone={statusTone[session.status]} dot={session.status === "live"}>
                  {statusLabel[session.status]}
                </Badge>
              </TableCell>

              <TableCell className="whitespace-nowrap text-xs text-slate-500">
                {formatTimestamp(session.startedAt)}
              </TableCell>

              <TableCell className="text-right text-xs tabular-nums text-slate-400">
                {formatDuration(session.durationMinutes)}
              </TableCell>

              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-slate-400">
                  <FileText className="h-3.5 w-3.5 text-slate-600" aria-hidden />
                  {formatNumber(session.transcriptWords)} words
                </span>
              </TableCell>

              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-slate-400">
                  <Zap className="h-3.5 w-3.5 text-indigo" aria-hidden />
                  {session.triggers}
                </span>
              </TableCell>

              <TableCell className="text-right">
                <span className="inline-flex items-center gap-1.5 text-xs tabular-nums text-slate-400">
                  <CheckSquare className="h-3.5 w-3.5 text-emerald" aria-hidden />
                  {session.actionItems}
                </span>
              </TableCell>
            </TableRow>
          ))}

          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-600">
                No sessions match this filter.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </Card>
  );
}
