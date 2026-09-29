# AI integration guide

DC Geomap is a basemap operations service, not a general GIS feature or geocoding API. An AI agent should use its HTTP interface only to inspect or operate the Philippines basemap, and only after the human operator has authorized the action.

## Safety rules for an AI client

1. Treat `GET` status, logs, and audit requests as read-only.
2. Never call update, rebuild, cancellation, validation, or rollback endpoints unless the operator explicitly requests that action.
3. Never request or expose `KEYCLOAK_CLIENT_SECRET` or `WORKER_SHARED_SECRET`.
4. Authenticate as a real authorized Keycloak user. The exact `role_dcgeomaps_admin` role is mandatory.
5. Keep the work geographically limited to the Geofabrik Philippines extract. Do not substitute a planet file or another country URL.
6. Never introduce `tile.openstreetmap.org` as a fallback.
7. Poll `/api/v1/basemap/status` after starting a job; do not start a second operation while status is queued, running, or cancelling.
8. Report failures without activating or deleting the current basemap. The worker already preserves it.
9. Confirm OSM attribution remains visible in any new map view.

## Recommended sequence

For a user asking “Is the basemap current?”:

1. `GET /api/v1/basemap/status`.
2. Summarize active version, OSM timestamp, last check, last success/failure, worker state, free disk, and next schedule.
3. If the user explicitly asks to check upstream, `POST /api/v1/basemap/check`, then poll status.
4. Do not turn a check request into an update.

For a user explicitly asking to update:

1. Read status and verify no current operation.
2. Warn if free disk is near the configured floor.
3. `POST /api/v1/basemap/update` for the normal incremental-preferred workflow, or `/rebuild` only when the user explicitly requests a fresh/full rebuild.
4. Poll status until idle, then report the new active version or exact failure.

For rollback, identify both active and previous versions first and repeat the target version to the user before calling `/rollback`.

The complete endpoint and response shapes are in [api.md](api.md).
