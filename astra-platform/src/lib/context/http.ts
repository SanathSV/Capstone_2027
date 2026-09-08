/**
 * The one HTTP client the context engine uses.
 *
 * Every outbound call in this directory goes through `fetchJson`, which exists
 * to make three guarantees that matter when a "Generate Pre-Context" click
 * fans out to three third-party APIs at once:
 *
 *  1. It always returns, and quickly. A hung GitHub connection must not leave
 *     the button spinning forever, so every request carries its own timeout.
 *  2. Transient failures are retried, permanent ones are not. Retrying a 401
 *     just burns the rate limit and delays the error the user needs to see.
 *  3. Failures carry a message a human can act on, not "fetch failed".
 */

export class IntegrationError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;

/** 429 and 5xx are worth another go; 4xx means we are asking wrongly. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function explain(source: string, status: number, body: string): string {
  const snippet = body.slice(0, 300).replace(/\s+/g, " ").trim();
  switch (status) {
    case 401:
      return `${source} rejected the credentials (401). The token is wrong, expired, or revoked.`;
    case 403:
      return `${source} refused the request (403). The token is missing a scope, or you are rate limited. ${snippet}`;
    case 404:
      return `${source} could not find that resource (404). Check the repository URL / project key.`;
    case 429:
      return `${source} is rate limiting Astra (429). Try again in a minute.`;
    default:
      return `${source} returned ${status}. ${snippet}`;
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** A 404 is often "no active sprint" rather than an error worth failing on. */
  allowNotFound?: boolean;
  source: string;
}

export async function fetchJson<T>(
  url: string,
  options: FetchOptions,
): Promise<T | null> {
  const { source, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", ...headers },
        signal: controller.signal,
        // These are per-click reads of live sprint state; a cached answer would
        // defeat the point of pressing the button.
        cache: "no-store",
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      if (response.status === 404 && options.allowNotFound) return null;

      const body = await response.text().catch(() => "");
      const error = new IntegrationError(
        source,
        explain(source, response.status, body),
        response.status,
      );

      if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof IntegrationError) {
        if (error.status && !isRetryable(error.status)) throw error;
        lastError = error;
      } else if ((error as Error).name === "AbortError") {
        lastError = new IntegrationError(
          source,
          `${source} did not respond within ${timeoutMs / 1000}s.`,
        );
      } else {
        lastError = new IntegrationError(
          source,
          `Could not reach ${source}: ${(error as Error).message}`,
        );
      }
      if (attempt === MAX_ATTEMPTS) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    // 250ms, 500ms — enough to clear a blip without making the user wait.
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }

  throw lastError ?? new IntegrationError(source, `${source} failed.`);
}

/** Basic auth header, which is how Jira Cloud takes an API token. */
export function basicAuth(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}
