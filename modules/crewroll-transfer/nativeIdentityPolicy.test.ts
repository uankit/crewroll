import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("native identity and trip-key production policy", () => {
  it("maps the identity commands to real iOS and Android lifecycle services", () => {
    const swift = read(
      "modules/crewroll-transfer/ios/CrewRollTransferModule.swift",
    );
    const kotlin = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt",
    );
    for (const method of [
      "ensureDeviceIdentity",
      "installDeviceSession",
      "clearDeviceSession",
      "createTripKey",
      "discardProvisionalTripKey",
      "wrapTripKey",
      "importTripKey",
      "activateTrip",
      "deactivateTrip",
    ]) {
      expect(swift).toContain(`lifecycle.${method}`);
      expect(kotlin).toContain(`lifecycle.${method}`);
    }
    expect(swift).not.toContain("ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED");
    expect(kotlin).not.toContain("ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED");

    const swiftEnsure = swift.slice(
      swift.indexOf('AsyncFunction("ensureDeviceIdentity")'),
      swift.indexOf('AsyncFunction("installDeviceSession")'),
    );
    const kotlinEnsure = kotlin.slice(
      kotlin.indexOf('AsyncFunction("ensureDeviceIdentity")'),
      kotlin.indexOf('AsyncFunction("installDeviceSession")'),
    );
    expect(swiftEnsure).toContain("command: [String: Any]");
    expect(swiftEnsure).toContain(
      'accountID: try Self.string(command, "accountId")',
    );
    expect(kotlinEnsure).toContain("command: Map<String, Any?>");
    expect(kotlinEnsure).toContain('string(command, "accountId")');

    for (const source of [swift, kotlin]) {
      const install = source.slice(
        source.indexOf('AsyncFunction("installDeviceSession")'),
        source.indexOf('AsyncFunction("createTripKey")'),
      );
      expect(install).toMatch(/accountI[dD].*accountId/s);
      expect(install).toMatch(/installationI[dD].*installationId/s);
    }
  });

  it("runs one serialized cleanup service at Expo 57 creation, foreground, expiry, and destroy", () => {
    const swift = read(
      "modules/crewroll-transfer/ios/CrewRollTransferModule.swift",
    );
    const kotlin = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt",
    );
    expect(swift).toContain("OnCreate {");
    expect(swift).toContain("OnAppEntersForeground {");
    expect(swift).toContain("OnDestroy {");
    expect(kotlin).toContain("OnCreate {");
    expect(kotlin).toContain("OnActivityEntersForeground {");
    expect(kotlin).toContain("OnDestroy {");
    for (const source of [swift, kotlin]) {
      expect(source).toContain("runLifecycleCleanup");
      expect(source).toContain("runScheduledCleanup");
      expect(source).toContain("cancelScheduledCleanup");
    }
    const swiftLifecycle = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeKeyLifecycle.swift",
    );
    const kotlinLifecycle = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/NativeKeyLifecycle.kt",
    );
    expect(swiftLifecycle).toContain("NativeKeyCleanupRunner");
    expect(swiftLifecycle).toContain("NativeKeyCleanupCoordinator");
    expect(swiftLifecycle).toContain("DispatchNativeKeyCleanupScheduler");
    expect(swiftLifecycle).toContain("NSLock");
    expect(kotlinLifecycle).toContain("NativeKeyCleanupRunner");
    expect(kotlinLifecycle).toContain("NativeKeyCleanupCoordinator");
    expect(kotlinLifecycle).toContain("ExecutorNativeKeyCleanupScheduler");
    expect(kotlinLifecycle).toContain("ReentrantLock");
    expect(swiftLifecycle).toContain("Access-locked/transient failures");
    expect(kotlinLifecycle).toContain("Access-locked/transient failures");
  });

  it("binds iOS to the reviewed Clibsodium binary and device-only Keychain policy", () => {
    const podspec = read(
      "modules/crewroll-transfer/ios/CrewRollTransfer.podspec",
    );
    const store = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/AppleAccountScopedKeyStore.swift",
    );
    const crypto = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/AppleSodiumCrypto.swift",
    );
    const infrastructure = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/AppleNativeKeyInfrastructure.swift",
    );
    const swiftPackage = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Package.swift",
    );
    expect(podspec).toContain("vendored_frameworks");
    expect(podspec).toContain("Clibsodium.xcframework");
    expect(podspec).not.toContain("Tests");
    expect(store).toContain("kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly");
    expect(store).toContain("kSecAttrSynchronizable: false");
    expect(crypto).toContain("crypto_box_seal(");
    expect(crypto).toContain("crypto_box_seal_open(");
    expect(crypto).toMatch(/randomBytes[\s\S]*defer[\s\S]*sodium_memzero/);
    expect(crypto).toMatch(/func open[\s\S]*sodium_memzero\(&output/);
    expect(store).not.toContain("UserDefaults");
    expect(store).toContain("constantTimeEquals");
    expect(store).not.toContain("existing.key == key");
    expect(store).toContain("secureClearSession");
    expect(store).toContain("secureRemoveTrip");
    expect(store).toContain("result = nil");
    expect(store).toContain("add.removeValue(forKey: kSecValueData)");
    expect(
      read(
        "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeKeyLifecycle.swift",
      ),
    ).not.toContain("encodedBearer");
    expect(infrastructure).toContain("com.uankit53.airmesh.p256.v2.");
    expect(infrastructure).toContain("kSecAttrTokenIDSecureEnclave");
    expect(infrastructure).toContain("AppleAccountScopedKeyStore()");
    expect(infrastructure).toContain("AppleAccountNamespaceHasher()");
    expect(infrastructure).toContain("DispatchNativeKeyCleanupScheduler()");
    expect(infrastructure).not.toContain("com.uankit53.airmesh.p256.v1");
    expect(infrastructure).not.toContain("secureEnclave: false");
    expect(swiftPackage).not.toContain("exclude:");
  });

  it("binds Android to Keystore AES-GCM, no-backup records, and pinned Lazysodium", () => {
    const gradle = read("modules/crewroll-transfer/android/build.gradle");
    const infrastructure = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/AndroidNativeKeyInfrastructure.kt",
    );
    const store = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/AndroidAccountScopedKeyStore.kt",
    );
    const lifecycle = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/NativeKeyLifecycle.kt",
    );
    const codec = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/AndroidScopedDatabaseCodec.kt",
    );
    expect(gradle).toContain(
      "implementation files('Vendor/lazysodium-android-5.2.0.aar')",
    );
    expect(gradle).toContain("implementation files('Vendor/jna-5.17.0.aar')");
    expect(gradle).not.toContain("com.goterl:lazysodium-android:5.2.0@aar");
    expect(infrastructure).toContain('getInstance("AndroidKeyStore")');
    expect(store).toContain('getInstance("AES/GCM/NoPadding")');
    expect(infrastructure).toContain("setIsStrongBoxBacked(true)");
    expect(store).toContain("noBackupFilesDir");
    expect(store).toContain("isUserUnlocked");
    expect(store).toContain("ATOMIC_MOVE");
    expect(codec).toContain("AesGcmScopedSecretCipher");
    expect(codec).toContain("androidScopedSecretAad");
    expect(codec).toContain("AndroidScopedSecretType.IDENTITY_PRIVATE");
    expect(codec).toContain("AndroidScopedSecretType.SESSION_BEARER");
    expect(codec).toContain("AndroidScopedSecretType.TRIP_KEY");
    expect(store).toContain("legacyOuterAad");
    expect(store).toContain("CRKEYDB3|atomic-container|2");
    expect(
      read(
        "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/AccountScopedKeyStore.kt",
      ),
    ).toContain("secureReplaceSession");
    expect(store).toContain(
      "NativeKeyStore by AccountScopedKeyStore(AndroidScopedDatabaseFile(context))",
    );
    const saveDatabase = store.slice(
      store.indexOf("override fun save"),
      store.indexOf("private fun requireUnlocked"),
    );
    expect(saveDatabase).toContain("outerAad");
    expect(saveDatabase).not.toContain("legacyOuterAad");
    expect(store).toContain("setRandomizedEncryptionRequired(true)");
    expect(saveDatabase).toContain(
      "AesGcmScopedSecretCipher(key, random).seal(plaintext, outerAad)",
    );
    expect(codec).toContain("cipher.init(Cipher.ENCRYPT_MODE, key, random)");
    expect(codec).toContain("val nonce = cipher.iv");
    expect(codec).not.toMatch(/Cipher\.ENCRYPT_MODE, key, GCMParameterSpec/);
    expect(store).not.toContain("getExternalFilesDir");
    expect(infrastructure).toContain("AndroidAccountScopedKeyStore(context)");
    expect(infrastructure).toContain("AndroidAccountNamespaceHasher()");
    expect(infrastructure).toContain("ExecutorNativeKeyCleanupScheduler()");
    expect(infrastructure).toContain("crypto_scalarmult_base");
    expect(infrastructure).toContain("sodium_memcmp");
    expect(infrastructure).toContain("sodium_memzero");
    expect(lifecycle).toContain("crewroll.p256.v2.");
    expect(infrastructure).not.toContain("crewroll.p256.v1");
    expect(infrastructure).not.toContain("AndroidNativeKeyStore");
  });

  it("keeps activation envelope-free and bearer results write-only", () => {
    for (const source of [
      read("modules/crewroll-transfer/ios/CrewRollTransferModule.swift"),
      read(
        "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt",
      ),
    ]) {
      const activation = source.slice(
        source.indexOf('AsyncFunction("activateTrip")'),
        source.indexOf('AsyncFunction("deactivateTrip")'),
      );
      expect(activation).not.toMatch(/wrapped|envelope/i);
      expect(source).not.toContain('["backgroundBearer":');
      expect(source).not.toContain('"backgroundBearer" to');
    }
  });

  it("routes all nine shells through closed-object decoders and lowercase UUIDv7 trip validation", () => {
    const swift = read(
      "modules/crewroll-transfer/ios/CrewRollTransferModule.swift",
    );
    const kotlin = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt",
    );
    expect(
      swift.match(/NativeCommandDecoder\.require\(command, for:/g),
    ).toHaveLength(9);
    expect(swift).toContain("NativeCommandDecoder.activation");
    expect(
      swift.slice(0, swift.indexOf('AsyncFunction("setTransferPolicy")')),
    ).not.toContain("NativeCommandDecoder.requireProtocol(command)");
    expect(swift).not.toContain('command["releaseAt"] as? String');
    expect(
      kotlin.match(
        /NativeCommandDecoder\.require\(command, NativeCommandKind\./g,
      ),
    ).toHaveLength(9);
    expect(kotlin).toContain("NativeCommandDecoder.activation");
    expect(
      kotlin.slice(0, kotlin.indexOf('AsyncFunction("setTransferPolicy")')),
    ).not.toContain("NativeCommandDecoder.requireProtocol(command)");
    expect(kotlin).not.toContain(
      '(command["protocolVersion"] as? Number)?.toInt()',
    );
    expect(kotlin).not.toContain('command["releaseAt"] as? String');

    const swiftDecoder = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeKeyLifecycle.swift",
    );
    const kotlinDecoder = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/NativeKeyLifecycle.kt",
    );
    expect(swiftDecoder).toContain("Set(command.keys) == kind.exactKeys");
    expect(swiftDecoder).toContain("requireTripID");
    expect(kotlinDecoder).toContain("command.keys != kind.exactKeys");
    expect(kotlinDecoder).toContain("requireTripId");
  });

  it("keeps the native error surface closed and never exposes Android throwable detail", () => {
    const swift = read(
      "modules/crewroll-transfer/ios/CrewRollTransferModule.swift",
    );
    const kotlin = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/CrewRollTransferModule.kt",
    );
    for (const code of [
      "KEY_ACCESS_LOCKED",
      "KEY_MATERIAL_LOST",
      "KEY_ENVELOPE_INVALID",
    ]) {
      expect(swift).toContain(code);
      expect(kotlin).toContain(code);
    }
    expect(swift).toContain("publicErrorCode");
    expect(kotlin).toContain("publicErrorCode");
    expect(kotlin).toContain("CodedException(code, code, null)");
    expect(kotlin).not.toContain(
      "CodedException(error.code, error.code, error)",
    );
  });

  it("accepts RFC3339 timestamps with or without fractional seconds", () => {
    const swift = read(
      "modules/crewroll-transfer/ios/IdentityKeys/Sources/CrewRollNativeKeys/NativeKeyLifecycle.swift",
    );
    const kotlin = read(
      "modules/crewroll-transfer/android/src/main/java/com/uankit53/crewroll/transfer/identitykeys/NativeKeyLifecycle.kt",
    );
    expect(swift).toContain("ISO8601DateFormatter");
    expect(swift).toContain("withFractionalSeconds");
    expect(kotlin).toContain("OffsetDateTime.parse");
    expect(kotlin).toContain("rfc3339");
  });
});
