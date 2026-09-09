"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The team's description, editable in place by its leader.
 *
 * This is not decoration. The description is the only free-text explanation of
 * what the team is *for*, and it travels further than any other field: it goes
 * into the pre-context Markdown, into the summon payload the extension sends,
 * and from there into the model's prompt in every meeting. A team described as
 * "we manage and help meeting efficiency" gets noticeably different answers
 * from one with an empty description, so it is worth being able to fix without
 * a round trip through the database.
 *
 * Read-only for everybody but the leader — the PATCH endpoint enforces that
 * with `requireTeamLeader`, and this hides the affordance so nobody clicks a
 * button that was always going to 403.
 */
export function TeamDescriptionEditor({
  teamId,
  initial,
  canEdit,
}: {
  teamId: string;
  initial: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What is on the server, so Cancel restores it and Save can tell whether
  // anything actually changed.
  const [saved, setSaved] = useState(initial ?? "");

  const MAX = 2000; // matches the column's own check constraint

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/teams/${teamId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: value.trim() }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);

      setSaved(value.trim());
      setValue(value.trim());
      setEditing(false);
      // The description is rendered by a server component and is also baked
      // into the next pre-context run, so refresh rather than trusting local
      // state to stay in step with everything downstream of it.
      router.refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="mt-2 max-w-2xl">
        {saved ? (
          <p className="text-sm leading-relaxed text-slate-500">{saved}</p>
        ) : (
          <p className="text-sm italic leading-relaxed text-slate-600">
            {canEdit
              ? "No description yet — it is sent to the bot as part of the sprint context."
              : "No description."}
          </p>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setValue(saved);
              setEditing(true);
            }}
            className="mt-1 text-xs text-slate-500 underline-offset-2 hover:text-astra-300 hover:underline"
          >
            {saved ? "Edit description" : "Add a description"}
          </button>
        )}
      </div>
    );
  }

  const dirty = value.trim() !== saved;

  return (
    <div className="mt-2 max-w-2xl">
      <label className="sr-only" htmlFor="team-description">
        Team description
      </label>
      <textarea
        id="team-description"
        value={value}
        onChange={(event) => setValue(event.target.value.slice(0, MAX))}
        rows={3}
        autoFocus
        disabled={busy}
        placeholder="What is this team responsible for? One or two sentences."
        className="input resize-y leading-relaxed"
      />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="btn-primary px-4 py-2 text-xs"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setValue(saved);
            setEditing(false);
            setError(null);
          }}
          disabled={busy}
          className="btn-text py-2 text-xs"
        >
          Cancel
        </button>
        <span className="ml-auto text-[10px] tabular-nums text-slate-600">
          {value.length}/{MAX}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
        Sent to the bot with every summon, and included in the sprint context the
        model reads — so a sentence about what the team owns changes the answers
        it gives.
      </p>

      {error && (
        <p className="mt-2 rounded-lg border border-signal-red/30 bg-signal-red/10 px-3 py-2 text-xs text-signal-red">
          {error}
        </p>
      )}
    </div>
  );
}
