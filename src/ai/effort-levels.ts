/**
 * The app's five-step effort scale, lowest to highest. A leaf module so the
 * backends can share it without pulling in the provider or capability tables.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AIEffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is AIEffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}
