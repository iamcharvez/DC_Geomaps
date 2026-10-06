# DC Geomap

DC Geomap is a standalone, self-hosted Philippines OpenStreetMap basemap control plane. It downloads the Geofabrik Philippines extract, incrementally updates it when possible, generates vector PMTiles with Planetiler through native zoom 15, serves immutable versions through Caddy, and displays them in MapLibre through zoom 22 using vector overzoom.

It does **not** use `tile.openstreetmap.org`, does not write basemap data to PostGIS, and does not require DCGIS.

## Architecture

- **Web:** React 19 + MapLibre GL JS. The PMTiles renderer is loaded after login so the authentication screen stays small and fast.
- **API:** Fastify/TypeScript. It mediates Keycloak direct grants, verifies signed access tokens with the realm's JWKS, accepts only `role_dcgeomaps_admin` for administration, and manages hashed, revocable integration keys.
- **Worker:** Private Python service with pinned Planetiler, pyosmium, osmium-tool, and PMTiles CLI versions. It owns resumable downloads, bounded retries, scheduling, resource preflight checks, locks, builds, validation, activation, rollback, rotated logs, and audit events.
- **Caddy:** Serves the application and versioned archives with HTTP Range requests. The worker is not published to the host.
- **Storage:** A dedicated `basemap_data` Docker volume containing archives plus private PBF, cache, state, work, and logs. A separate `integration_data` volume stores hashed API-key records and usage counters. There is no application database.

See [architecture](docs/architecture.md), [operations](docs/operations.md), [authentication](docs/authentication.md), the [external map integration guide](docs/integration.md), the [API reference](docs/api.md), and the [AI integration guide](docs/ai-integration.md).

## Requirements

- Docker Engine/Desktop with Linux containers and Docker Compose v2.
- A Keycloak confidential OpenID Connect client with Direct Access Grants enabled.
- The exact Keycloak role `role_dcgeomaps_admin` assigned to authorized operators.
- For an initial Philippines z15 build, provision substantially more storage than the PBF itself. Planetiler recommends roughly 5–10× the PBF size in working disk and at least 0.5× its size in RAM; this project defaults to an 8 GiB JVM heap and a 25 GiB free-space floor. Size the server using an actual rehearsal.

## Configure

```powershell
Copy-Item .env.example .env
```

Set at least:

- `APP_ORIGIN` to the public DC Geomap origin. Browser origin restrictions are
  configured separately for each generated integration key.
- `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, and `KEYCLOAK_CLIENT_SECRET`.
- `WORKER_SHARED_SECRET` to a random value of at least 32 characters.
- `CADDY_SITE_ADDRESS` to a DNS name for automatic HTTPS in production.

Never commit `.env`.

### Use a host port other than 80

Host port 80 is not required. Caddy can continue listening on port 80 **inside**
its container while Docker publishes it on any free host port. For example, to
serve on port 8180 to other computers on the LAN:

```dotenv
CADDY_SITE_ADDRESS=:80
WEB_BIND=0.0.0.0
WEB_PORT=8180
WEB_HTTPS_PORT=8443
APP_ORIGIN=http://192.168.1.50:8180
```

Replace `192.168.1.50` with the server address, allow TCP 8180 through its
firewall, and open `http://192.168.1.50:8180`. Only the `web` service is
published; the API and worker remain private on the Compose network.

If an existing reverse proxy already owns host ports 80 and 443, keep
`WEB_BIND=127.0.0.1`, choose a free `WEB_PORT` such as 8180, and proxy the public
HTTPS hostname to `http://127.0.0.1:8180`. In that case `APP_ORIGIN` must contain
the public HTTPS hostname, not the local upstream address.

## Use the map in another project

The read-only integration API uses revocable application keys instead of an
administrator login. Generate one from the **Integrations** tab, then use it for:

```text
GET http://192.168.1.50:8180/api/v1/integration
GET http://192.168.1.50:8180/api/v1/integration/style.json
```

Send the key in `X-API-Key`. The same header authorizes PMTiles HTTP Range
requests. Keys support per-app origin policies, expiration, rotation, immediate
revocation, rate limits, and usage counters. Protected admin/build endpoints
remain restricted to `role_dcgeomaps_admin`. See the
[integration guide](docs/integration.md) for a React example.

## Start without forcing a manual build

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
```

Open `APP_ORIGIN`, sign in, then use **Force full rebuild** for the first controlled build. The scheduler also evaluates its due jobs at startup; after 02:00 Asia/Manila, a missing source causes the normal daily update to perform the required initial full download.

This repository has not downloaded the Philippines PBF or run Planetiler merely by being built or tested.

## Validation

```powershell
pnpm install
pnpm lint
pnpm test
pnpm test:worker  # requires Python 3.11+
pnpm build
docker compose --env-file .env.example config --quiet
```

The full end-to-end validation—including representative Luzon, Visayas, and Mindanao tiles and Caddy HTTP Range behavior—runs as part of every real worker build before activation.

## Important defaults

- Daily incremental check: **02:00 Asia/Manila**.
- Forced full rebuild: **first Sunday of each month at 01:00 Asia/Manila**.
- Failed scheduled operations: **up to five attempts, 30 minutes apart** by default.
- Native tile maximum: **z15**.
- Map maximum: **z22**, using MapLibre vector overzoom.
- Retention: active archive plus one previous validated archive.
- Source: `https://download.geofabrik.de/asia/philippines-latest.osm.pbf`.

OpenStreetMap data is © OpenStreetMap contributors and distributed under ODbL. See [licensing and data responsibilities](docs/licensing.md).
