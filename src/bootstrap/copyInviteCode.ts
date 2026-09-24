import * as Clipboard from "expo-clipboard";

export async function copyInviteCode(code: string): Promise<void> {
  if (!(await Clipboard.setStringAsync(code))) {
    throw new Error("Clipboard unavailable");
  }
}
