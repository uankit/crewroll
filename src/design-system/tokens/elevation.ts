export const elevation = {
  none: 0,
  raised: 2,
  floating: 8,
} as const;

export type ElevationLevel = keyof typeof elevation;
