export const motion = {
  direct: 120,
  transition: 220,
  navigation: 320,
} as const;

export type CrewRollMotion = Readonly<Record<keyof typeof motion, number>>;

export const reducedMotion = {
  direct: 0,
  transition: 0,
  navigation: 0,
} as const satisfies CrewRollMotion;
