export type ProjectStatus = "PLANNED" | "ACTIVE" | "IN_PROGRESS" | "ON_HOLD" | "COMPLETED" | "ARCHIVED";
export type EmploymentStatus = "ACTIVE" | "INACTIVE" | "ON_LEAVE";
export type AgentStatus = "ONLINE" | "OFFLINE" | "UNKNOWN";
export type TaskStatus = "NOT_STARTED" | "IN_PROGRESS" | "LIKELY_COMPLETE" | "VERIFIED_COMPLETE" | "BLOCKED" | "UNKNOWN";
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface Page<T> { items: T[]; next_token: string | null; }
export interface AgentMetadata { device_id: string | null; agent_version: string | null; os: string | null; status: AgentStatus; last_heartbeat: string | null; }
export interface Employee { employee_id: string; name: string; email: string; role: string; department: string; manager_id: string | null; employment_status: EmploymentStatus; agent: AgentMetadata; created_at: string; updated_at: string; }
export interface Project { project_id: string; name: string; description: string | null; status: ProjectStatus; owner_employee_id: string | null; department: string | null; github: { organization: string; repository: string } | null; jira: { cloud_id: string; project_key: string } | null; created_at: string; updated_at: string; }
export interface Membership { project_id: string; employee_id: string; team_id: string | null; role: string; allocation_percentage: number; status: "ACTIVE" | "INACTIVE"; joined_at: string; updated_at: string; }
export interface Task { project_id: string; task_id: string; jira_issue_key: string | null; title: string; description: string | null; assignee_id: string | null; team_id: string | null; status: TaskStatus; progress: number; priority: TaskPriority; estimated_hours: number | null; actual_hours: number; acceptance_criteria: string[]; started_at: string | null; last_activity_at: string | null; completed_at: string | null; astra_confidence: number | null; last_evidence: unknown; created_at: string; updated_at: string; }
export interface Team { project_id: string; team_id: string; name: string; description: string | null; team_lead_id: string | null; status: "ACTIVE" | "INACTIVE"; created_at: string; updated_at: string; }