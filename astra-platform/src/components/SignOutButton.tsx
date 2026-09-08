"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await createSupabaseBrowserClient().auth.signOut();
    // refresh() as well as push(): the server components above this one cached
    // the signed-in user, and only a refresh re-renders them.
    router.push("/login");
    router.refresh();
  }

  return (
    <button onClick={signOut} disabled={busy} className="btn-ghost px-3 py-1.5 text-xs">
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
