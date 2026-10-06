export type MapFeatureDetails = {
  title: string;
  category: string;
  rows: Array<{ label: string; value: string }>;
};

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function friendly(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function mapFeatureDetails(
  properties: Record<string, unknown>,
  sourceLayer: string,
  coordinates: { lng: number; lat: number },
): MapFeatureDetails {
  const houseNumber = text(properties.housenumber);
  const categoryValue = text(properties.subclass) ?? text(properties.class) ?? sourceLayer;
  const title = text(properties.name) ?? text(properties.name_en) ??
    (houseNumber ? `House number ${houseNumber}` : friendly(sourceLayer));

  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown, suffix = "") => {
    const formatted = text(value);
    if (formatted) rows.push({ label, value: `${formatted}${suffix}` });
  };

  add("Category", friendly(categoryValue));
  add("House number", houseNumber);
  add("Street", properties.street ?? properties["addr:street"]);
  add("Reference", properties.ref);
  add("IATA", properties.iata);
  add("ICAO", properties.icao);
  add("Elevation", properties.ele, " m");
  add("Level", properties.level);
  rows.push({
    label: "Coordinates",
    value: `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`,
  });

  return { title, category: friendly(categoryValue), rows };
}

