import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  ApiKeyError,
  ApiKeyStore,
  extractApiKey,
  type PublicApiKey,
} from "./api-key-store.js";
import type { Config } from "./config.js";
import {
  AuthError,
  passwordGrant,
  refreshGrant,
  revokeTokens,
  verifyAdminToken,
  type AdminIdentity,
} from "./keycloak.js";
import {
  integrationDocument,
  integrationStyle,
  type WorkerIntegrationStatus,
} from "./integration.js";
import { WorkerError, workerRequest } from "./worker-client.js";

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminIdentity;
    integrationKey?: PublicApiKey;
  }
}

type Credentials = { username?: unknown; password?: unknown };
type RefreshBody = { refresh_token?: unknown };
type LogoutBody = { access_token?: unknown; refresh_token?: unknown };
type CreateKeyBody = {
  name?: unknown;
  allowed_origins?: unknown;
  rate_limit_per_minute?: unknown;
  expires_at?: unknown;
};

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function error(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

function bearer(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : null;
}

function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkLoginLimit(request: FastifyRequest): void {
  const now = Date.now();
  const key = request.ip;
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > 10) throw new AuthError(429, "rate_limited", "Too many sign-in attempts. Try again shortly.");
}

export function buildApp(config: Config) {
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024, trustProxy: false });
  const keyStore = new ApiKeyStore(config.integrationDataPath);

  app.setErrorHandler((cause, _request, reply) => {
    if (cause instanceof AuthError) return error(reply, cause.status, cause.code, cause.message);
    if (cause instanceof ApiKeyError) return error(reply, cause.status, cause.code, cause.message);
    if (cause instanceof WorkerError) return error(reply, cause.status, "worker_error", cause.message);
    app.log.error(cause);
    return error(reply, 500, "internal_error", "The request could not be completed.");
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(request);
    if (!token) return error(reply, 401, "unauthenticated", "Sign in to continue.");
    request.admin = await verifyAdminToken(config, token);
  };

  const authorizeApiKey = async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = extractApiKey(request.headers);
    if (!secret) return error(reply, 401, "api_key_required", "Provide an integration API key in X-API-Key.");
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    const authorized = await keyStore.authenticate(secret, {
      ...(origin ? { origin } : {}),
      ip: request.ip,
    });
    request.integrationKey = authorized.key;
    if (origin) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-expose-headers", "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset");
      reply.header("vary", "Origin");
    }
    reply.header("x-ratelimit-limit", String(authorized.key.rate_limit_per_minute));
    reply.header("x-ratelimit-remaining", String(authorized.remaining));
    reply.header("x-ratelimit-reset", String(authorized.resetAt));
  };

  app.addHook("onClose", async () => keyStore.flush());

  app.get("/health", async () => ({ status: "ok", service: "dc-geomap-api" }));
  app.get("/api/v1/integration/authorize", async (request, reply) => {
    const workerSecret = request.headers["x-dcgeomap-worker-secret"];
    if (typeof workerSecret === "string" && constantEqual(workerSecret, config.workerSharedSecret)) {
      return reply.code(204).send();
    }
    const apiKey = extractApiKey(request.headers);
    if (apiKey) {
      await authorizeApiKey(request, reply);
      return reply.code(204).send();
    }
    const token = bearer(request);
    if (token) {
      await verifyAdminToken(config, token);
      return reply.code(204).send();
    }
    return error(reply, 401, "unauthenticated", "A Keycloak session or integration API key is required.");
  });

  app.get("/api/v1/integration", { preHandler: authorizeApiKey }, async (_request, reply) => {
    const status = await workerRequest<WorkerIntegrationStatus>(config, "/v1/status");
    reply.header("cache-control", "private, max-age=30");
    return integrationDocument(config, status);
  });
  app.get("/api/v1/integration/style.json", { preHandler: authorizeApiKey }, async (_request, reply) => {
    const status = await workerRequest<WorkerIntegrationStatus>(config, "/v1/status");
    const style = integrationStyle(config, status);
    if (!style) {
      return error(
        reply,
        503,
        "basemap_not_ready",
        "The first Philippines basemap build has not been published yet.",
      );
    }
    reply.header("cache-control", "private, max-age=30");
    return style;
  });
  app.get("/api/v1/auth/config", async () => ({
    enabled: true,
    required_role: config.keycloakRequiredRole,
    client_id: config.keycloakClientId,
  }));

  app.post<{ Body: Credentials }>("/api/v1/auth/login", async (request, reply) => {
    checkLoginLimit(request);
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!username || !password || username.length > 254 || password.length > 2048) {
      return error(reply, 400, "invalid_input", "Enter a valid username and password.");
    }
    const tokens = await passwordGrant(config, username, password);
    try {
      await verifyAdminToken(config, tokens.access_token);
    } catch (cause) {
      await revokeTokens(config, [tokens.access_token, tokens.refresh_token ?? ""]);
      throw cause;
    }
    loginAttempts.delete(request.ip);
    return tokens;
  });

  app.post<{ Body: RefreshBody }>("/api/v1/auth/refresh", async (request, reply) => {
    const refreshToken = typeof request.body?.refresh_token === "string" ? request.body.refresh_token : "";
    if (!refreshToken) return error(reply, 400, "invalid_input", "A refresh token is required.");
    const tokens = await refreshGrant(config, refreshToken);
    try {
      await verifyAdminToken(config, tokens.access_token);
    } catch (cause) {
      await revokeTokens(config, [tokens.access_token, tokens.refresh_token ?? refreshToken]);
      throw cause;
    }
    return tokens;
  });

  app.post<{ Body: LogoutBody }>("/api/v1/auth/logout", async (request, reply) => {
    const tokens = [request.body?.access_token, request.body?.refresh_token].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    await revokeTokens(config, tokens);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", { preHandler: requireAdmin }, async (request) => ({
    username: request.admin!.username,
    roles: request.admin!.roles,
  }));

  app.get("/api/v1/integration/keys", { preHandler: requireAdmin }, async () => ({
    keys: await keyStore.list(),
  }));

  app.post<{ Body: CreateKeyBody }>(
    "/api/v1/integration/keys",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const name = typeof request.body?.name === "string" ? request.body.name : "";
      const rate = request.body?.rate_limit_per_minute == null
        ? undefined
        : Number(request.body.rate_limit_per_minute);
      const expiresAt = request.body?.expires_at == null || request.body.expires_at === ""
        ? null
        : typeof request.body.expires_at === "string" ? request.body.expires_at : "invalid";
      const created = await keyStore.create({
        name,
        allowedOrigins: request.body?.allowed_origins,
        ...(rate === undefined ? {} : { rateLimitPerMinute: rate }),
        expiresAt,
        actor: request.admin!.username,
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(created);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/integration/keys/:id/revoke",
    { preHandler: requireAdmin },
    async (request) => ({ key: await keyStore.revoke(request.params.id, request.admin!.username) }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/integration/keys/:id/rotate",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const rotated = await keyStore.rotate(request.params.id, request.admin!.username);
      reply.header("cache-control", "no-store");
      return rotated;
    },
  );

  app.get("/api/v1/runtime-config", { preHandler: requireAdmin }, async () => ({
    basemap_manifest_url: config.basemapManifestUrl,
    max_zoom: 22,
    native_max_zoom: 15,
  }));

  app.get("/api/v1/basemap/status", { preHandler: requireAdmin }, async () =>
    workerRequest(config, "/v1/status"),
  );
  app.get<{ Querystring: { tail?: string } }>(
    "/api/v1/basemap/logs",
    { preHandler: requireAdmin },
    async (request) => {
      const tail = Math.min(Math.max(Number(request.query.tail ?? 300) || 300, 1), 5000);
      return workerRequest(config, `/v1/logs?tail=${tail}`);
    },
  );
  app.get("/api/v1/basemap/audit", { preHandler: requireAdmin }, async () =>
    workerRequest(config, "/v1/audit"),
  );

  for (const action of ["check", "update", "rebuild", "cancel", "validate", "rollback"] as const) {
    app.post(`/api/v1/basemap/${action}`, { preHandler: requireAdmin }, async (request) =>
      workerRequest(config, `/v1/actions/${action}`, {
        method: "POST",
        actor: request.admin!.username,
      }),
    );
  }

  return app;
}
