import type { Config } from "./config.js";

export type PublicBasemapVersion = {
  version: string;
  url: string;
  osm_timestamp: string;
  source_checksum: string;
  pmtiles_checksum: string;
  archive_size: number;
  native_max_zoom: number;
  activated_at: string;
};

export type WorkerIntegrationStatus = {
  active: PublicBasemapVersion | null;
  job?: {
    status?: string;
    stage?: string | null;
    progress?: number;
  };
};

function publicUrl(config: Config, path: string): string {
  return new URL(path, config.appOrigin.endsWith("/") ? config.appOrigin : `${config.appOrigin}/`).href;
}

function safeActive(config: Config, active: PublicBasemapVersion | null) {
  if (!active) return null;
  return {
    version: active.version,
    pmtiles_url: publicUrl(config, active.url),
    osm_timestamp: active.osm_timestamp,
    archive_size: active.archive_size,
    native_max_zoom: active.native_max_zoom,
    activated_at: active.activated_at,
    checksums: {
      source_sha256: active.source_checksum,
      pmtiles_sha256: active.pmtiles_checksum,
    },
  };
}

export function integrationDocument(config: Config, status: WorkerIntegrationStatus) {
  const active = safeActive(config, status.active);
  const jobStatus = status.job?.status ?? "idle";
  return {
    api_version: "v1",
    name: "DC Geomap Philippines Basemap",
    status: active ? "ready" : jobStatus === "idle" ? "waiting_for_initial_build" : "building",
    coverage: "Philippines",
    format: "PMTiles",
    vector_schema: "OpenMapTiles",
    native_max_zoom: 15,
    display_max_zoom: 22,
    center: [122.2, 12.4, 5],
    attribution: "© OpenStreetMap contributors",
    attribution_url: "https://www.openstreetmap.org/copyright",
    manifest_url: publicUrl(config, config.basemapManifestUrl),
    style_url: publicUrl(config, "/api/v1/integration/style.json"),
    active,
    build: active
      ? null
      : {
          status: jobStatus,
          stage: status.job?.stage ?? null,
          progress: Math.min(100, Math.max(0, Number(status.job?.progress ?? 0))),
        },
  };
}

export function integrationStyle(config: Config, status: WorkerIntegrationStatus): Record<string, unknown> | null {
  const active = safeActive(config, status.active);
  if (!active) return null;

  return {
    version: 8,
    name: "DC Geomap Philippines",
    center: [122.2, 12.4],
    zoom: 5,
    metadata: {
      "dc-geomap:api-version": "v1",
      "dc-geomap:basemap-version": active.version,
      "dc-geomap:native-maxzoom": 15,
      "dc-geomap:display-maxzoom": 22,
    },
    sources: {
      openmaptiles: {
        type: "vector",
        url: `pmtiles://${active.pmtiles_url}`,
        minzoom: 0,
        maxzoom: 15,
        attribution:
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#e9efe8" } },
      {
        id: "landcover",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        paint: { "fill-color": "#dce8d5", "fill-opacity": 0.72 },
      },
      {
        id: "landuse",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landuse",
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "park",
            "#c9dfc4",
            "cemetery",
            "#d5e5d1",
            "hospital",
            "#eadbd8",
            "school",
            "#eee7cd",
            "#e3e6dc",
          ],
          "fill-opacity": 0.65,
        },
      },
      {
        id: "water",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "fill-color": "#9fd5df" },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        paint: { "line-color": "#8bc9d7", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.4, 15, 2] },
      },
      {
        id: "buildings",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": "#d7d2ca", "fill-outline-color": "#c5beb5", "fill-opacity": 0.8 },
      },
      {
        id: "roads-casing",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        paint: {
          "line-color": "#d7d1c6",
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.4, 12, 3, 18, 12],
        },
      },
      {
        id: "roads",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        paint: {
          "line-color": [
            "match",
            ["get", "class"],
            ["motorway", "trunk", "primary"],
            "#f3b66c",
            ["secondary", "tertiary"],
            "#f7d9a6",
            "#ffffff",
          ],
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.2, 12, 1.5, 18, 8],
        },
      },
      {
        id: "boundaries",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        paint: { "line-color": "#6f7d7a", "line-dasharray": [3, 2], "line-opacity": 0.55 },
      },
      {
        id: "places",
        type: "circle",
        source: "openmaptiles",
        "source-layer": "place",
        paint: {
          "circle-color": "#173e36",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 4],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      },
    ],
  };
}
