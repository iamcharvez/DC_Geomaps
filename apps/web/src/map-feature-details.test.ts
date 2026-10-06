import { describe, expect, it } from "vitest";
import { mapFeatureDetails } from "./map-feature-details";

describe("map feature details", () => {
  it("formats a named establishment without inventing an address", () => {
    expect(mapFeatureDetails(
      { name: "City Health Center", class: "hospital", subclass: "clinic" },
      "poi",
      { lng: 122.2, lat: 12.4 },
    )).toEqual({
      title: "City Health Center",
      category: "Clinic",
      rows: [
        { label: "Category", value: "Clinic" },
        { label: "Coordinates", value: "12.40000, 122.20000" },
      ],
    });
  });

  it("formats house-number and road metadata when present", () => {
    const details = mapFeatureDetails(
      { housenumber: "42", "addr:street": "Rizal Street", ref: "N1" },
      "housenumber",
      { lng: 120.98, lat: 14.6 },
    );
    expect(details.title).toBe("House number 42");
    expect(details.rows).toContainEqual({ label: "House number", value: "42" });
    expect(details.rows).toContainEqual({ label: "Street", value: "Rizal Street" });
  });
});
