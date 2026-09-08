import { redirect } from "next/navigation";
import { BotAuthPanel } from "@/components/BotAuthPanel";
import { getMyProfile } from "@/lib/db/queries";
import { createSupabaseServerClient, getSessionUser } from "@/lib/supabase/server";
import { publishBotStatus } from "@/lib/botStatusPublish";
import { leaderPaths, localBotAuthEnabled } from "@/lib/botAuth";
import { describeRun, getRun } from "@/lib/botAuth";

/**
 * Profile and settings, which for now means one thing: the bot account.
 *
 * The status is read on the server so the page arrives correct rather than
 * flashing "Not Authenticated" while a fetch resolves.
 */

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Publishing here, not just reading, is what keeps the team-page badges
  // honest: this page is the only place the leader's own machine reliably
  // reports in, so it is where the database learns what is on disk.
  const [profile, status] = await Promise.all([
    getMyProfile(user.id),
    publishBotStatus(createSupabaseServerClient(), user.id),
  ]);

  return (
    <>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          {profile?.full_name ?? user.email}
          {profile?.role === "admin" && (
            <span className="chip ml-2 border-astra-500/30 bg-astra-500/10 py-0.5 text-[10px] text-astra-300">
              Admin
            </span>
          )}
        </p>
      </div>

      <div className="max-w-3xl">
        <BotAuthPanel
          initial={{
            status,
            run: describeRun(getRun(user.id)),
            localFlowEnabled: localBotAuthEnabled(),
            storageKey: leaderPaths(user.id).storageKey,
          }}
        />
      </div>
    </>
  );
}
