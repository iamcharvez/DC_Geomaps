# HTTP API reference

All JSON responses use UTF-8. Administrative endpoints require
`Authorization: Bearer <Keycloak access token>`. External map endpoints require
`X-API-Key: <integration key>`. Errors use:

```json
{"error":{"code":"machine_code","message":"Human-readable message"}}
```

The worker API is intentionally undocumented as a public interface and is reachable only inside Compose.

## Map integration

These read-only endpoints use application keys rather than Keycloak. Each key
has a browser-origin policy, expiration, per-minute rate limit, revocation
state, and usage counters. Discovery and style responses include
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

### `GET /api/v1/integration`

Returns the stable v1 discovery contract for another application. URLs are
absolute and are derived from `APP_ORIGIN`:

```json
{
  "api_version": "v1",
  "name": "DC Geomap Philippines Basemap",
  "status": "ready",
  "coverage": "Philippines",
  "format": "PMTiles",
  "vector_schema": "OpenMapTiles",
  "native_max_zoom": 15,
  "display_max_zoom": 22,
  "manifest_url": "https://maps.example.test/basemap/active.json",
  "style_url": "https://maps.example.test/api/v1/integration/style.json",
  "active": {
    "version": "2026-10-06-abc123",
    "pmtiles_url": "https://maps.example.test/basemap/philippines-2026-10-06-abc123.pmtiles",
    "osm_timestamp": "2026-10-06T00:00:00Z",
    "archive_size": 123456789,
    "native_max_zoom": 15,
    "activated_at": "2026-10-06T02:00:00Z",
    "checksums": {
      "source_sha256": "...",
      "pmtiles_sha256": "..."
    }
  },
  "build": null
}
```

Before the initial build completes, `active` is `null`, `status` is `building`
or `waiting_for_initial_build`, and `build` contains safe progress fields.
Private paths, logs, failures, resource telemetry, credentials, and operations
are never included.

### `GET /api/v1/integration/style.json`

Returns a MapLibre Style Specification v8 document whose vector source points
to the immutable active archive using the `pmtiles://` protocol. The source has
native `maxzoom: 15`; a MapLibre map may set `maxZoom: 22` for vector overzoom.
Returns 503 with `basemap_not_ready` until the first archive is active.

## Integration key administration

All endpoints in this section require a Keycloak administrator token.

### `GET /api/v1/integration/keys`

Lists safe key metadata, status, origin policy, rate limit, expiration, last
use, and request count. Stored hashes and plaintext secrets are never returned.

### `POST /api/v1/integration/keys`

```json
{
  "name": "DC Field Ops",
  "allowed_origins": ["https://fieldops.example.com"],
  "rate_limit_per_minute": 1200,
  "expires_at": "2027-01-04T00:00:00.000Z"
}
```

Returns HTTP 201 and the plaintext `api_key` exactly once. The only scope is
`basemap:read`. Use `["*"]` only when any browser origin must be allowed.

### `POST /api/v1/integration/keys/:id/revoke`

Immediately prevents further discovery, style, manifest, and archive access.

### `POST /api/v1/integration/keys/:id/rotate`

Creates and returns a replacement secret with the same policy and immediately
revokes the old key. The replacement secret is also displayed only once.

## Health and authentication

### `GET /health`

Public API liveness check.

### `GET /api/v1/auth/config`

Public login configuration. Returns whether login is enabled, the client ID, and required role; never returns a secret or Keycloak administrative URL.

### `POST /api/v1/auth/login`

Body:

```json
{"username":"operator","password":"secret"}
```

Performs a Keycloak direct grant and immediately verifies the resulting token's signature and claims using the realm's JWKS. A token lacking `role_dcgeomaps_admin` is revoked and rejected. Login is limited to ten attempts per source IP per minute.

### `POST /api/v1/auth/refresh`

Body: `{"refresh_token":"..."}`. Exchanges and revalidates the session. The response follows Keycloak's token response shape.

### `POST /api/v1/auth/logout`

Body: `{"access_token":"...","refresh_token":"..."}`. Best-effort revocation; returns 204.

### `GET /api/v1/auth/me`

Protected. Returns the verified username and DC Geomap token roles.

### `GET /api/v1/runtime-config`

Protected. Returns the relative manifest URL and native/display maximum zooms. Production domains are never compiled into the frontend.

## Basemap status

### `GET /api/v1/basemap/status`

Protected. Returns service health, active and previous manifests, source state, transfer speed/ETA/retry progress, last check/success/failure and resolution, memory/disk safety telemetry, schedule/retry state, and zoom limits.

### `GET /api/v1/basemap/logs?tail=300`

Protected. Returns up to 5,000 recent worker log lines.

### `GET /api/v1/basemap/audit`

Protected. Returns up to 500 recent administrator/scheduler action events, newest first.

## Basemap actions

The following protected endpoints accept an empty POST body and return HTTP 202 when accepted:

- `POST /api/v1/basemap/check`
- `POST /api/v1/basemap/update`
- `POST /api/v1/basemap/rebuild`
- `POST /api/v1/basemap/cancel`
- `POST /api/v1/basemap/validate`
- `POST /api/v1/basemap/rollback`

Long operations continue in the worker. Poll status for progress. A conflicting operation returns 409. Cancellation is cooperative for downloads/checksums and terminates Planetiler, osmium, or PMTiles process groups when applicable.

## Protected basemap files

### `GET /basemap/active.json`

No-cache discovery manifest. Accepts an integration key or an administrator
Keycloak bearer token:

```json
{
  "version": "2026-09-29-a3f81c",
  "url": "/basemap/philippines-2026-09-29-a3f81c.pmtiles",
  "osm_timestamp": "2026-09-29T00:00:00Z",
  "source_checksum": "sha256...",
  "pmtiles_checksum": "sha256...",
  "archive_size": 123456789,
  "native_max_zoom": 15,
  "activated_at": "2026-09-29T03:00:00Z"
}
```

### `GET /basemap/health.json`

Safe serving status without paths, checksums, logs, or credentials. Requires the
same authorization as the manifest.

### `GET|HEAD /basemap/philippines-<version>.pmtiles`

Immutable PMTiles archive. Caddy authorizes each request through the API and
then serves the file directly with byte ranges, ETag, and Last-Modified. An
integration key uses `X-API-Key`; the built-in preview uses its Keycloak bearer
token. CORS echoes only an origin permitted by the authenticated key. Directory
listing is disabled.
