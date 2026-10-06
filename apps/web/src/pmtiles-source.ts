import { FetchSource, PMTiles } from "pmtiles";

export function authenticatedPmtiles(url: string, token: string): PMTiles {
  const source = new FetchSource(
    url,
    new Headers({ authorization: `Bearer ${token}` }),
  );

  // Range requests must contain bytes. Some Chromium variants revalidate a
  // cached range and turn a valid 206 into an empty 304 response, which the
  // PMTiles reader cannot decode. Force network byte-range responses on every
  // platform; MapLibre and PMTiles retain their own in-memory caches.
  source.chromeWindowsNoCache = true;
  return new PMTiles(source);
}
