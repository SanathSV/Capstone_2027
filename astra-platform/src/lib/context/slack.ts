import { fetchJson } from "./http";
import { IntegrationError } from "./http";
import type { RosterEntry, SlackContext } from "./types";

/**
 * Slack half of the context engine.
 *
 * Slack contributes the least to the payload and that is intentional: message
 * history is enormous and mostly noise, and the bot listens to the *meeting*,
 * not the channel. What Slack is genuinely good for here is verifying the
 * cross-walk — confirming that the member IDs in the resource pool are real
 * people in the standup's channel, so a typo surfaces before the meeting rather
 * than as a silently missing person afterwards.
 */

interface SlackConversation {
  ok: boolean;
  error?: string;
  channel?: { id: string; name?: string; topic?: { value?: string } };
}

interface SlackMembers {
  ok: boolean;
  error?: string;
  members?: string[];
}

/** Slack answers 200 with {ok:false} rather than an HTTP status. */
function assertOk(payload: { ok: boolean; error?: string } | null, what: string) {
  if (!payload || payload.ok) return;
  const hint =
    payload.error === "missing_scope"
      ? " The bot token needs channels:read (and groups:read for private channels)."
      : payload.error === "not_in_channel"
        ? " Invite the Slack app to the channel first."
        : "";
  throw new IntegrationError("Slack", `Slack rejected ${what}: ${payload.error}.${hint}`);
}

export interface SlackResult {
  context: SlackContext;
  fetched: number;
  truncated: string[];
}

export async function collectSlack(
  botToken: string,
  channelId: string,
  roster: RosterEntry[],
): Promise<SlackResult> {
  const opts = {
    source: "Slack",
    headers: { authorization: `Bearer ${botToken}` },
  };

  const info = await fetchJson<SlackConversation>(
    `https://slack.com/api/conversations.info?channel=${encodeURIComponent(channelId)}`,
    opts,
  );
  assertOk(info, "conversations.info");

  const membership = await fetchJson<SlackMembers>(
    `https://slack.com/api/conversations.members?channel=${encodeURIComponent(channelId)}&limit=200`,
    opts,
  );
  assertOk(membership, "conversations.members");

  const present = new Set(membership?.members ?? []);
  const withSlack = roster.filter((p) => p.slack);

  const context: SlackContext = { channel_id: channelId };
  if (info?.channel?.name) context.channel_name = info.channel.name;

  const inChannel = withSlack.filter((p) => present.has(p.slack!)).map((p) => p.ref);
  const missing = withSlack.filter((p) => !present.has(p.slack!)).map((p) => p.ref);
  if (inChannel.length) context.members_present = inChannel;
  if (missing.length) context.members_missing = missing;

  return { context, fetched: present.size, truncated: [] };
}
