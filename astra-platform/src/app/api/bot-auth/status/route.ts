import { json, requireUser, route } from "@/lib/api";
import { describeRun, getRun, readBotAuthStatus } from "@/lib/botAuth";

/**
 * Polled while a sign-in window is open.
 *
 * Separate from the main GET so the poll stays cheap: it touches the filesystem
 * and the in-memory run, and never writes to Postgres. The dashboard hits this
 * every couple of seconds for as long as someone is typing a Google password,
 * which is not a thing to put an upsert behind.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return json({
      run: describeRun(getRun(user.id)),
      status: await readBotAuthStatus(user.id),
    });
  });
}
