/** Shared field validators for the team configuration form. */

export interface ValidationResult {
  valid: boolean;
  message: string;
}

const JIRA_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const GITHUB_HANDLE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

export function validateTeamName(value: string): ValidationResult {
  if (value.trim().length === 0) return { valid: false, message: "Team name is required." };
  if (value.trim().length < 3) return { valid: false, message: "Use at least 3 characters." };
  return { valid: true, message: "Looks good." };
}

export function validateJiraKey(value: string): ValidationResult {
  if (value.trim().length === 0) return { valid: false, message: "Project key is required." };
  if (!JIRA_KEY.test(value)) {
    return { valid: false, message: "Uppercase letters and digits, 2–10 chars (e.g. ASTRA)." };
  }
  return { valid: true, message: "Valid Jira project key." };
}

export function validateGithubRepo(value: string): ValidationResult {
  if (value.trim().length === 0) return { valid: false, message: "Repository is required." };
  if (!GITHUB_REPO.test(value)) {
    return { valid: false, message: "Use owner/repository (e.g. SanathSV/astra)." };
  }
  return { valid: true, message: "Valid repository path." };
}

export function validateGithubHandle(value: string): ValidationResult {
  if (value.trim().length === 0) return { valid: false, message: "Handle is required." };
  if (!GITHUB_HANDLE.test(value)) {
    return { valid: false, message: "Not a valid GitHub username." };
  }
  return { valid: true, message: "Valid handle." };
}

export function validateRequired(value: string, field: string): ValidationResult {
  return value.trim().length > 0
    ? { valid: true, message: "" }
    : { valid: false, message: `${field} is required.` };
}
