/** Thin wrapper around the Astra backend. Feature calls go in src/lib/*.ts. */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  if (!res.ok) {
    throw new Error(`Astra API ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}
