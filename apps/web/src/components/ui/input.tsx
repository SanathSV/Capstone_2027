import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { AlertCircle, Check } from "lucide-react";

import { cn } from "@/lib/utils";

export type FieldState = "idle" | "valid" | "invalid";

const stateRing: Record<FieldState, string> = {
  idle: "border-slate-800/80 focus:border-indigo/70 focus:ring-indigo/20",
  valid: "border-emerald/40 focus:border-emerald/70 focus:ring-emerald/20",
  invalid: "border-red-500/50 focus:border-red-500/70 focus:ring-red-500/20",
};

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  state?: FieldState;
  /** Rendered inside the field on the right — used by the password mask toggle. */
  adornment?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, state = "idle", adornment, ...props },
  ref,
) {
  return (
    <div className="relative">
      <input
        ref={ref}
        className={cn(
          "h-9 w-full rounded-lg border bg-slate-950/60 px-3 text-sm text-white",
          "placeholder:text-slate-600",
          "transition-colors duration-150 focus:outline-none focus:ring-4",
          "disabled:cursor-not-allowed disabled:opacity-50",
          stateRing[state],
          adornment ? "pr-10" : undefined,
          className,
        )}
        {...props}
      />
      {adornment ? (
        <div className="absolute inset-y-0 right-0 flex items-center pr-2">{adornment}</div>
      ) : null}
    </div>
  );
});

export interface FieldProps {
  label: string;
  hint?: string;
  /** Shown in red under the field; also drives the invalid styling upstream. */
  error?: string;
  /** Shown in emerald once the value passes validation. */
  success?: string;
  htmlFor?: string;
  children: ReactNode;
}

export function Field({ label, hint, error, success, htmlFor, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-slate-300">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : success ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald">
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {success}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-600">{hint}</p>
      ) : null}
    </div>
  );
}
