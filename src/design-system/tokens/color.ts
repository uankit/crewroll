export const lightColors = {
  background: "#F7F9FC",
  surface: "#FFFFFF",
  surfaceMuted: "#EDF2F8",
  border: "#DCE4EE",
  textPrimary: "#07111F",
  textSecondary: "#5F6C7D",
  action: "#0B63CE",
  actionPressed: "#0752AF",
  onAction: "#FFFFFF",
  success: "#067A5B",
  successSurface: "#E7F8F2",
  warning: "#8A4B00",
  warningSurface: "#FFF3D6",
  critical: "#B42318",
  criticalSurface: "#FDECEA",
  info: "#075EDB",
  infoSurface: "#EAF2FF",
} as const;

export type CrewRollColors = {
  readonly [Key in keyof typeof lightColors]: string;
};

export const darkColors = {
  background: "#020A12",
  surface: "#081421",
  surfaceMuted: "#0E1C2B",
  border: "#203247",
  textPrimary: "#F7FAFF",
  textSecondary: "#9EADBE",
  action: "#1675FF",
  actionPressed: "#2D82FF",
  onAction: "#020A12",
  success: "#62E8BC",
  successSurface: "#0D362C",
  warning: "#FFD27A",
  warningSurface: "#3B2A0A",
  critical: "#FF9B9B",
  criticalSurface: "#40171C",
  info: "#79B8FF",
  infoSurface: "#0A2D5D",
} as const satisfies CrewRollColors;
