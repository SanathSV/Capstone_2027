import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for the third-party tokens in `team_integrations`.
 *
 * A GitHub PAT or a Jira API token is a bearer credential for someone's whole
 * organisation, so it never sits in the database in plaintext. AES-256-GCM
 * gives us confidentiality and tamper-detection in one pass; the stored string
 * is a self-describing envelope so the key or algorithm can be rotated later
 * without guessing what an old row contains:
 *
 *     v1.<iv-base64>.<authTag-base64>.<ciphertext-base64>
 */

const VERSION = "v1";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.ASTRA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ASTRA_ENCRYPTION_KEY is not set. Generate one with `npm run keygen` " +
        "and put it in .env.local — integration tokens cannot be stored without it.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ASTRA_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). ` +
        "Generate a fresh one with `npm run keygen`.",
    );
  }

  cachedKey = key;
  return key;
}

/** Returns the storable envelope, or null for an empty/absent secret. */
export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  const trimmed = plaintext.trim();
  if (!trimmed) return null;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(trimmed, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Reverses `encryptSecret`. Throws on a corrupted or key-mismatched envelope —
 * a silent null here would look exactly like "this team has no GitHub token",
 * and the pre-context run would report a missing integration instead of a
 * misconfigured key.
 */
export function decryptSecret(envelope: string | null | undefined): string | null {
  if (!envelope) return null;

  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error(
      "Stored credential is not a recognised Astra envelope. It was probably " +
        "written directly into the database instead of through the app.",
    );
  }

  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "Could not decrypt a stored credential. ASTRA_ENCRYPTION_KEY has most " +
        "likely changed — re-enter the team's tokens to re-encrypt them.",
    );
  }
}

/**
 * Constant-time compare, for anywhere we check a caller-supplied token against
 * a stored one. Kept here so there is one obvious place to reach for.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True when the key is configured and well-formed. Used by health checks. */
export function encryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}
