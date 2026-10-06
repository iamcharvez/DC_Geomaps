import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { Protocol } from "pmtiles";
import { basemapStyle, INTERACTIVE_BASEMAP_LAYERS } from "./basemap-style";
import { mapFeatureDetails, type MapFeatureDetails } from "./map-feature-details";
import { authenticatedPmtiles } from "./pmtiles-source";
import type { BasemapStatus, BasemapVersion } from "./types";

const protocol = new Protocol();
let registered = false;

// MapLibre 6 ships its parser as a separate module worker. Vite bundles this
// explicit worker entry and gives it a stable same-origin URL; relying on
// MapLibre's import.meta.url fallback points at a non-existent sibling of the
// lazy MapPreview chunk in production.
maplibregl.setWorkerUrl(maplibreWorkerUrl);

function popupContent(details: MapFeatureDetails): HTMLElement {
  const content = document.createElement("article");
  content.className = "map-feature-card";

  const category = document.createElement("p");
  category.className = "map-feature-category";
  category.textContent = details.category;
  content.append(category);

  const title = document.createElement("h3");
  title.textContent = details.title;
  content.append(title);

  const list = document.createElement("dl");
  for (const row of details.rows) {
    const item = document.createElement("div");
    const label = document.createElement("dt");
    const value = document.createElement("dd");
    label.textContent = row.label;
    value.textContent = row.value;
    item.append(label, value);
    list.append(item);
  }
  content.append(list);
  return content;
}

export function MapPreview({ active, job, token }: { active: BasemapVersion | null; job?: BasemapStatus["job"]; token: string }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !container.current) return;
    if (!registered) {
      maplibregl.addProtocol("pmtiles", protocol.tile);
      registered = true;
    }
    const absoluteArchive = new URL(active.url, window.location.href).href;
    protocol.add(authenticatedPmtiles(absoluteArchive, token));
    setWarning(null);
    const instance = new maplibregl.Map({
      container: container.current,
      style: basemapStyle(active.url),
      center: [122.2, 12.4],
      zoom: 4.7,
      minZoom: 3,
      maxZoom: 22,
      attributionControl: false,
      cooperativeGestures: true,
      fadeDuration: 0,
    });
    map.current = instance;
    instance.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    instance.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    instance.on("click", [...INTERACTIVE_BASEMAP_LAYERS], (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      const details = mapFeatureDetails(
        properties,
        feature.sourceLayer ?? feature.layer.id,
        event.lngLat,
      );
      new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 10, maxWidth: "310px" })
        .setLngLat(event.lngLat)
        .setDOMContent(popupContent(details))
        .addTo(instance);
    });
    instance.on("mouseenter", [...INTERACTIVE_BASEMAP_LAYERS], () => {
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", [...INTERACTIVE_BASEMAP_LAYERS], () => {
      instance.getCanvas().style.cursor = "";
    });
    instance.on("error", (event: maplibregl.ErrorEvent) => {
      const message = event.error?.message || "The active basemap could not be displayed.";
      setWarning(message);
    });
    return () => {
      instance.remove();
      map.current = null;
    };
  }, [active?.url, token]);

  if (!active) {
    const building = job && job.status !== "idle";
    return (
      <div className="map-empty">
        <div className="archipelago-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <p className="eyebrow">MAP PREVIEW</p>
        <h3>{building ? "Building the first basemap" : "Ready for the first build"}</h3>
        <p>{building
          ? `${job.message} (${job.progress}%). The build continues if this page is closed.`
          : "No external tiles are used. Start a full build when the host has enough free disk space."}</p>
      </div>
    );
  }

  return (
    <div className="map-shell">
      <div ref={container} className="map-canvas" />
      <div className="map-version">
        <span>LIVE</span>
        <strong>{active.version}</strong>
        <small>native z15 · overzoom to z22</small>
      </div>
      {warning && <div className="map-warning">Basemap warning: {warning}</div>}
    </div>
  );
}
