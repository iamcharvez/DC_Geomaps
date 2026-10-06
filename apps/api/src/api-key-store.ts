import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ApiKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  secret_hash: string;
  scopes: ["basemap:read"];
  allowed_origins: string[];
  rate_limit_per_minute: number;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
  last_origin: string | null;
  request_count: number;
};

export type PublicApiKey = Omit<ApiKeyRecord, "secret_hash"> & {
  status: "active" | "expired" | "revoked";
};

type StoreDocument = { version: 1; keys: ApiKeyRecord[] };
type RateBucket = { minute: number; count: number };

export class ApiKeyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function status(record: ApiKeyRecord, now = Date.now()): PublicApiKey["status"] {
  if (record.revoked_at) return "revoked";
  if (record.expires_at && Date.parse(record.expires_at) <= now) return "expired";
  return "active";
}

function publicRecord(record: ApiKeyRecord): PublicApiKey {
  const { secret_hash: _secretHash, ...safe } = record;
  return { ...safe, status: status(record) };
}

export function normalizeOrigins(input: unknown): string[] {
  if (input == null) return ["*"];
  if (!Array.isArray(input) || input.length > 20) {
    throw new ApiKeyError(400, "invalid_origins", "Allowed origins must be an array of up to 20 origins.");
  }
  const result = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      throw new ApiKeyError(400, "invalid_origins", "Every allowed origin must be a string.");
    }
    const value = item.trim();
    if (value === "*") {
      if (input.length !== 1) throw new ApiKeyError(400, "invalid_origins", "Wildcard origin must be used alone.");
      return ["*"];
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiKeyError(400, "invalid_origins", `Invalid origin: ${value}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) {
      throw new ApiKeyError(400, "invalid_origins", `Use an exact HTTP(S) origin without a path: ${value}`);
    }
    result.add(parsed.origin);
  }
  if (!result.size) throw new ApiKeyError(400, "invalid_origins", "At least one allowed origin is required.");
  return [...result];
}

export class ApiKeyStore {
  private document: StoreDocument | null = null;
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly rates = new Map<string, RateBucket>();

  constructor(private readonly path: string) {}

  private async load(): Promise<void> {
    if (this.document) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await mkdir(dirname(this.path), { recursive: true });
        try {
          const parsed = JSON.parse(await readFile(this.path, "utf8")) as StoreDocument;
          if (parsed.version !== 1 || !Array.isArray(parsed.keys)) throw new Error("Unsupported API key store format");
          this.document = parsed;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          this.document = { version: 1, keys: [] };
          await this.persist();
        }
      })();
    }
    await this.loadPromise;
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.document, null, 2)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    await this.writeQueue;
    this.dirty = false;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.persist().catch(() => {
        this.dirty = true;
      });
    }, 5_000);
    this.flushTimer.unref();
  }

  async list(): Promise<PublicApiKey[]> {
    await this.load();
    return this.document!.keys.map(publicRecord).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async create(input: {
    name: string;
    allowedOrigins?: unknown;
    rateLimitPerMinute?: number;
    expiresAt?: string | null;
    actor: string;
  }): Promise<{ api_key: string; key: PublicApiKey }> {
    await this.load();
    const name = input.name.trim();
    if (!name || name.length > 80) throw new ApiKeyError(400, "invalid_name", "Name must be 1–80 characters.");
    const rate = input.rateLimitPerMinute ?? 1200;
    if (!Number.isInteger(rate) || rate < 60 || rate > 20_000) {
      throw new ApiKeyError(400, "invalid_rate_limit", "Rate limit must be between 60 and 20,000 requests per minute.");
    }
    let expiresAt: string | null = null;
    if (input.expiresAt) {
      const timestamp = Date.parse(input.expiresAt);
      if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
        throw new ApiKeyError(400, "invalid_expiration", "Expiration must be a future ISO date and time.");
      }
      expiresAt = new Date(timestamp).toISOString();
    }
    const id = randomUUID();
    const prefix = `dcgm_${id.slice(0, 8)}`;
    const secret = `${prefix}_${randomBytes(32).toString("base64url")}`;
    const record: ApiKeyRecord = {
      id,
      name,
      prefix,
      secret_hash: digest(secret).toString("hex"),
      scopes: ["basemap:read"],
      allowed_origins: normalizeOrigins(input.allowedOrigins),
      rate_limit_per_minute: rate,
      created_at: new Date().toISOString(),
      created_by: input.actor,
      expires_at: expiresAt,
      revoked_at: null,
      revoked_by: null,
      last_used_at: null,
      last_origin: null,
      request_count: 0,
    };
    this.document!.keys.push(record);
    await this.persist();
    return { api_key: secret, key: publicRecord(record) };
  }

  async revoke(id: string, actor: string): Promise<PublicApiKey> {
    await this.load();
    const record = this.document!.keys.find((item) => item.id === id);
    if (!record) throw new ApiKeyError(404, "key_not_found", "Integration key was not found.");
    if (!record.revoked_at) {
      record.revoked_at = new Date().toISOString();
      record.revoked_by = actor;
      await this.persist();
    }
    return publicRecord(record);
  }

  async rotate(id: string, actor: string): Promise<{ api_key: string; key: PublicApiKey }> {
    await this.load();
    const current = this.document!.keys.find((item) => item.id === id);
    if (!current) throw new ApiKeyError(404, "key_not_found", "Integration key was not found.");
    const currentStatus = status(current);
    if (currentStatus !== "active") {
      throw new ApiKeyError(409, `key_${currentStatus}`, `An ${currentStatus} key cannot be rotated.`);
    }
    const replacementId = randomUUID();
    const prefix = `dcgm_${replacementId.slice(0, 8)}`;
    const secret = `${prefix}_${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const replacement: ApiKeyRecord = {
      id: replacementId,
      name: current.name,
      prefix,
      secret_hash: digest(secret).toString("hex"),
      scopes: ["basemap:read"],
      allowed_origins: [...current.allowed_origins],
      rate_limit_per_minute: current.rate_limit_per_minute,
      created_at: now,
      created_by: actor,
      expires_at: current.expires_at,
      revoked_at: null,
      revoked_by: null,
      last_used_at: null,
      last_origin: null,
      request_count: 0,
    };
    current.revoked_at = now;
    current.revoked_by = actor;
    this.document!.keys.push(replacement);
    await this.persist();
    return { api_key: secret, key: publicRecord(replacement) };
  }

  async authenticate(
    secret: string,
    context: { origin?: string; ip?: string } = {},
  ): Promise<{ key: PublicApiKey; remaining: number; resetAt: number }> {
    await this.load();
    if (!secret.startsWith("dcgm_") || secret.length > 160) {
      throw new ApiKeyError(401, "invalid_api_key", "A valid integration API key is required.");
    }
    const candidate = digest(secret);
    const record = this.document!.keys.find((item) => {
      const stored = Buffer.from(item.secret_hash, "hex");
      return stored.length === candidate.length && timingSafeEqual(stored, candidate);
    });
    if (!record) throw new ApiKeyError(401, "invalid_api_key", "A valid integration API key is required.");
    const currentStatus = status(record);
    if (currentStatus !== "active") {
      throw new ApiKeyError(401, `api_key_${currentStatus}`, `This integration API key is ${currentStatus}.`);
    }
    if (context.origin && !record.allowed_origins.includes("*") && !record.allowed_origins.includes(context.origin)) {
      throw new ApiKeyError(403, "origin_not_allowed", "This browser origin is not allowed for the integration key.");
    }
    const minute = Math.floor(Date.now() / 60_000);
    const bucket = this.rates.get(record.id);
    const next = !bucket || bucket.minute !== minute ? { minute, count: 1 } : { minute, count: bucket.count + 1 };
    this.rates.set(record.id, next);
    if (next.count > record.rate_limit_per_minute) {
      throw new ApiKeyError(429, "rate_limited", "Integration API key rate limit exceeded.");
    }
    record.last_used_at = new Date().toISOString();
    record.last_origin = context.origin ?? null;
    record.request_count += 1;
    this.scheduleFlush();
    return {
      key: publicRecord(record),
      remaining: Math.max(0, record.rate_limit_per_minute - next.count),
      resetAt: (minute + 1) * 60,
    };
  }

  async flush(): Promise<void> {
    await this.load();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.dirty) await this.persist();
    await this.writeQueue;
  }
}

export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const explicit = headers["x-api-key"];
  if (typeof explicit === "string" && explicit) return explicit;
  const authorization = headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^(?:ApiKey|Bearer)\s+(dcgm_[A-Za-z0-9_-]+)$/i);
  return match?.[1] ?? null;
}
