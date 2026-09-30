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
      <div className="mb-10">
        <h1 className="text-[32px] font-normal leading-tight text-slate-50">Settings</h1>
      </div>

      {/*
        A two-column layout, and not for decoration. The page previously put one
        narrow card at the top left of an otherwise empty screen, which reads as
        a page that failed to load rather than one with a single setting on it.
        Giving the account its own column fills the space with something true
        and turns the bot panel into the obvious subject rather than an orphan.

        It collapses to one column below `lg`, identity first, because on a
        phone the thing you scrolled to Settings for should not be underneath a
        card telling you your own name.
      */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <aside className="card h-fit p-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-astra-500/20
                         text-base font-semibold text-astra-300 ring-1 ring-inset ring-astra-300/25"
            >
              {(profile?.full_name ?? user.email ?? "?").trim()[0]?.toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[15px] font-medium text-slate-100">
                {profile?.full_name ?? user.email}
              </p>
              {profile?.full_name && (
                <p className="truncate text-xs text-slate-400">{user.email}</p>
              )}
            </div>
          </div>

          <div className="mt-5 space-y-3 border-t border-ink-600/70 pt-5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">Role</span>
              {profile?.role === "admin" ? (
                <span className="chip border-astra-300/25 bg-astra-500/15 py-0.5 text-[10px] text-astra-300">
                  Admin
                </span>
              ) : (
                <span className="chip py-0.5 text-[10px]">Member</span>
              )}
            </div>
            <p className="leading-relaxed text-slate-500">
              {profile?.role === "admin"
                ? "You can add and edit people in the resource pool. Those handles decide whose work shows up in every team's pre-context."
                : "You can lead teams and generate pre-context. Editing the resource pool is an admin action — ask one to add someone."}
            </p>
          </div>
        </aside>

        <div className="min-w-0">
          <BotAuthPanel
            initial={{
              status,
              run: describeRun(getRun(user.id)),
              localFlowEnabled: localBotAuthEnabled(),
              storageKey: leaderPaths(user.id).storageKey,
            }}
          />
        </div>
      </div>
    </>
  );
}
