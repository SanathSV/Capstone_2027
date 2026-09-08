"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Field, Input, type FieldState } from "@/components/ui/input";

export interface SecretInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  hint?: string;
  state?: FieldState;
}

/** Token/secret field with a mask toggle. Values never leave the client here. */
export function SecretInput({ label, hint, state, ...props }: SecretInputProps) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);

  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <Input
        id={id}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        state={state}
        adornment={
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
            className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800/80 hover:text-slate-200"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
          </button>
        }
        {...props}
      />
    </Field>
  );
}
