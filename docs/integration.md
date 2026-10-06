# External map integration

DC Geomap exposes a key-protected, read-only API for using the active
Philippines basemap in another project. Integration keys cannot run update,
rebuild, rollback, or other administrative operations. The operations console
continues to require the Keycloak role `role_dcgeomaps_admin`.

Assume DC Geomap is available at `http://172.16.253.235:8081` in the examples.
Use an HTTPS public hostname whenever the consuming application uses HTTPS.

## Create an application key

1. Sign in to DC Geomap as an administrator.
2. Open **Integrations**.
3. Select an application name, allowed browser origins, rate limit, and expiration.
4. Select **Generate API key** and copy the secret immediately.

The secret is displayed once. DC Geomap stores only its SHA-256 hash. Rotating
a key creates a new secret and immediately revokes the old one. Revocation also
stops subsequent PMTiles Range requests.

Every request uses this header:

```http
X-API-Key: dcgm_12345678_REDACTED
```

## Protected endpoints

```text
GET /api/v1/integration
GET /api/v1/integration/style.json
GET /basemap/active.json
GET|HEAD /basemap/philippines-<version>.pmtiles
```

The discovery endpoint can be called before the initial build finishes. The
style endpoint returns HTTP 503 until a validated archive is active. Manifests
and archives accept the same API key and enforce its origin, expiration,
revocation, and rate limit.

The published style includes place, road, water, park, establishment, airport,
mountain, and house-number labels. It uses fonts installed on the consuming
device and does not call a remote glyph, sprite, or public tile service.

## React and MapLibre

Install the consuming project's browser libraries:

```bash
npm install maplibre-gl pmtiles
```

Fetch the discovery and style documents using the key. Register a PMTiles
`FetchSource` with the same header before creating the map, so all archive
byte-range requests are authorized without placing the key in a URL.

```tsx
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { FetchSource, PMTiles, Protocol } from "pmtiles";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const DC_GEOMAP = "http://172.16.253.235:8081";
const API_KEY = "dcgm_12345678_REPLACE_ME";
const headers = new Headers({ "X-API-Key": API_KEY });

export function PhilippinesMap() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    let map: maplibregl.Map | undefined;
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    void (async () => {
      const discoveryResponse = await fetch(`${DC_GEOMAP}/api/v1/integration`, { headers });
      if (!discoveryResponse.ok) throw new Error(`Discovery failed: ${discoveryResponse.status}`);
      const discovery = await discoveryResponse.json();
      if (!discovery.active) throw new Error("The first basemap is not active yet.");

      const styleResponse = await fetch(discovery.style_url, { headers });
      if (!styleResponse.ok) throw new Error(`Style failed: ${styleResponse.status}`);
      const style = await styleResponse.json();

      protocol.add(new PMTiles(new FetchSource(discovery.active.pmtiles_url, headers)));
      map = new maplibregl.Map({
        container: container.current!,
        style,
        center: [122.2, 12.4],
        zoom: 5,
        maxZoom: discovery.display_max_zoom,
      });
      map.addControl(new maplibregl.NavigationControl(), "top-right");
    })();

    return () => {
      map?.remove();
      maplibregl.removeProtocol("pmtiles");
    };
  }, []);

  return <div ref={container} style={{ width: "100%", height: "100vh" }} />;
}
```

For production browser applications, inject the key at deployment time rather
than committing it to source control. Browser credentials are visible to the
browser user, so configure an exact allowed origin, use expiration and rate
limits, and rotate keys regularly. For stronger secrecy, call DC Geomap from
your own backend instead of distributing the key to browsers.

## Server-to-server example

```bash
curl --fail \
  -H 'X-API-Key: dcgm_12345678_REPLACE_ME' \
  http://172.16.253.235:8081/api/v1/integration
```

Server requests normally have no `Origin` header. The origin allowlist protects
browser usage; possession of the key still authorizes server-to-server usage.

## Key behavior

- Keys have the single least-privilege scope `basemap:read`.
- Only a hash is persisted in the separate `integration_data` Docker volume.
- The plaintext secret is returned only when a key is created or rotated.
- Exact browser origins or wildcard `*` can be selected per key.
- Rate limits are applied to discovery, style, manifest, and archive requests.
- Usage count, last-use time, and last browser origin appear in the admin UI.
- Revoked and expired keys are denied immediately.
- The Keycloak-protected built-in preview does not require an integration key.

## Operational rules

- Preserve the OpenStreetMap attribution included in the supplied style.
- Keep the source native maximum at z15 and the display maximum at z22.
- Do not configure a fallback to `tile.openstreetmap.org`.
- `APP_ORIGIN` must be the externally reachable DC Geomap origin because it is
  used to generate the discovery, style, and immutable archive URLs.
- Fetch discovery/style again after a new version is promoted. Existing archive
  URLs remain immutable while retained.
