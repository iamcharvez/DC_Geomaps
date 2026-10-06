import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import type { Config } from "./config.js";
import {
  AuthError,
  clearJwksCacheForTests,
  rolesFromToken,
  type TokenClaims,
  verifyAdminToken,
} from "./keycloak.js";

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

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};

function accessToken(overrides: Partial<TokenClaims> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      sub: "operator-1",
      preferred_username: "operator",
      exp: Math.floor(Date.now() / 1000) + 300,
      iss: "https://id.example.test/realms/operations",
      azp: "dcgeomaps",
      realm_access: { roles: ["role_dcgeomaps_admin"] },
      ...overrides,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function mockJwks(): () => void {
  clearJwksCacheForTests();
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/protocol\/openid-connect\/certs$/);
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return () => {
    globalThis.fetch = original;
    clearJwksCacheForTests();
  };
}

test("combines realm and client roles without broadening access", () => {
  const roles = rolesFromToken(
    {
      realm_access: { roles: ["role_dcgeomaps_admin", "generic-admin"] },
      resource_access: { dcgeomaps: { roles: ["map.read", "role_dcgeomaps_admin"] } },
    },
    "dcgeomaps",
  );
  assert.deepEqual(roles, ["role_dcgeomaps_admin", "generic-admin", "map.read"]);
});

test("ignores malformed and unrelated client roles", () => {
  const roles = rolesFromToken(
    {
      realm_access: { roles: "role_dcgeomaps_admin" },
      resource_access: { another: { roles: ["role_dcgeomaps_admin"] } },
    },
    "dcgeomaps",
  );
  assert.deepEqual(roles, []);
});

test("accepts a signed token with the exact administrator role", async () => {
  const restore = mockJwks();
  try {
    const identity = await verifyAdminToken(config, accessToken());
    assert.equal(identity.subject, "operator-1");
    assert.equal(identity.username, "operator");
    assert.deepEqual(identity.roles, ["role_dcgeomaps_admin"]);
  } finally {
    restore();
  }
});

test("rejects a valid signed token that lacks the exact administrator role", async () => {
  const restore = mockJwks();
  try {
    await assert.rejects(
      verifyAdminToken(config, accessToken({ realm_access: { roles: ["admin", "role_otherapp_admin"] } })),
      (cause: unknown) => cause instanceof AuthError && cause.status === 403,
    );
  } finally {
    restore();
  }
});

test("rejects a token issued to another client", async () => {
  const restore = mockJwks();
  try {
    await assert.rejects(
      verifyAdminToken(config, accessToken({ azp: "another-client" })),
      (cause: unknown) => cause instanceof AuthError && cause.status === 401,
    );
  } finally {
    restore();
  }
});

test("rejects an expired token", async () => {
  const restore = mockJwks();
  try {
    await assert.rejects(
      verifyAdminToken(config, accessToken({ exp: Math.floor(Date.now() / 1000) - 1 })),
      (cause: unknown) => cause instanceof AuthError && cause.status === 401,
    );
  } finally {
    restore();
  }
});

test("rejects a token with a modified signature", async () => {
  const restore = mockJwks();
  try {
    const token = accessToken();
    const [header, payload] = token.split(".");
    await assert.rejects(
      verifyAdminToken(config, `${header}.${payload}.AA`),
      (cause: unknown) => cause instanceof AuthError && cause.status === 401,
    );
  } finally {
    restore();
  }
});
