# Architecture

## Data flow

1. The worker obtains the Geofabrik `.md5` and PBF `Last-Modified` metadata.
2. If the last successfully observed Geofabrik checksum has not changed, the daily job exits without rebuilding.
3. A first or forced job downloads a new PBF to a `.partial` file and verifies its MD5. A normal changed-data job copies the installed PBF to staging and runs `pyosmium-up-to-date` against the replication metadata embedded in the extract.
4. `osmium fileinfo -e` scans the candidate before Planetiler runs.
5. Planetiler generates a new versioned PMTiles archive in a unique staging directory. It never writes the active file.
6. The PMTiles CLI verifies archive structure and its header must declare max zoom 15. The worker reads low, medium, and z15 tiles for Manila/Luzon, Cebu/Visayas, and Davao/Mindanao.
7. The versioned candidate is copied into the public volume and fetched through Caddy with `Range: bytes=0-126`. Activation requires HTTP 206 and a valid `Content-Range` response.
8. Only after all checks pass does the worker atomically replace `active.json`. Existing clients keep using the older immutable URL; newly loaded clients discover the new version.
9. The former active version becomes `previous`. All older PMTiles archives are deleted.

## Isolation and trust boundaries

- Only Caddy is published. The API and worker are reachable on the private Compose network.
- The worker accepts a shared bearer secret from the API, but the browser never receives it.
- Every browser control request is introspected with Keycloak immediately before it is proxied to the worker.
- The worker runs tools as UID/GID 10001 after a minimal root entrypoint prepares the Docker volume.
- PBF, PMTiles, build cache, state, logs, and locks are isolated in `basemap_data`. No PostGIS database exists in this project.
- The frontend uses only the URL in the authenticated status response/`active.json`; it has no public-tile fallback.

## Failure model

- Downloads use a temporary suffix and a verified checksum.
- Each job uses both an in-process mutex and an advisory file lock.
- Cancellation terminates the current process group, removes its staging directory, and never changes `active.json`.
- A worker restart marks an interrupted job failed and safely clears only children of `/data/work`.
- A failed candidate copied to the public directory is deleted before returning failure.
- Caddy mounts the volume read-only, so serving cannot mutate build state.
- The active and previous archives are immutable. Rollback swaps manifest metadata rather than overwriting either archive.

## Versioned state

Public files:

```text
/data/public/
  active.json
  health.json
  philippines-YYYY-MM-DD-abcdef.pmtiles
  philippines-YYYY-MM-DD-fedcba.pmtiles  # previous, if available
```

Private files include the installed PBF, Planetiler supporting-data cache, state JSON, update lock, staging work, logs, and audit JSONL.

## Technology pins

Container and package versions are explicit in Dockerfiles and package manifests, including Planetiler 0.10.2, go-pmtiles 1.30.0, pyosmium 4.3.1, Java 21, Node 24.19.0, Caddy 2.11.4, React 19.3.0, MapLibre GL JS 6.11.2, and PMTiles JS 4.5.0. Review release notes and run the full validation suite before changing a pin.

