/**
 * Placeholder data for the dashboard shell. Every export here is replaced by a
 * backend call once the corresponding API routes exist — nothing writes to it.
 */

export interface Team {
  id: string;
  name: string;
  initials: string;
  plan: string;
}

export const teams: Team[] = [
  { id: "core", name: "Capstone Core", initials: "CC", plan: "Pro workspace" },
  { id: "platform", name: "Platform Guild", initials: "PG", plan: "Pro workspace" },
  { id: "research", name: "Research Pod", initials: "RP", plan: "Trial" },
];

export interface TeamMember {
  id: string;
  meetName: string;
  jiraAccount: string;
  githubHandle: string;
}

export const initialRoster: TeamMember[] = [
  {
    id: "m-1",
    meetName: "Sanath Venkatesh",
    jiraAccount: "sanath.v",
    githubHandle: "SanathSV",
  },
  {
    id: "m-2",
    meetName: "Priya Raghavan",
    jiraAccount: "priya.r",
    githubHandle: "praghavan",
  },
  {
    id: "m-3",
    meetName: "Daniel Osei",
    jiraAccount: "d.osei",
    githubHandle: "dosei-dev",
  },
];

export type SessionStatus = "live" | "processing" | "completed" | "failed";

export interface MeetingSession {
  id: string;
  title: string;
  meetingCode: string;
  status: SessionStatus;
  startedAt: string;
  durationMinutes: number;
  participants: number;
  transcriptWords: number;
  triggers: number;
  actionItems: number;
}

export const sessions: MeetingSession[] = [
  {
    id: "s-1",
    title: "Sprint 14 Standup",
    meetingCode: "hqx-mnbv-trz",
    status: "live",
    startedAt: "2026-09-07T09:32:00Z",
    durationMinutes: 18,
    participants: 7,
    transcriptWords: 2140,
    triggers: 4,
    actionItems: 2,
  },
  {
    id: "s-2",
    title: "Capstone Architecture Review",
    meetingCode: "kjd-ptra-wqe",
    status: "processing",
    startedAt: "2026-09-07T08:00:00Z",
    durationMinutes: 62,
    participants: 5,
    transcriptWords: 11480,
    triggers: 12,
    actionItems: 9,
  },
  {
    id: "s-3",
    title: "Bot Capture Post-mortem",
    meetingCode: "vbn-qwer-plm",
    status: "completed",
    startedAt: "2026-09-06T15:15:00Z",
    durationMinutes: 47,
    participants: 4,
    transcriptWords: 8320,
    triggers: 8,
    actionItems: 6,
  },
  {
    id: "s-4",
    title: "Integrations Sync — Jira",
    meetingCode: "trf-lkju-xzc",
    status: "completed",
    startedAt: "2026-09-05T11:00:00Z",
    durationMinutes: 31,
    participants: 3,
    transcriptWords: 5210,
    triggers: 5,
    actionItems: 4,
  },
  {
    id: "s-5",
    title: "Extension Permissions Review",
    meetingCode: "opl-ghyu-mnb",
    status: "failed",
    startedAt: "2026-09-04T16:40:00Z",
    durationMinutes: 8,
    participants: 6,
    transcriptWords: 0,
    triggers: 0,
    actionItems: 0,
  },
];
