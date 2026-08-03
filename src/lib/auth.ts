import { API_BASE } from './ollama';

const TOKEN_KEY = 'frio.token';
const USERNAME_KEY = 'frio.username';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getUsername(): string | null {
  return localStorage.getItem(USERNAME_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function startCloudflareOAuth(): void {
  window.location.assign(`${API_BASE}/api/auth/oauth/cloudflare/authorize`);
}

export async function exchangeOAuthCode(code: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/oauth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    let detail = 'OAuth exchange failed';
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { token: string; username: string };
  setToken(data.token);
  localStorage.setItem(USERNAME_KEY, data.username);
}

export async function checkAuth(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      clearToken();
      return false;
    }
    const data = (await res.json()) as { username?: string };
    if (data.username) localStorage.setItem(USERNAME_KEY, data.username);
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch {
      /* ignore */
    }
  }
  clearToken();
}
