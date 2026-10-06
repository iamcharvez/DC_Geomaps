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

const labelFont = ["Noto Sans", "Roboto", "Segoe UI", "Arial", "sans-serif"];
const labelField = ["coalesce", ["get", "name"], ["get", "name_en"], ""];
const labelPaint = {
  "text-color": "#27463e",
  "text-halo-color": "rgba(250, 252, 249, 0.94)",
  "text-halo-width": 1.4,
  "text-halo-blur": 0.4,
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
      "dc-geomap:font-mode": "local",
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
        id: "house-numbers",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "housenumber",
        minzoom: 15,
        layout: {
          "text-field": ["get", "housenumber"],
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 15, 9, 19, 12],
          "text-allow-overlap": false,
        },
        paint: { "text-color": "#746b61", "text-halo-color": "rgba(255,255,255,.88)", "text-halo-width": 1 },
      },
      {
        id: "waterway-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "waterway",
        minzoom: 10,
        filter: ["has", "name"],
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 350,
          "text-field": labelField,
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 13],
          "text-max-angle": 35,
        },
        paint: { ...labelPaint, "text-color": "#397e8e", "text-halo-color": "rgba(235,248,250,.95)" },
      },
      {
        id: "water-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "water_name",
        minzoom: 5,
        filter: ["has", "name"],
        layout: {
          "symbol-placement": "line",
          "text-field": labelField,
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 14, 14],
          "text-letter-spacing": 0.08,
        },
        paint: { ...labelPaint, "text-color": "#347888", "text-halo-color": "rgba(221,244,247,.96)" },
      },
      {
        id: "road-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        minzoom: 7,
        layout: {
          "symbol-placement": "line",
          "symbol-spacing": 300,
          "text-field": ["coalesce", ["get", "name"], ["get", "ref"], ""],
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 7, 9, 12, 11, 16, 13],
          "text-max-angle": 35,
          "text-padding": 2,
        },
        paint: { ...labelPaint, "text-color": "#5b554e", "text-halo-width": 1.6 },
      },
      {
        id: "park-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "park",
        minzoom: 10,
        filter: ["has", "name"],
        layout: {
          "text-field": labelField,
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 16, 13],
          "text-variable-anchor": ["center", "top", "bottom"],
          "text-radial-offset": 0.3,
        },
        paint: { ...labelPaint, "text-color": "#40704d", "text-halo-color": "rgba(239,248,235,.95)" },
      },
      {
        id: "airport-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "aerodrome_label",
        minzoom: 8,
        filter: ["has", "name"],
        layout: {
          "text-field": ["format", "✈ ", {}, labelField, {}],
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13],
          "text-variable-anchor": ["top", "bottom", "left", "right"],
          "text-radial-offset": 0.6,
        },
        paint: labelPaint,
      },
      {
        id: "peak-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "mountain_peak",
        minzoom: 10,
        filter: ["has", "name"],
        layout: {
          "text-field": ["format", "▲ ", {}, labelField, {}],
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 10, 10, 15, 12],
          "text-variable-anchor": ["top", "bottom"],
          "text-radial-offset": 0.5,
        },
        paint: { ...labelPaint, "text-color": "#625d57" },
      },
      {
        id: "poi-markers",
        type: "circle",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 13,
        filter: ["has", "name"],
        paint: {
          "circle-color": [
            "match", ["get", "class"],
            ["hospital", "pharmacy"], "#c9675d",
            ["school", "college", "library"], "#5f80a3",
            ["cafe", "fast_food", "bar", "restaurant"], "#cc8a4b",
            ["shop", "grocery", "clothing_store"], "#9a6cad",
            ["park", "golf", "stadium"], "#4d9467",
            "#16856d",
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 17, 5],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.2,
        },
      },
      {
        id: "poi-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 14,
        filter: ["has", "name"],
        layout: {
          "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
          "text-field": labelField,
          "text-font": labelFont,
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 10, 18, 12],
          "text-variable-anchor": ["top", "bottom", "left", "right"],
          "text-radial-offset": 0.8,
          "text-padding": 2,
        },
        paint: { ...labelPaint, "text-color": "#23433b" },
      },
      {
        id: "place-markers",
        type: "circle",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 4,
        filter: ["in", ["get", "class"], ["literal", ["city", "town", "village", "suburb", "quarter", "neighbourhood"]]],
        paint: {
          "circle-color": "#173e36",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 1.5, 10, 3.5],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      },
      {
        id: "place-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 3,
        filter: ["has", "name"],
        layout: {
          "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
          "text-field": labelField,
          "text-font": labelFont,
          "text-size": [
            "interpolate", ["linear"], ["zoom"],
            3, ["match", ["get", "class"], "country", 15, ["state", "province"], 13, 11],
            10, ["match", ["get", "class"], "city", 17, "town", 15, 12],
            16, ["match", ["get", "class"], ["city", "town"], 18, 13],
          ],
          "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
          "text-radial-offset": 0.45,
          "text-padding": 3,
        },
        paint: {
          ...labelPaint,
          "text-color": ["match", ["get", "class"], ["country", "state", "province", "city"], "#153c32", "#49635c"],
          "text-halo-width": 1.8,
        },
      },
    ],
  };
}
