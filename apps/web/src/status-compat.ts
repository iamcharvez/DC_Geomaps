import type { BasemapStatus } from "./types";

export function resourceSafety(resources: BasemapStatus["resources"]): boolean {
  return resources?.safe ?? true;
}
