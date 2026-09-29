import type { StyleSpecification } from "maplibre-gl";

export function basemapStyle(url: string, baseUrl = window.location.href): StyleSpecification {
  const absolute = new URL(url, baseUrl).href;
  return {
    version: 8,
    sources: {
      openmaptiles: {
        type: "vector",
        url: `pmtiles://${absolute}`,
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
