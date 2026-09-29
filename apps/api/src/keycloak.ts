import type { Config } from "./config.js";

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  token_type: string;
};

export type AdminIdentity = {
  subject: string;
  username: string;
  roles: string[];
};

type Introspection = {
  active?: boolean;
  sub?: string;
  preferred_username?: string;
  username?: string;
  exp?: number;
  iss?: string;
  client_id?: string;
  azp?: string;
  realm_access?: { roles?: unknown };
  resource_access?: Record<string, { roles?: unknown }>;
};

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function oidc(config: Config, path: string): string {
  return `${config.keycloakBaseUrl}/realms/${encodeURIComponent(config.keycloakRealm)}/protocol/openid-connect/${path}`;
}

function clientFields(config: Config): URLSearchParams {
  return new URLSearchParams({
    client_id: config.keycloakClientId,
    client_secret: config.keycloakClientSecret,
  });
}

async function keycloakForm<T>(url: string, body: URLSearchParams): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new AuthError(503, "identity_unavailable", "The identity service is unavailable.");
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new AuthError(401, "invalid_credentials", "The username or password was not accepted.");
    }
    throw new AuthError(503, "identity_unavailable", "The identity service could not complete the request.");
  }
  return (await response.json()) as T;
}

export async function passwordGrant(config: Config, username: string, password: string) {
  const body = clientFields(config);
  body.set("grant_type", "password");
  body.set("username", username);
  body.set("password", password);
  body.set("scope", "openid");
  return keycloakForm<TokenResponse>(oidc(config, "token"), body);
}

export async function refreshGrant(config: Config, refreshToken: string) {
  const body = clientFields(config);
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);
  return keycloakForm<TokenResponse>(oidc(config, "token"), body);
}

export function rolesFromIntrospection(data: Introspection, clientId: string): string[] {
  const realm = Array.isArray(data.realm_access?.roles) ? data.realm_access.roles : [];
  const client = Array.isArray(data.resource_access?.[clientId]?.roles)
    ? data.resource_access[clientId].roles
    : [];
  return [...new Set([...realm, ...client].filter((role): role is string => typeof role === "string"))];
}

export async function introspectAdmin(config: Config, token: string): Promise<AdminIdentity> {
  const body = clientFields(config);
  body.set("token", token);
  const data = await keycloakForm<Introspection>(oidc(config, "token/introspect"), body);
  const issuer = `${config.keycloakBaseUrl}/realms/${config.keycloakRealm}`;
  const clientMatches = data.client_id === config.keycloakClientId || data.azp === config.keycloakClientId;
  if (!data.active || !data.sub || data.iss !== issuer || !clientMatches || !data.exp || data.exp <= Date.now() / 1000) {
    throw new AuthError(401, "invalid_token", "The session is no longer valid.");
  }
  const roles = rolesFromIntrospection(data, config.keycloakClientId);
  if (!roles.includes(config.keycloakRequiredRole)) {
    throw new AuthError(403, "admin_required", `Access requires ${config.keycloakRequiredRole}.`);
  }
  return {
    subject: data.sub,
    username: data.preferred_username || data.username || data.sub,
    roles,
  };
}

export async function revokeTokens(config: Config, tokens: string[]): Promise<void> {
  await Promise.allSettled(
    tokens.filter(Boolean).map(async (token) => {
      const body = clientFields(config);
      body.set("token", token);
      await fetch(oidc(config, "revoke"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(8_000),
      });
    }),
  );
}

