"use client";

import { useMemo, useState, type ReactNode } from "react";

import { ConnectionTester } from "@/components/integrations/connection-tester";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";

export interface IntegrationField {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  /** Secret fields render masked with a reveal toggle. */
  secret?: boolean;
}

export interface IntegrationCardProps {
  name: string;
  description: string;
  /**
   * A rendered icon element, not a component reference — this is a Client
   * Component, and function props cannot cross the server boundary.
   */
  icon: ReactNode;
  /** Tailwind gradient classes for the icon tile, e.g. "from-indigo to-blue-500". */
  accent: string;
  connected?: boolean;
  fields: IntegrationField[];
}

export function IntegrationCard({
  name,
  description,
  icon,
  accent,
  connected = false,
  fields,
}: IntegrationCardProps) {
  const [values, setValues] = useState<Record<string, string>>({});

  const ready = useMemo(
    () => fields.every((field) => (values[field.key] ?? "").trim().length > 0),
    [fields, values],
  );

  const setValue = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <Card className="flex flex-col transition-colors duration-200 hover:border-slate-700">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${accent}`}
          >
            {icon}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-sm font-semibold tracking-tight text-white">{name}</h2>
            <p className="text-xs leading-relaxed text-slate-500">{description}</p>
          </div>
        </div>
        <Badge tone={connected ? "active" : "neutral"} dot>
          {connected ? "Active" : "Not linked"}
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        {fields.map((field) =>
          field.secret ? (
            <SecretInput
              key={field.key}
              label={field.label}
              hint={field.hint}
              placeholder={field.placeholder}
              value={values[field.key] ?? ""}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          ) : (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <Input
                placeholder={field.placeholder}
                value={values[field.key] ?? ""}
                onChange={(event) => setValue(field.key, event.target.value)}
                className="font-mono text-xs"
              />
            </Field>
          ),
        )}
      </CardContent>

      <CardFooter>
        <ConnectionTester ready={ready} serviceName={name} />
      </CardFooter>
    </Card>
  );
}
