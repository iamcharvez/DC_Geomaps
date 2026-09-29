import type { TokenResponse, User } from "./types";

const refreshKey = "dcgeomap.refresh";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  config: () => request<{ enabled: boolean; required_role: string; client_id: string }>("/api/v1/auth/config"),
  login: (username: string, password: string) =>
    request<TokenResponse>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  refresh: (refreshToken: string) =>
    request<TokenResponse>("/api/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
  me: (token: string) => request<User>("/api/v1/auth/me", {}, token),
  logout: (accessToken: string, refreshToken?: string) =>
    request<void>("/api/v1/auth/logout", {
      method: "POST",
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }),
    }),
  runtime: (token: string) =>
    request<{ basemap_manifest_url: string; max_zoom: number; native_max_zoom: number }>(
      "/api/v1/runtime-config",
      {},
      token,
    ),
  get: <T>(path: string, token: string) => request<T>(path, {}, token),
  post: <T>(path: string, token: string) => request<T>(path, { method: "POST", body: "{}" }, token),
};

export function rememberRefresh(token?: string) {
  if (token) sessionStorage.setItem(refreshKey, token);
  else sessionStorage.removeItem(refreshKey);
}

export function savedRefresh() {
  return sessionStorage.getItem(refreshKey);
}

