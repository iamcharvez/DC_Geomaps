# Offline and Tauri considerations

The versioned PMTiles design is compatible with a future offline/Tauri client, but this repository currently ships a browser application only.

For a Tauri client:

1. Download `active.json`, then download the referenced immutable archive with resumable range requests.
2. Verify `archive_size` and `pmtiles_checksum` before switching the local active pointer.
3. Keep one previous archive and use the same manifest-swap approach as the server.
4. Register a PMTiles source backed by a Tauri byte-range command or a loopback/custom protocol; do not load the whole archive into memory.
5. Package or generate a complete local style and any glyph/sprite assets. The current minimal style intentionally has no remote font or sprite dependency.
6. Preserve OSM attribution in the offline interface and exported material.
7. Treat downloaded PMTiles as basemap data, not as DCGIS/PostGIS data.

Do not embed the Keycloak client secret in a desktop bundle. If remote administration is needed, keep confidential-client operations on the server and use an appropriate interactive authorization flow for the desktop client.
