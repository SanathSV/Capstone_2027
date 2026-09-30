import { Suspense } from "react";
import { LoginForm } from "@/components/LoginForm";
import { AstraMark } from "@/components/Shell";

/**
 * The form reads `?next=` with useSearchParams, which forces a client bailout.
 * Wrapping it in Suspense keeps this route statically renderable and gives the
 * brand mark something to hold while the form hydrates.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <AstraMark className="h-9 w-9 animate-pulse" />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    </div>
  );
}
