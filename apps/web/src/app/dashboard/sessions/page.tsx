import { CheckSquare, FileText, Radio, Zap } from "lucide-react";

import { PageHeading } from "@/components/dashboard/page-heading";
import { LiveSessionBanner } from "@/components/sessions/live-session-banner";
import { SessionTable } from "@/components/sessions/session-table";
import { StatTile } from "@/components/sessions/stat-tile";
import { sessions } from "@/lib/mock-data";
import { formatNumber } from "@/lib/utils";

export const metadata = { title: "Sessions · Astra" };

export default function SessionsPage() {
  const liveSession = sessions.find((session) => session.status === "live");
  const liveCount = sessions.filter((session) => session.status === "live").length;
  const totalWords = sessions.reduce((sum, session) => sum + session.transcriptWords, 0);
  const totalTriggers = sessions.reduce((sum, session) => sum + session.triggers, 0);
  const totalActionItems = sessions.reduce((sum, session) => sum + session.actionItems, 0);

  return (
    <>
      <PageHeading
        title="Live session monitor"
        description="What the bot is capturing right now, and everything it has processed so far."
      />

      <div className="flex flex-col gap-6">
        {liveSession ? <LiveSessionBanner session={liveSession} /> : null}

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Active calls"
            value={String(liveCount)}
            hint="Sessions the bot is currently attending."
            icon={Radio}
            emphasis={liveCount > 0}
          />
          <StatTile
            label="Transcript volume"
            value={formatNumber(totalWords)}
            hint="Words captured across all sessions."
            icon={FileText}
          />
          <StatTile
            label="Triggers detected"
            value={String(totalTriggers)}
            hint="Phrases that matched an automation rule."
            icon={Zap}
          />
          <StatTile
            label="Action items"
            value={String(totalActionItems)}
            hint="Items extracted and queued for Jira."
            icon={CheckSquare}
          />
        </div>

        <SessionTable />
      </div>
    </>
  );
}
