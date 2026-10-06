import { describe, expect, it } from "vitest";
import { FetchSource } from "pmtiles";
import { authenticatedPmtiles } from "./pmtiles-source";

describe("authenticated PMTiles source", () => {
  it("always bypasses conditional browser caching for byte ranges", () => {
    const archive = authenticatedPmtiles(
      "http://maps.example.test/basemap/philippines.pmtiles",
      "test-access-token",
    );
    expect(archive.source).toBeInstanceOf(FetchSource);
    const source = archive.source as FetchSource;
    expect(source.customHeaders.get("authorization")).toBe("Bearer test-access-token");
    expect(source.chromeWindowsNoCache).toBe(true);
  });
});
