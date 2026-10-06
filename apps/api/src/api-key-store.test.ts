import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiKeyError, ApiKeyStore, extractApiKey, normalizeOrigins } from "./api-key-store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dc-geomap-keys-"));
  const path = join(directory, "keys.json");
  return { directory, path, store: new ApiKeyStore(path) };
}

test("creates a high-entropy key and stores only its hash", async () => {
  const { directory, path, store } = await fixture();
  try {
    const created = await store.create({
      name: "DC Field Ops",
      allowedOrigins: ["https://field.example.test"],
      rateLimitPerMinute: 900,
      actor: "operator",
    });
    assert.match(created.api_key, /^dcgm_[a-f0-9]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.key.name, "DC Field Ops");
    assert.equal(created.key.status, "active");
    assert.equal(created.key.rate_limit_per_minute, 900);
    const stored = await readFile(path, "utf8");
    assert.doesNotMatch(stored, new RegExp(created.api_key));
    assert.match(stored, /"secret_hash": "[a-f0-9]{64}"/);
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces exact browser origins while allowing the configured origin", async () => {
  const { directory, store } = await fixture();
  try {
    const created = await store.create({
      name: "Restricted",
      allowedOrigins: ["https://allowed.example.test"],
      actor: "operator",
    });
    await assert.rejects(
      store.authenticate(created.api_key, { origin: "https://blocked.example.test" }),
      (cause: unknown) => cause instanceof ApiKeyError && cause.code === "origin_not_allowed",
    );
    const result = await store.authenticate(created.api_key, { origin: "https://allowed.example.test" });
    assert.equal(result.key.id, created.key.id);
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces per-key rate limits", async () => {
  const { directory, store } = await fixture();
  try {
    const created = await store.create({ name: "Limited", rateLimitPerMinute: 60, actor: "operator" });
    for (let index = 0; index < 60; index += 1) await store.authenticate(created.api_key);
    await assert.rejects(
      store.authenticate(created.api_key),
      (cause: unknown) => cause instanceof ApiKeyError && cause.status === 429,
    );
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revocation immediately denies access and rotation returns a new one-time secret", async () => {
  const { directory, store } = await fixture();
  try {
    const original = await store.create({ name: "Rotated", actor: "operator" });
    const replacement = await store.rotate(original.key.id, "operator");
    assert.notEqual(replacement.api_key, original.api_key);
    await assert.rejects(
      store.authenticate(original.api_key),
      (cause: unknown) => cause instanceof ApiKeyError && cause.code === "api_key_revoked",
    );
    await store.authenticate(replacement.api_key);
    const keys = await store.list();
    assert.equal(keys.find((item) => item.id === original.key.id)?.status, "revoked");
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects expired keys", async () => {
  const { directory, path, store } = await fixture();
  try {
    const created = await store.create({
      name: "Expiring",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      actor: "operator",
    });
    const document = JSON.parse(await readFile(path, "utf8"));
    document.keys[0].expires_at = new Date(Date.now() - 1_000).toISOString();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(document)));
    const reloaded = new ApiKeyStore(path);
    await assert.rejects(
      reloaded.authenticate(created.api_key),
      (cause: unknown) => cause instanceof ApiKeyError && cause.code === "api_key_expired",
    );
  } finally {
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates origins and extracts supported API key headers", () => {
  assert.deepEqual(normalizeOrigins(["https://one.example.test", "https://one.example.test"]), [
    "https://one.example.test",
  ]);
  assert.throws(() => normalizeOrigins(["https://example.test/path"]), ApiKeyError);
  assert.equal(extractApiKey({ "x-api-key": "dcgm_id_secret" }), "dcgm_id_secret");
  assert.equal(extractApiKey({ authorization: "ApiKey dcgm_id_secret" }), "dcgm_id_secret");
  assert.equal(extractApiKey({ authorization: "Bearer keycloak-token" }), null);
});
