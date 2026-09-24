import Feather from "@expo/vector-icons/Feather";
import { useCrewRollTheme } from "../theme/useCrewRollTheme";

const icons = {
  account: "user",
  bell: "bell",
  settings: "settings",
  check: "check",
  close: "x",
} as const;

export function AppIcon({
  name,
  color,
  size = 24,
}: Readonly<{
  name: keyof typeof icons;
  color?: string;
  size?: number;
}>) {
  const theme = useCrewRollTheme();
  return (
    <Feather
      accessible={false}
      name={icons[name]}
      color={color ?? theme.textPrimary}
      size={size}
    />
  );
}
