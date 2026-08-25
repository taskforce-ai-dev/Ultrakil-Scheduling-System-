/**
 * Where the access token lives.
 *
 * A tiny module of its own so `api-client` can read the token and `auth` can
 * write it without importing each other — the client is used by the auth
 * provider, so a direct dependency the other way would be circular.
 *
 * localStorage rather than a cookie because the API is a separate origin and
 * expects `Authorization: Bearer`, not a session cookie. That does mean the
 * token is readable by scripts on this page; acceptable for a Phase 1 pilot on
 * an internal tool, and worth revisiting before this faces the internet.
 */
const TOKEN_STORAGE_KEY = "ultrakil.manager-web.accessToken";

export function readToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    // Private browsing and some corporate policies make storage throw rather
    // than return null. Treat that as "not signed in" instead of crashing.
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Nothing useful to do — the user stays signed in for this page only.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore, as above.
  }
}
