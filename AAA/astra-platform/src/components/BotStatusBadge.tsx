import type { BotCredentialStatus } from "@/lib/db/types";

/** "unknown" is not a credential state — it means the lookup itself failed. */
export type BadgeStatus = BotCredentialStatus | "unknown";

/**
 * The Team Leader's bot status, in one chip.
 *
 * Used in two places that mean slightly different things: on Settings it is
 * *your* bot, and on a team page it is *the leader's* bot — which may be
 * someone else, on a machine you have never seen. `subject` carries that
 * difference into the tooltip so the same chip never misleads.
 */

const LOOK: Record<
  BadgeStatus,
  { label: string; className: string; dot: string }
> = {
  authenticated: {
    label: "Authenticated",
    className: "border-signal-green/30 bg-signal-green/10 text-signal-green",
    dot: "bg-signal-green",
  },
  expired: {
    label: "Expired",
    className: "border-signal-amber/30 bg-signal-amber/10 text-signal-amber",
    dot: "bg-signal-amber",
  },
  revoked: {
    label: "Revoked",
    className: "border-ink-600 bg-ink-800 text-slate-400",
    dot: "bg-slate-500",
  },
  none: {
    label: "Not Authenticated",
    className: "border-ink-600 bg-ink-800 text-slate-400",
    dot: "bg-slate-600",
  },
  // Not a state of the bot — a state of our knowledge. Claiming "Not
  // Authenticated" here would be asserting something we did not manage to look
  // up, which is how a working bot gets reported as broken.
  unknown: {
    label: "Status unavailable",
    className: "border-signal-amber/30 bg-signal-amber/10 text-signal-amber",
    dot: "bg-signal-amber",
  },
};

export function BotStatusBadge({
  status,
  subject = "This bot account",
  googleEmail,
  className = "",
}: {
  status: BadgeStatus;
  /** How to name the owner in the tooltip, e.g. "Grace Hopper's bot". */
  subject?: string;
  googleEmail?: string | null;
  className?: string;
}) {
  const look = LOOK[status] ?? LOOK.none;

  const title =
    status === "authenticated"
      ? `${subject} is signed in${googleEmail ? ` as ${googleEmail}` : ""} and can join meetings.`
      : status === "expired"
        ? `${subject} was signed in, but the Google session has lapsed. It needs authenticating again.`
        : status === "unknown"
        ? `Astra could not read the bot status — this says nothing about whether ${subject.toLowerCase()} works. Check the server log.`
        : status === "revoked"
          ? `${subject} was deliberately signed out.`
          : `${subject} has never been authenticated, so it would join meetings as an anonymous guest — if it is admitted at all.`;

  return (
    <span className={`chip py-0.5 text-[10px] ${look.className} ${className}`} title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${look.dot}`} />
      Bot: {look.label}
    </span>
  );
}
