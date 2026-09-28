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

/**
 * GitHub answers a fine-grained PAT that lacks a permission with a 403 reading
 * "Resource not accessible by personal access token" — the same sentence
 * whichever permission is missing, and it never names the one you need. Since
 * each endpoint maps to exactly one permission, the call site tells us which.
 */
const GITHUB_PERMISSION_HINT: Record<string, string> = {
  "the repository": 'the token needs "Metadata: Read-only" and access to this repository',
  "the pull request list": 'the token needs "Pull requests: Read-only"',
  "the commit history": 'the token needs "Contents: Read-only"',
};

function explain(
  source: string,
  status: number,
  body: string,
  resource?: string,
): string {
  const snippet = body.slice(0, 300).replace(/\s+/g, " ").trim();
  const what = resource ? ` while reading ${resource}` : "";

  switch (status) {
    case 401:
      return `${source} rejected the credentials (401)${what}. The token is wrong, expired, or revoked.`;

    case 403: {
      // The fine-grained-PAT case, which is a permissions problem and not a
      // rate limit — conflating the two sends people to wait it out.
      if (/not accessible by (personal access token|integration)/i.test(body)) {
        const hint = resource ? GITHUB_PERMISSION_HINT[resource] : undefined;
        return (
          `${source} refused to read ${resource ?? "that resource"} (403): the token ` +
          `does not carry the required permission. ` +
          (hint ? `Specifically, ${hint}. ` : "") +
          "Edit the token under Developer settings -> Fine-grained tokens, set that " +
          "permission to Read-only, and save. If the repository belongs to an " +
          "organisation, the org must also allow fine-grained tokens and an owner may " +
          "need to approve this one."
        );
      }
      if (/rate limit/i.test(body)) {
        return `${source} is rate limiting Astra (403)${what}. Try again shortly.`;
      }
      if (/saml|sso/i.test(body)) {
        return `${source} refused the request (403)${what}: the token is not authorised for the organisation. Open the token's settings and click "Configure SSO".`;
      }
      return `${source} refused the request (403)${what}. ${snippet}`;
    }

    case 404:
      return `${source} could not find ${resource ?? "that resource"} (404). Check the repository URL / project key — a fine-grained token also returns 404 for a repository it was not granted access to.`;

    case 429:
      return `${source} is rate limiting Astra (429)${what}. Try again in a minute.`;

    default:
      return `${source} returned ${status}${what}. ${snippet}`;
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** A 404 is often "no active sprint" rather than an error worth failing on. */
  allowNotFound?: boolean;
  source: string;
  /**
   * What this call is reading, in words — "the pull request list". It goes into
   * the error message, which is the difference between "GitHub refused the
   * request" and a sentence naming the setting to change.
   */
  resource?: string;
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
        explain(source, response.status, body, options.resource),
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
