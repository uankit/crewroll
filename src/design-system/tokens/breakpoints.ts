export const breakpoints = {
  compact: 0,
  medium: 600,
  expanded: 840,
} as const;

export type BreakpointName = keyof typeof breakpoints;
