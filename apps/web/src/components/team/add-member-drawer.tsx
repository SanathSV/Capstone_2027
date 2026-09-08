"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Field, Input } from "@/components/ui/input";
import type { TeamMember } from "@/lib/mock-data";
import { validateGithubHandle, validateRequired } from "@/lib/validation";

export interface AddMemberDrawerProps {
  open: boolean;
  onClose: () => void;
  onAdd: (member: Omit<TeamMember, "id">) => void;
}

const emptyForm = { meetName: "", jiraAccount: "", githubHandle: "" };

export function AddMemberDrawer({ open, onClose, onAdd }: AddMemberDrawerProps) {
  const [form, setForm] = useState(emptyForm);

  // Reset the form each time the drawer opens so stale input never reappears.
  useEffect(() => {
    if (open) setForm(emptyForm);
  }, [open]);

  const results = {
    meetName: validateRequired(form.meetName, "Google Meet name"),
    jiraAccount: validateRequired(form.jiraAccount, "Jira account"),
    githubHandle: validateGithubHandle(form.githubHandle),
  };
  const valid = Object.values(results).every((result) => result.valid);

  const submit = () => {
    if (!valid) return;
    onAdd(form);
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add team member"
      description="Map one person across Google Meet, Jira and GitHub."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Add member
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Google Meet display name"
          htmlFor="member-meet"
          hint="Must match the name shown in the call exactly."
        >
          <Input
            id="member-meet"
            value={form.meetName}
            onChange={(event) => setForm({ ...form, meetName: event.target.value })}
            placeholder="Priya Raghavan"
          />
        </Field>

        <Field label="Jira account ID / name" htmlFor="member-jira">
          <Input
            id="member-jira"
            value={form.jiraAccount}
            onChange={(event) => setForm({ ...form, jiraAccount: event.target.value })}
            placeholder="priya.r"
            className="font-mono"
          />
        </Field>

        <Field
          label="GitHub handle"
          htmlFor="member-github"
          error={
            form.githubHandle.length > 0 && !results.githubHandle.valid
              ? results.githubHandle.message
              : undefined
          }
        >
          <Input
            id="member-github"
            value={form.githubHandle}
            onChange={(event) => setForm({ ...form, githubHandle: event.target.value })}
            state={
              form.githubHandle.length === 0
                ? "idle"
                : results.githubHandle.valid
                  ? "valid"
                  : "invalid"
            }
            placeholder="praghavan"
            className="font-mono"
          />
        </Field>

        <p className="rounded-lg border border-slate-800/80 bg-slate-950/40 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
          Astra uses this mapping to attribute spoken action items to the right Jira assignee and
          GitHub author. Unmapped speakers are queued for manual review.
        </p>
      </div>
    </Drawer>
  );
}
