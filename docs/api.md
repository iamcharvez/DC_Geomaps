# HTTP API reference

All JSON responses use UTF-8. Protected endpoints require `Authorization: Bearer <Keycloak access token>`. Errors use:

```json
{"error":{"code":"machine_code","message":"Human-readable message"}}
```

The worker API is intentionally undocumented as a public interface and is reachable only inside Compose.

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

Protected. Returns service health, active and previous manifests, source state, current job/progress, last check/success/failure, disk capacity, schedule, and zoom limits.

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

## Public basemap files

### `GET /basemap/active.json`

No-cache discovery manifest:

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

Safe serving status without paths, checksums, logs, or credentials.

### `GET|HEAD /basemap/philippines-<version>.pmtiles`

Immutable PMTiles archive. Supports byte ranges, ETag, and Last-Modified through Caddy. CORS is restricted to `BASEMAP_ALLOWED_ORIGIN`. Directory listing is disabled.
