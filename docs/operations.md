# Basemap operations

## Alternate published ports

The Compose stack does not require host port 80. Set `WEB_PORT` to any free host
port; Docker maps that port to Caddy's internal port 80. For example:

```dotenv
CADDY_SITE_ADDRESS=:80
WEB_BIND=0.0.0.0
WEB_PORT=8180
APP_ORIGIN=http://server-address:8180
BASEMAP_ALLOWED_ORIGIN=*
INTEGRATION_ALLOWED_ORIGIN=*
```

Do not change `CADDY_SITE_ADDRESS` to `:8180` for this arrangement: 8180 is the
host-side port and Caddy still listens on 80 inside the container. Set
`WEB_BIND=127.0.0.1` instead when an existing host reverse proxy will front the
service. The proxy must preserve `Range` requests and 206 responses for PMTiles.

## Initial generation

1. Confirm the host meets the configured free-space threshold and has adequate extra working capacity.
2. Start the stack and sign in as `role_dcgeomaps_admin`.
3. Select **Force full rebuild**.
4. Watch progress and logs. Planetiler also downloads and caches supporting OpenMapTiles datasets on the first run.
5. The new archive appears only after source, PMTiles, regional tile, zoom, checksum, and Caddy Range validation passes.

## Automatic updates

The worker uses the `Asia/Manila` timezone by default:

- Daily at 02:00: compare Geofabrik metadata. If unchanged, skip. If changed and an installed PBF exists, copy it to staging and run `pyosmium-up-to-date`; otherwise perform a full download.
- First Sunday monthly at 01:00: force a new full download and build even if the checksum is unchanged.
- A failed scheduled operation retries after `SCHEDULED_RETRY_MINUTES` (30 by default), up to `SCHEDULED_RETRY_MAX_ATTEMPTS` (five by default). A manual cancellation is never automatically restarted.

If another operation is active, the scheduler waits rather than starting concurrently. Scheduled retry state is persisted across worker restarts and displayed in the admin UI.

Change `TZ`, `DAILY_UPDATE_HOUR`, or `MONTHLY_REBUILD_HOUR` and recreate the worker container to alter the schedule.

## Manual controls

- **Check for updates:** metadata only; never builds.
- **Update now:** skips if unchanged, otherwise prefers replication.
- **Force full rebuild:** downloads and verifies a fresh Geofabrik PBF.
- **Cancel update:** sends termination to the active child process and cleans staging after it exits.
- **Validate active:** repeats archive, regional tile, checksum, and Caddy Range checks.
- **Roll back:** atomically points `active.json` to the retained previous archive.

Every accepted action and its terminal outcome is written to `/data/logs/audit.jsonl` with actor, time, action, outcome, and non-secret detail.

## Backup and recovery

Back up the `basemap_data` volume while no update is running. At minimum retain `/data/public`, `/data/private/state.json`, and `/data/private/source/philippines.osm.pbf`. Planetiler cache can be recreated but avoiding that download speeds recovery.

To recover on a new host, restore the volume before starting Compose. If an interrupted job was recorded, the worker marks it failed, clears staging, and retains the last active manifest/archive.

Do not run `docker compose down -v` unless intentionally deleting every source, archive, log, and rollback version.

## Monitoring and logs

- `/health` checks the API.
- `/basemap/health.json` is a safe unauthenticated serving-status document.
- The admin UI shows worker state, active/previous versions, timestamps, checksums, archive size, transfer speed, ETA, retry attempts, memory/disk headroom, schedules, and failure resolution.
- `docker compose logs --tail=200 api worker web` captures worker lifecycle and Planetiler output. Routine health/status polling is intentionally suppressed.
- Docker JSON logs rotate according to `DOCKER_LOG_MAX_SIZE` and `DOCKER_LOG_MAX_FILES`.
- Detailed build output is also stored in `/data/logs/worker.log`, rotated according to `WORKER_LOG_MAX_MB` and `WORKER_LOG_BACKUPS`, and available in **Build logs**.

## Changing maximum native zoom

The requested production value is enforced as 15. To intentionally change it, update the worker validation, environment constraint, frontend source metadata, documentation, tests, and capacity estimate together. Rebuild every archive; existing PMTiles cannot be extended in place.

## Troubleshooting

- **Insufficient disk:** free storage or increase the volume before retrying. Preflight uses the larger of `MIN_FREE_DISK_GB` and the remote PBF size multiplied by `DISK_WORKING_MULTIPLIER`. Lowering the floor does not reduce Planetiler's actual requirements.
- **Unsafe memory:** reduce `PLANETILER_JAVA_OPTS`, stop competing workloads, or increase RAM. The heap plus `MEMORY_RESERVE_MB` must fit the detected host/container limit, and at least `MIN_AVAILABLE_MEMORY_MB` must be free before work starts.
- **Network interruption:** metadata and PBF requests retry automatically. A partial PBF is retained and resumed with HTTP Range on the next attempt or operation.
- **Checksum mismatch:** the invalid partial is deleted and a clean bounded retry is attempted.
- **Replication failure:** use **Force full rebuild** to re-establish a current canonical PBF.
- **Planetiler failure:** inspect build logs for JVM memory, disk, or upstream supporting-data errors. The current basemap remains active.
- **Range failure:** verify Caddy serves the volume and no upstream proxy strips the `Range` header or converts 206 to 200.
- **Cannot sign in:** verify the confidential-client secret, direct grants, realm JWKS reachability, the token issuer/client claims, and the exact role.
- **Map is blank but status is healthy:** run **Validate active**, inspect browser WebGL support, and confirm the archive uses the OpenMapTiles schema.
