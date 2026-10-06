import { createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
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

type TokenHeader = {
  alg?: unknown;
  kid?: unknown;
};

export type TokenClaims = {
  sub?: unknown;
  preferred_username?: unknown;
  username?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iss?: unknown;
  client_id?: unknown;
  azp?: unknown;
  realm_access?: { roles?: unknown };
  resource_access?: Record<string, { roles?: unknown }>;
};

type KeycloakJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
};

type Jwks = {
  keys?: unknown;
};

type CachedJwks = {
  expiresAt: number;
  keys: KeycloakJwk[];
};

const JWKS_CACHE_MS = 5 * 60_000;
const jwksCache = new Map<string, CachedJwks>();

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function realmUrl(config: Config): string {
  return `${config.keycloakBaseUrl}/realms/${encodeURIComponent(config.keycloakRealm)}`;
}

function oidc(config: Config, path: string): string {
  return `${realmUrl(config)}/protocol/openid-connect/${path}`;
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

export function rolesFromToken(data: TokenClaims, clientId: string): string[] {
  const realm = Array.isArray(data.realm_access?.roles) ? data.realm_access.roles : [];
  const client = Array.isArray(data.resource_access?.[clientId]?.roles)
    ? data.resource_access[clientId].roles
    : [];
  return [...new Set([...realm, ...client].filter((role): role is string => typeof role === "string"))];
}

function invalidToken(): AuthError {
  return new AuthError(401, "invalid_token", "The session is no longer valid.");
}

function decodePart<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw invalidToken();
  }
}

function parseToken(token: string): {
  header: TokenHeader;
  claims: TokenClaims;
  signingInput: Buffer;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw invalidToken();
  const header = decodePart<TokenHeader>(parts[0]);
  const claims = decodePart<TokenClaims>(parts[1]);
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw invalidToken();
  return {
    header,
    claims,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature: Buffer.from(parts[2], "base64url"),
  };
}

async function loadJwks(config: Config, forceRefresh = false): Promise<KeycloakJwk[]> {
  const url = oidc(config, "certs");
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  } catch {
    throw new AuthError(503, "identity_unavailable", "The identity service is unavailable.");
  }
  if (!response.ok) {
    throw new AuthError(503, "identity_unavailable", "The identity service could not provide signing keys.");
  }

  let data: Jwks;
  try {
    data = (await response.json()) as Jwks;
  } catch {
    throw new AuthError(503, "identity_unavailable", "The identity service returned invalid signing keys.");
  }
  if (!Array.isArray(data.keys)) {
    throw new AuthError(503, "identity_unavailable", "The identity service returned invalid signing keys.");
  }

  const keys = data.keys.filter(
    (key): key is KeycloakJwk => Boolean(key && typeof key === "object" && (key as KeycloakJwk).kty === "RSA"),
  );
  if (keys.length === 0) {
    throw new AuthError(503, "identity_unavailable", "The identity service returned no usable signing keys.");
  }
  jwksCache.set(url, { expiresAt: Date.now() + JWKS_CACHE_MS, keys });
  return keys;
}

function signingKey(keys: KeycloakJwk[], kid: string): KeycloakJwk | undefined {
  return keys.find(
    (key) => key.kid === kid && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"),
  );
}

export async function verifyAdminToken(config: Config, token: string): Promise<AdminIdentity> {
  const parsed = parseToken(token);
  if (parsed.header.alg !== "RS256" || typeof parsed.header.kid !== "string" || !parsed.header.kid) {
    throw invalidToken();
  }

  let keys = await loadJwks(config);
  let jwk = signingKey(keys, parsed.header.kid);
  if (!jwk) {
    // Keycloak may have rotated its signing key before the short cache expired.
    keys = await loadJwks(config, true);
    jwk = signingKey(keys, parsed.header.kid);
  }
  if (!jwk) throw invalidToken();

  let signatureValid = false;
  try {
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    signatureValid = verifySignature("RSA-SHA256", parsed.signingInput, publicKey, parsed.signature);
  } catch {
    throw invalidToken();
  }
  if (!signatureValid) throw invalidToken();

  const now = Math.floor(Date.now() / 1000);
  const claims = parsed.claims;
  const issuer = realmUrl(config);
  const clientMatches = claims.client_id === config.keycloakClientId || claims.azp === config.keycloakClientId;
  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    claims.iss !== issuer ||
    !clientMatches ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now)
  ) {
    throw invalidToken();
  }

  const roles = rolesFromToken(claims, config.keycloakClientId);
  if (!roles.includes(config.keycloakRequiredRole)) {
    throw new AuthError(403, "admin_required", `Access requires ${config.keycloakRequiredRole}.`);
  }
  return {
    subject: claims.sub,
    username:
      (typeof claims.preferred_username === "string" && claims.preferred_username) ||
      (typeof claims.username === "string" && claims.username) ||
      claims.sub,
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

export function clearJwksCacheForTests(): void {
  jwksCache.clear();
}
