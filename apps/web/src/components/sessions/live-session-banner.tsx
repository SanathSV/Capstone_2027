import { Radio, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { MeetingSession } from "@/lib/mock-data";
import { formatDuration, formatNumber } from "@/lib/utils";

/** Highlights the call currently being captured, above the session table. */
export function LiveSessionBanner({ session }: { session: MeetingSession }) {
  return (
    <Card className="relative overflow-hidden border-emerald/20 p-6">
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald/10 via-transparent to-transparent"
        aria-hidden
      />
      <div className="relative flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-start gap-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-emerald/30 bg-emerald/10">
            <Radio className="h-4 w-4 text-emerald" aria-hidden />
          </span>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold tracking-tight text-white">
                {session.title}
              </h2>
              <Badge tone="active" dot>
                Capturing
              </Badge>
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-slate-500">
              <span>{session.meetingCode}</span>
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden />
                {session.participants}
              </span>
              <span>{formatDuration(session.durationMinutes)} elapsed</span>
            </p>
          </div>
        </div>

        <dl className="flex items-center gap-8">
          <LiveStat label="Transcript" value={`${formatNumber(session.transcriptWords)} words`} />
          <LiveStat label="Triggers" value={String(session.triggers)} />
          <LiveStat label="Action items" value={String(session.actionItems)} />
        </dl>
      </div>
    </Card>
  );
}

function LiveStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[11px] uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-slate-200">{value}</dd>
    </div>
  );
}
