# External map integration

DC Geomap exposes a public, read-only API for using the active Philippines
basemap in another web project. It does not expose build controls and does not
require a Keycloak token. The protected operations console still requires
`role_dcgeomaps_admin`.

Assume DC Geomap is available at `http://172.16.253.235:8081` in the examples.
Use your HTTPS public hostname in production.

## Endpoints

```text
GET /api/v1/integration
GET /api/v1/integration/style.json
GET /basemap/active.json
GET|HEAD /basemap/philippines-<version>.pmtiles
```

The discovery endpoint is safe to call before the first build. The style
endpoint returns HTTP 503 until a validated archive has been activated.

## React and MapLibre

Install the browser libraries in the consuming project:

```bash
npm install maplibre-gl pmtiles
```

Register the PMTiles protocol before creating the map. MapLibre then loads the
style and makes HTTP Range requests directly to the immutable PMTiles archive.

```tsx
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";

const DC_GEOMAP = "http://172.16.253.235:8081";

export function PhilippinesMap() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const map = new maplibregl.Map({
      container: container.current,
      style: `${DC_GEOMAP}/api/v1/integration/style.json`,
      center: [122.2, 12.4],
      zoom: 5,
      maxZoom: 22,
    });

    map.addControl(new maplibregl.NavigationControl(), "top-right");

    return () => {
      map.remove();
      maplibregl.removeProtocol("pmtiles");
    };
  }, []);

  return <div ref={container} style={{ width: "100%", height: "100vh" }} />;
}
```

If more than one map can exist at the same time, register one shared `Protocol`
at application startup instead of adding and removing it in each component.

## Read metadata without rendering

```js
const response = await fetch(
  "http://172.16.253.235:8081/api/v1/integration",
);
if (!response.ok) throw new Error(`DC Geomap returned ${response.status}`);

const basemap = await response.json();
if (basemap.status === "ready") {
  console.log(basemap.active.version, basemap.style_url);
}
```

## CORS configuration

For multiple browser projects, use these values on the DC Geomap server:

```dotenv
BASEMAP_ALLOWED_ORIGIN=*
INTEGRATION_ALLOWED_ORIGIN=*
```

This wildcard applies only to public, credential-free map discovery, style, and
archive responses. It does not enable cross-origin access to protected admin
endpoints. For a single consuming browser app, replace both `*` values with its
exact origin, for example `https://fieldops.example.com`.

After changing these variables, recreate only Caddy when no basemap build is
running:

```bash
sudo docker compose up -d --force-recreate web
```

## Operational rules

- Preserve the OpenStreetMap attribution displayed by the supplied style.
- Keep the source native maximum at z15 and set the map display maximum to z22.
- Do not configure a fallback to `tile.openstreetmap.org`.
- Use `APP_ORIGIN` for the externally reachable DC Geomap URL; generated API
  URLs will be wrong if it points to an internal container or proxy address.
- The active archive URL is versioned and immutable. Fetch the discovery or
  style endpoint again to adopt a newly promoted build.
