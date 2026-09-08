/**
 * Extension configuration.
 *
 * An extension has no .env file, so these three values live here. They are the
 * same ones the dashboard uses:
 *
 *   SUPABASE_URL       Supabase dashboard -> Settings -> Data API
 *                      The BARE origin. Not the "RESTful endpoint" ending
 *                      in /rest/v1 -- this client appends its own paths, and
 *                      pasting that one produces /rest/v1/auth/v1/token.
 *
 *   SUPABASE_ANON_KEY  Settings -> API Keys. Either `sb_publishable_...` or the
 *                      legacy `anon` JWT; both work. Safe to ship in an
 *                      extension -- it grants nothing on its own, because every
 *                      query it makes is still filtered by the RLS policies.
 *
 *   API_BASE           Where Astra itself is running.
 *
 * Change API_BASE for a deployed instance, and add that origin to
 * "host_permissions" in manifest.json -- Chrome blocks any host not listed
 * there, with a CORS-shaped error that never mentions the manifest.
 */
export const CONFIG = {
  SUPABASE_URL: "https://rxmtnxbhbksxvmqxkrmf.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_tTGLevhUyjhKcgdEBd2Vkw_0SMbhXCI",
  API_BASE: "http://localhost:3000",
};

/** True once the placeholders above have actually been replaced. */
export function configured() {
  return (
    /^https:\/\/[^/]+\.supabase\.co$/.test(CONFIG.SUPABASE_URL) &&
    CONFIG.SUPABASE_ANON_KEY.length > 20 &&
    !CONFIG.SUPABASE_ANON_KEY.startsWith("PASTE_")
  );
}
