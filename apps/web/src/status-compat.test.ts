import { describe, expect, it } from "vitest";
import { resourceSafety } from "./status-compat";

describe("status response compatibility", () => {
  it("accepts an older worker response without resource safety data", () => {
    expect(resourceSafety(undefined)).toBe(true);
  });

  it("preserves an explicit unsafe resource result", () => {
    expect(resourceSafety({
      safe: false,
      warnings: ["memory"],
      disk_required_free: 0,
      disk_configured_floor: 0,
      memory_total: 0,
      memory_available: 0,
      java_heap: 0,
      memory_reserve: 0,
      minimum_available_memory: 0,
    })).toBe(false);
  });
});
