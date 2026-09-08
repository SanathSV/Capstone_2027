"use client";

import { useState } from "react";
import { ArrowRight, Check, Pencil, Plus, Trash2, X } from "lucide-react";

import { AddMemberDrawer } from "@/components/team/add-member-drawer";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { initialRoster, type TeamMember } from "@/lib/mock-data";

export function RosterTable() {
  const [roster, setRoster] = useState<TeamMember[]>(initialRoster);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TeamMember | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const startEdit = (member: TeamMember) => {
    setEditingId(member.id);
    setDraft({ ...member });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };

  const commitEdit = () => {
    if (!draft) return;
    setRoster((current) => current.map((member) => (member.id === draft.id ? draft : member)));
    cancelEdit();
  };

  const remove = (id: string) => {
    setRoster((current) => current.filter((member) => member.id !== id));
    if (editingId === id) cancelEdit();
  };

  const add = (member: Omit<TeamMember, "id">) => {
    setRoster((current) => [...current, { ...member, id: crypto.randomUUID() }]);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Roster identity mapping</CardTitle>
          <CardDescription>
            One row per person, linking their Meet display name to Jira and GitHub.
          </CardDescription>
        </div>
        <Button variant="primary" size="sm" onClick={() => setDrawerOpen(true)}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add team member
        </Button>
      </CardHeader>

      <Table>
        <TableHead>
          <TableRow className="hover:bg-transparent">
            <TableHeaderCell>Google Meet name</TableHeaderCell>
            <TableHeaderCell>
              <span className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-slate-700" aria-hidden />
                Jira account
              </span>
            </TableHeaderCell>
            <TableHeaderCell>
              <span className="flex items-center gap-2">
                <ArrowRight className="h-3 w-3 text-slate-700" aria-hidden />
                GitHub handle
              </span>
            </TableHeaderCell>
            <TableHeaderCell className="w-24 text-right">Actions</TableHeaderCell>
          </TableRow>
        </TableHead>

        <TableBody>
          {roster.map((member) => {
            const editing = editingId === member.id && draft !== null;

            return (
              <TableRow key={member.id}>
                <TableCell className="font-medium text-white">
                  {editing && draft ? (
                    <Input
                      value={draft.meetName}
                      onChange={(event) => setDraft({ ...draft, meetName: event.target.value })}
                      className="h-8"
                      aria-label="Google Meet name"
                    />
                  ) : (
                    member.meetName
                  )}
                </TableCell>

                <TableCell className="font-mono text-xs">
                  {editing && draft ? (
                    <Input
                      value={draft.jiraAccount}
                      onChange={(event) => setDraft({ ...draft, jiraAccount: event.target.value })}
                      className="h-8 font-mono"
                      aria-label="Jira account"
                    />
                  ) : (
                    member.jiraAccount
                  )}
                </TableCell>

                <TableCell className="font-mono text-xs">
                  {editing && draft ? (
                    <Input
                      value={draft.githubHandle}
                      onChange={(event) => setDraft({ ...draft, githubHandle: event.target.value })}
                      className="h-8 font-mono"
                      aria-label="GitHub handle"
                    />
                  ) : (
                    <span className="text-slate-400">@{member.githubHandle}</span>
                  )}
                </TableCell>

                <TableCell>
                  <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                    {editing ? (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={commitEdit}
                          aria-label="Save row"
                          className="text-emerald hover:text-emerald"
                        >
                          <Check className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={cancelEdit}
                          aria-label="Cancel edit"
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => startEdit(member)}
                          aria-label={"Edit " + member.meetName}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => remove(member.id)}
                          aria-label={"Remove " + member.meetName}
                          className="hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}

          {roster.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-600">
                No members mapped yet.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <AddMemberDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onAdd={add} />
    </Card>
  );
}
