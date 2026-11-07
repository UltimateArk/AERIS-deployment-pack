// Operator session token in localStorage. Auto-refreshed and attached to REST and WS calls.
// 401 fires aeris:unauthorized for login redirect.
const API_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_API_BASE ?? "http://localhost:8081";

const KEY = "aeris.token";
const USER = "aeris.user";

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export function getToken(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function getUser(): string | null {
  try { return localStorage.getItem(USER); } catch { return null; }
}
function store(token: string, username?: string) {
  try {
    localStorage.setItem(KEY, token);
    if (username) localStorage.setItem(USER, username);
  } catch { }
}
export function clearToken() {
  try { localStorage.removeItem(KEY); } catch { }
  if (refreshTimer) clearTimeout(refreshTimer);
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export function wsUrl(base: string): string {
  const t = getToken();
  return t ? `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : base;
}

// Access tokens live 30 min. Refresh at 20 min with sliding renewal.
function scheduleRefresh(expiresMs: number) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const refreshIn = Math.max(60_000, expiresMs - 10 * 60_000);
  refreshTimer = setTimeout(refreshNow, refreshIn);
}

async function refreshNow() {
  const t = getToken();
  if (!t) return;
  try {
    const r = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { token: string; expiresMs: number };
    store(j.token);
    scheduleRefresh(j.expiresMs ?? 30 * 60_000);
  } catch {
    // Keep current token. Hard 401 returns to login.
  }
}

// One-shot refresh for 401 recovery. Returns true with a fresh token for one retry.
export async function tryRefresh(): Promise<boolean> {
  const t = getToken();
  if (!t) return false;
  try {
    const r = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { token: string; expiresMs: number };
    store(j.token);
    scheduleRefresh(j.expiresMs ?? 30 * 60_000);
    return true;
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<boolean> {
  const r = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) return false;
  const j = (await r.json()) as { token: string; expiresMs: number };
  store(j.token, username);
  scheduleRefresh(j.expiresMs ?? 30 * 60_000);
  return true;
}

// Resume refresh loop with stored token.
export function armRefreshFromStored() {
  const t = getToken();
  if (t) scheduleRefresh(30 * 60_000);
}

export function isAuthed(): boolean {
  return !!getToken();
}

export { API_BASE };
