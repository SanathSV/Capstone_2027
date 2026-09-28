"use client";

import { createBrowserClient } from "@supabase/ssr";
import { normaliseSupabaseUrl } from "./url";

/**
 * Browser client. Carries the anon key only, so every read it makes is still
 * filtered by the RLS policies in supabase/schema.sql.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    normaliseSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL!),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
