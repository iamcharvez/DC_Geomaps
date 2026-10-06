import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { integrationDocument, integrationStyle, type WorkerIntegrationStatus } from "./integration.js";

const config: Config = {
  bind: "127.0.0.1",
  port: 8080,
  appOrigin: "https://maps.example.test:8443",
  keycloakBaseUrl: "https://id.example.test",
  keycloakRealm: "operations",
  keycloakClientId: "dcgeomaps",
  keycloakClientSecret: "do-not-expose",
  keycloakRequiredRole: "role_dcgeomaps_admin",
  workerUrl: "http://worker:8788",
  workerSharedSecret: "x".repeat(32),
  basemapManifestUrl: "/basemap/active.json",
};

const ready: WorkerIntegrationStatus = {
  active: {
    version: "2026-10-06-abc123",
    url: "/basemap/philippines-2026-10-06-abc123.pmtiles",
    osm_timestamp: "2026-10-06T00:00:00Z",
    source_checksum: "source-sha",
    pmtiles_checksum: "archive-sha",
    archive_size: 123456,
    native_max_zoom: 15,
    activated_at: "2026-10-06T02:00:00Z",
  },
  job: { status: "idle", stage: null, progress: 0 },
};

test("publishes an absolute, sanitized integration contract", () => {
  const document = integrationDocument(config, ready);
  assert.equal(document.status, "ready");
  assert.equal(document.style_url, "https://maps.example.test:8443/api/v1/integration/style.json");
  assert.equal(
    document.active?.pmtiles_url,
    "https://maps.example.test:8443/basemap/philippines-2026-10-06-abc123.pmtiles",
  );
  assert.equal(document.display_max_zoom, 22);
  assert.doesNotMatch(JSON.stringify(document), /do-not-expose|worker:8788|role_dcgeomaps_admin/);
});

test("returns a PMTiles MapLibre style with native z15 and OSM attribution", () => {
  const style = integrationStyle(config, ready);
  assert.ok(style);
  const serialized = JSON.stringify(style);
  assert.match(serialized, /pmtiles:\/\/https:\/\/maps\.example\.test:8443\/basemap\//);
  assert.match(serialized, /OpenStreetMap contributors/);
  assert.doesNotMatch(serialized, /tile\.openstreetmap\.org/);
  const source = (style.sources as Record<string, { maxzoom: number }>).openmaptiles;
  assert.equal(source.maxzoom, 15);
});

test("does not publish a style before the first archive is active", () => {
  const waiting: WorkerIntegrationStatus = {
    active: null,
    job: { status: "running", stage: "downloading", progress: 18 },
  };
  const document = integrationDocument(config, waiting);
  assert.equal(document.status, "building");
  assert.deepEqual(document.build, { status: "running", stage: "downloading", progress: 18 });
  assert.equal(integrationStyle(config, waiting), null);
});

test("serves discovery without an administrator token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "http://worker:8788/v1/status");
    return new Response(JSON.stringify(ready), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const app = buildApp(config);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/integration" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=30");
    assert.equal(response.json().active.version, "2026-10-06-abc123");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("returns a clear 503 style response before initial publication", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ active: null, job: { status: "idle" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const app = buildApp(config);
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/integration/style.json" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "basemap_not_ready");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});
