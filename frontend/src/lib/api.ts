import type { Employee, Membership, Page, Project, Task, Team } from "./types";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend-api";

export class ApiError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers }, cache: "no-store" });
  if (!response.ok) {
    let message = "Something went wrong while contacting Astra.";
    try { const body = await response.json() as { detail?: string }; message = body.detail ?? message; } catch { /* non-JSON error */ }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  employees: (limit = 100) => request<Page<Employee>>(`/api/v1/management/employees?limit=${limit}`),
  employee: (id: string) => request<Employee>(`/api/v1/management/employees/${encodeURIComponent(id)}`),
  employeeProjects: (id: string) => request<Membership[]>(`/api/v1/management/employees/${encodeURIComponent(id)}/projects`),
  employeeTasks: (id: string) => request<Page<Task>>(`/api/v1/management/employees/${encodeURIComponent(id)}/tasks?limit=100`),
  projects: (limit = 100) => request<Page<Project>>(`/api/v1/management/projects?limit=${limit}`),
  project: (id: string) => request<Project>(`/api/v1/management/projects/${encodeURIComponent(id)}`),
  projectEmployees: (id: string) => request<Membership[]>(`/api/v1/management/projects/${encodeURIComponent(id)}/employees`),
  projectTeams: (id: string) => request<Team[]>(`/api/v1/management/projects/${encodeURIComponent(id)}/teams`),
  projectTasks: (id: string, limit = 100) => request<Page<Task>>(`/api/v1/management/projects/${encodeURIComponent(id)}/tasks?limit=${limit}`),
  task: (projectId: string, taskId: string) => request<Task>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`),
  createEmployee: (body: { employee_id: string; name: string; email: string; role: string; department: string; manager_id?: string | null }) => request<Employee>("/api/v1/management/employees", { method: "POST", body: JSON.stringify(body) }),
  updateEmployee: (id: string, body: { name?: string; email?: string; role?: string; department?: string; manager_id?: string | null; employment_status?: string }) => request<Employee>(`/api/v1/management/employees/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  registerAgent: (body: { employee_id: string; device_id: string; agent_version: string; os: string }) => request<Employee>("/api/v1/agent/register", { method: "POST", body: JSON.stringify(body) }),
  heartbeat: (body: { device_id: string; timestamp: string; agent_version: string }) => request<Employee>("/api/v1/agent/heartbeat", { method: "POST", body: JSON.stringify(body) }),
  createProject: (body: { project_id: string; name: string; description?: string | null; status?: string; owner_employee_id?: string | null; department?: string | null; github?: { provider: "github"; organization: string; repository: string; repository_id: string; default_branch: string; installation_id: string } | null; jira?: { provider: "jira"; cloud_id: string; project_key: string } | null }) => request<Project>("/api/v1/management/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, body: { name?: string; description?: string | null; status?: string; owner_employee_id?: string | null; department?: string | null; github?: { provider: "github"; organization: string; repository: string; repository_id: string; default_branch: string; installation_id: string } | null; jira?: { provider: "jira"; cloud_id: string; project_key: string } | null }) => request<Project>(`/api/v1/management/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  createTeam: (projectId: string, body: { team_id: string; name: string; description?: string | null; team_lead_id?: string | null }) => request<Team>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams`, { method: "POST", body: JSON.stringify(body) }),
  team: (projectId: string, teamId: string) => request<Team>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}`),
  updateTeam: (projectId: string, teamId: string, body: { name?: string; description?: string | null; team_lead_id?: string | null; status?: string }) => request<Team>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}`, { method: "PATCH", body: JSON.stringify(body) }),
  addProjectEmployee: (projectId: string, body: { employee_id: string; team_id?: string | null; role: string; allocation_percentage: number }) => request<Membership>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/employees`, { method: "POST", body: JSON.stringify(body) }),
  updateMembership: (projectId: string, employeeId: string, body: { team_id?: string | null; role?: string; allocation_percentage?: number; status?: string }) => request<Membership>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/employees/${encodeURIComponent(employeeId)}`, { method: "PATCH", body: JSON.stringify(body) }),
  addTeamEmployee: (projectId: string, teamId: string, body: { employee_id: string }) => request<Membership>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/employees`, { method: "POST", body: JSON.stringify(body) }),
  teamEmployees: (projectId: string, teamId: string) => request<Membership[]>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/employees`),
  removeProjectEmployee: (projectId: string, employeeId: string) => request<void>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/employees/${encodeURIComponent(employeeId)}`, { method: "DELETE" }),
  removeTeamEmployee: (projectId: string, teamId: string, employeeId: string) => request<void>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/teams/${encodeURIComponent(teamId)}/employees/${encodeURIComponent(employeeId)}`, { method: "DELETE" }),
  createTask: (projectId: string, body: { task_id: string; title: string; description?: string | null; jira_issue_key?: string | null; assignee_id?: string | null; team_id?: string | null; status?: string; progress?: number; priority?: string; estimated_hours?: number | null; actual_hours?: number; acceptance_criteria?: string[] }) => request<Task>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/tasks`, { method: "POST", body: JSON.stringify(body) }),
  updateTask: (projectId: string, taskId: string, body: { title?: string; description?: string | null; jira_issue_key?: string | null; priority?: string; estimated_hours?: number | null; actual_hours?: number; acceptance_criteria?: string[]; assignee_id?: string | null; team_id?: string | null; status?: string; progress?: number }) => request<Task>(`/api/v1/management/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(body) }),
};