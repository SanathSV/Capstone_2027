"use client";

import { useMemo, useState } from "react";
import { Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import {
  validateGithubRepo,
  validateJiraKey,
  validateTeamName,
  type ValidationResult,
} from "@/lib/validation";

interface FormState {
  teamName: string;
  jiraKey: string;
  githubRepo: string;
}

const initialState: FormState = {
  teamName: "Capstone Core",
  jiraKey: "ASTRA",
  githubRepo: "SanathSV/astra",
};

/** Validation runs on every keystroke but styling waits until a field is touched. */
export function TeamProfileForm() {
  const [values, setValues] = useState<FormState>(initialState);
  const [touched, setTouched] = useState<Record<keyof FormState, boolean>>({
    teamName: false,
    jiraKey: false,
    githubRepo: false,
  });
  const [saved, setSaved] = useState(false);

  const results = useMemo(
    () => ({
      teamName: validateTeamName(values.teamName),
      jiraKey: validateJiraKey(values.jiraKey),
      githubRepo: validateGithubRepo(values.githubRepo),
    }),
    [values],
  );

  const formValid = Object.values(results).every((result) => result.valid);

  const update = (key: keyof FormState, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setTouched((current) => ({ ...current, [key]: true }));
    setSaved(false);
  };

  const fieldProps = (key: keyof FormState, result: ValidationResult) => ({
    state: !touched[key] ? ("idle" as const) : result.valid ? ("valid" as const) : ("invalid" as const),
    error: touched[key] && !result.valid ? result.message : undefined,
    success: touched[key] && result.valid ? result.message : undefined,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team profile</CardTitle>
        <CardDescription>
          Astra files action items against this Jira project and attributes commits to this
          repository.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5 md:grid-cols-3">
        <Field
          label="Team name"
          htmlFor="team-name"
          error={fieldProps("teamName", results.teamName).error}
          success={fieldProps("teamName", results.teamName).success}
          hint="Shown in the workspace switcher."
        >
          <Input
            id="team-name"
            value={values.teamName}
            onChange={(event) => update("teamName", event.target.value)}
            state={fieldProps("teamName", results.teamName).state}
            placeholder="Capstone Core"
          />
        </Field>

        <Field
          label="Jira project key"
          htmlFor="jira-key"
          error={fieldProps("jiraKey", results.jiraKey).error}
          success={fieldProps("jiraKey", results.jiraKey).success}
          hint="Uppercase key, e.g. ASTRA."
        >
          <Input
            id="jira-key"
            value={values.jiraKey}
            onChange={(event) => update("jiraKey", event.target.value.toUpperCase())}
            state={fieldProps("jiraKey", results.jiraKey).state}
            placeholder="ASTRA"
            className="font-mono"
          />
        </Field>

        <Field
          label="Primary GitHub repo"
          htmlFor="github-repo"
          error={fieldProps("githubRepo", results.githubRepo).error}
          success={fieldProps("githubRepo", results.githubRepo).success}
          hint="Format: owner/repository."
        >
          <Input
            id="github-repo"
            value={values.githubRepo}
            onChange={(event) => update("githubRepo", event.target.value)}
            state={fieldProps("githubRepo", results.githubRepo).state}
            placeholder="owner/repository"
            className="font-mono"
          />
        </Field>
      </CardContent>

      <CardFooter>
        <p className="text-xs text-slate-600">
          {saved ? "Saved locally — no backend route yet." : "Changes are not persisted yet."}
        </p>
        <Button variant="primary" disabled={!formValid} onClick={() => setSaved(true)}>
          <Save className="h-4 w-4" aria-hidden />
          Save profile
        </Button>
      </CardFooter>
    </Card>
  );
}
