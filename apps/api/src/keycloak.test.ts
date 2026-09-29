import assert from "node:assert/strict";
import test from "node:test";
import type { Config } from "./config.js";
import { AuthError, introspectAdmin, rolesFromIntrospection } from "./keycloak.js";

const config: Config = {
  bind: "127.0.0.1",
  port: 8080,
  appOrigin: "https://maps.example.test",
  keycloakBaseUrl: "https://id.example.test",
  keycloakRealm: "operations",
  keycloakClientId: "dcgeomaps",
  keycloakClientSecret: "secret",
  keycloakRequiredRole: "role_dcgeomaps_admin",
  workerUrl: "http://worker:8788",
  workerSharedSecret: "x".repeat(32),
  basemapManifestUrl: "/basemap/active.json",
};

test("combines realm and client roles without broadening access", () => {
  const roles = rolesFromIntrospection(
    {
      realm_access: { roles: ["role_dcgeomaps_admin", "generic-admin"] },
      resource_access: { dcgeomaps: { roles: ["map.read", "role_dcgeomaps_admin"] } },
    },
    "dcgeomaps",
  );
  assert.deepEqual(roles, ["role_dcgeomaps_admin", "generic-admin", "map.read"]);
});

test("ignores malformed and unrelated client roles", () => {
  const roles = rolesFromIntrospection(
    {
      realm_access: { roles: "role_dcgeomaps_admin" },
      resource_access: { another: { roles: ["role_dcgeomaps_admin"] } },
    },
    "dcgeomaps",
  );
  assert.deepEqual(roles, []);
});

test("rejects a valid token that lacks the exact administrator role", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        active: true,
        sub: "operator-1",
        preferred_username: "operator",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://id.example.test/realms/operations",
        client_id: "dcgeomaps",
        realm_access: { roles: ["admin", "role_otherapp_admin"] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    await assert.rejects(
      introspectAdmin(config, "token"),
      (cause: unknown) => cause instanceof AuthError && cause.status === 403,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("accepts an active token with the exact administrator role", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        active: true,
        sub: "operator-1",
        preferred_username: "operator",
        exp: Math.floor(Date.now() / 1000) + 300,
        iss: "https://id.example.test/realms/operations",
        azp: "dcgeomaps",
        resource_access: { dcgeomaps: { roles: ["role_dcgeomaps_admin"] } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  try {
    const identity = await introspectAdmin(config, "token");
    assert.equal(identity.username, "operator");
    assert.deepEqual(identity.roles, ["role_dcgeomaps_admin"]);
  } finally {
    globalThis.fetch = original;
  }
});
