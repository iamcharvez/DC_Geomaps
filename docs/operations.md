# Basemap operations

## Alternate published ports

The Compose stack does not require host port 80. Set `WEB_PORT` to any free host
port; Docker maps that port to Caddy's internal port 80. For example:

```dotenv
CADDY_SITE_ADDRESS=:80
WEB_BIND=0.0.0.0
WEB_PORT=8180
APP_ORIGIN=http://server-address:8180
BASEMAP_ALLOWED_ORIGIN=http://server-address:8180
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

If another operation is active, the scheduler keeps retrying its due job rather than starting concurrently. After a scheduled job is accepted it is recorded so it does not run twice that day/month.

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
- The admin UI shows worker state, active/previous versions, timestamps, checksums, archive size, disk usage, progress, schedules, and recent failures.
- `docker compose logs --tail=200 api worker web` captures container diagnostics.
- Detailed build output is stored in the basemap volume and available in **Build logs**.

## Changing maximum native zoom

The requested production value is enforced as 15. To intentionally change it, update the worker validation, environment constraint, frontend source metadata, documentation, tests, and capacity estimate together. Rebuild every archive; existing PMTiles cannot be extended in place.

## Troubleshooting

- **Insufficient disk:** free storage or increase the volume before retrying. Lowering the safety floor does not reduce Planetiler's actual requirements.
- **Checksum mismatch:** the partial file is deleted. Retry after Geofabrik finishes publishing or network stability returns.
- **Replication failure:** use **Force full rebuild** to re-establish a current canonical PBF.
- **Planetiler failure:** inspect build logs for JVM memory, disk, or upstream supporting-data errors. The current basemap remains active.
- **Range failure:** verify Caddy serves the volume and no upstream proxy strips the `Range` header or converts 206 to 200.
- **Cannot sign in:** verify the confidential-client secret, direct grants, realm JWKS reachability, the token issuer/client claims, and the exact role.
- **Map is blank but status is healthy:** run **Validate active**, inspect browser WebGL support, and confirm the archive uses the OpenMapTiles schema.
