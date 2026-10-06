import { describe, expect, it } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { basemapStyle } from "./basemap-style";

describe("basemap style", () => {
  it("uses the versioned local PMTiles archive with native z15", () => {
    const style = basemapStyle(
      "/basemap/philippines-2026-09-29-a3f81c.pmtiles",
      "https://maps.example.test/console",
    );
    const source = style.sources.openmaptiles;
    expect(source).toMatchObject({
      type: "vector",
      url: "pmtiles://https://maps.example.test/basemap/philippines-2026-09-29-a3f81c.pmtiles",
      maxzoom: 15,
    });
  });

  it("contains attribution and no public raster tile fallback", () => {
    const serialized = JSON.stringify(
      basemapStyle("/basemap/current.pmtiles", "https://maps.example.test/"),
    );
    expect(serialized).toContain("OpenStreetMap contributors");
    expect(serialized).not.toContain("tile.openstreetmap.org");
  });

  it("is accepted by MapLibre's style validator", () => {
    const errors = validateStyleMin(
      basemapStyle("/basemap/current.pmtiles", "https://maps.example.test/"),
    );
    expect(errors.map((error) => error.message)).toEqual([]);
  });
});
