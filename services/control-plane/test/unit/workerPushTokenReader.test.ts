import { describe, expect, it } from "vitest";
import { createWorkerPushTokenProtector } from "../../worker/pushTokenProtector.js";

describe("existing Worker push token frame decryption", () => {
  it("round trips stored tokens and rejects tampering, context swaps, wrong keys and closed handles", async () => {
    const vault = createWorkerPushTokenProtector(
      Buffer.alloc(32, 7).toString("base64"),
    );
    const other = createWorkerPushTokenProtector(
      Buffer.alloc(32, 8).toString("base64"),
    );
    const id = crypto.randomUUID();
    const protectedToken = await vault.protector.protect(
      "native-device-token",
      id,
      "android",
    );
    await expect(
      vault.reader.read(protectedToken.encryptedToken, id, "android"),
    ).resolves.toBe("native-device-token");
    expect(() =>
      vault.reader.read(
        protectedToken.encryptedToken,
        crypto.randomUUID(),
        "android",
      ),
    ).toThrow();
    expect(() =>
      vault.reader.read(protectedToken.encryptedToken, id, "ios"),
    ).toThrow();
    expect(() =>
      other.reader.read(protectedToken.encryptedToken, id, "android"),
    ).toThrow();
    const modified = Buffer.from(protectedToken.encryptedToken);
    modified[25] = modified[25]! ^ 1;
    expect(() => vault.reader.read(modified, id, "android")).toThrow();
    vault.destroy();
    expect(() =>
      vault.reader.read(protectedToken.encryptedToken, id, "android"),
    ).toThrow("closed");
    other.destroy();
  });
});
