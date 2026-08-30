import ExpoModulesCore

private let pendingScopeCode = "ERR_CREWROLL_TRANSFER_SCOPE_PENDING"
private let pendingScopeDescription =
  "This native transfer operation is outside the identity and key vertical."

private func pendingScopeException() -> Exception {
  Exception(
    name: "CrewRollTransferScopePending",
    description: pendingScopeDescription,
    code: pendingScopeCode
  )
}

public final class CrewRollTransferModule: Module {
  private var productionLifecycle: NativeKeyLifecycle?

  public func definition() -> ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")
    OnCreate {
      self.runLifecycleCleanup()
    }
    OnAppEntersForeground {
      self.runLifecycleCleanup()
    }
    OnDestroy {
      self.productionLifecycle?.cancelScheduledCleanup()
      self.productionLifecycle = nil
    }

    AsyncFunction("ensureDeviceIdentity") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .ensureDeviceIdentity)
        let lifecycle = try self.lifecycle()
        let identity = try lifecycle.ensureDeviceIdentity(
          accountID: try Self.string(command, "accountId")
        )
        promise.resolve([
          "protocolVersion": identity.protocolVersion,
          "installationId": identity.installationID,
          "authenticationKeyAlgorithm": identity.authenticationKeyAlgorithm,
          "authenticationPublicKey": identity.authenticationPublicKey,
          "authenticationKeyVersion": identity.authenticationKeyVersion,
          "e2eeKeyAlgorithm": identity.e2eeKeyAlgorithm,
          "e2eePublicKey": identity.e2eePublicKey,
          "e2eeKeyVersion": identity.e2eeKeyVersion,
        ])
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("installDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .installDeviceSession)
        let lifecycle = try self.lifecycle()
        try lifecycle.installDeviceSession(
          accountID: try Self.string(command, "accountId"),
          installationID: try Self.string(command, "installationId"),
          deviceID: try Self.string(command, "deviceId"),
          backgroundBearer: try Self.string(command, "backgroundBearer"),
          expiresAt: try Self.date(command, "backgroundBearerExpiresAt"),
          apiBaseURL: try Self.string(command, "apiBaseUrl")
        )
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("createTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .createTripKey)
        let lifecycle = try self.lifecycle()
        let result = try lifecycle.createTripKey(
          tripID: try Self.string(command, "tripId"),
          keyEpoch: try Self.integer(command, "keyEpoch")
        )
        promise.resolve([
          "protocolVersion": result.protocolVersion,
          "tripId": result.tripID,
          "keyEpoch": result.keyEpoch,
        ])
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("discardProvisionalTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .discardProvisionalTripKey)
        let lifecycle = try self.lifecycle()
        try lifecycle.discardProvisionalTripKey(
          tripID: try Self.string(command, "tripId"),
          keyEpoch: try Self.integer(command, "keyEpoch")
        )
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("wrapTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .wrapTripKey)
        let lifecycle = try self.lifecycle()
        let result = try lifecycle.wrapTripKey(
          tripID: try Self.string(command, "tripId"),
          keyEpoch: try Self.integer(command, "keyEpoch"),
          recipientDeviceID: try Self.string(command, "recipientDeviceId"),
          recipientE2EEPublicKey: try Self.string(command, "recipientE2eePublicKey"),
          recipientE2EEKeyVersion: try Self.integer(command, "recipientE2eeKeyVersion")
        )
        promise.resolve([
          "protocolVersion": result.protocolVersion,
          "tripId": result.tripID,
          "keyEpoch": result.keyEpoch,
          "algorithmVersion": result.algorithmVersion,
          "senderDeviceId": result.senderDeviceID,
          "recipientDeviceId": result.recipientDeviceID,
          "recipientE2eeKeyVersion": result.recipientE2EEKeyVersion,
          "wrappedKey": result.wrappedKey,
        ])
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("importTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .importTripKey)
        let lifecycle = try self.lifecycle()
        try lifecycle.importTripKey(
          tripID: try Self.string(command, "tripId"),
          keyEpoch: try Self.integer(command, "keyEpoch"),
          algorithmVersion: try Self.integer(command, "algorithmVersion"),
          expectedSenderDeviceID: try Self.string(command, "expectedSenderDeviceId"),
          recipientDeviceID: try Self.string(command, "recipientDeviceId"),
          recipientE2EEKeyVersion: try Self.integer(command, "recipientE2eeKeyVersion"),
          wrappedKey: try Self.string(command, "wrappedKey")
        )
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("activateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .activateTrip)
        let lifecycle = try self.lifecycle()
        try lifecycle.activateTrip(try NativeCommandDecoder.activation(command))
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("deactivateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .deactivateTrip)
        let lifecycle = try self.lifecycle()
        try lifecycle.deactivateTrip(tripID: try Self.string(command, "tripId"))
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("setTransferPolicy") { (_: [String: Any], promise: Promise) in
      promise.reject(pendingScopeException())
    }
    AsyncFunction("reconcileNow") { (_: [String: Any], promise: Promise) in
      promise.reject(pendingScopeException())
    }
    AsyncFunction("retry") { (_: [String: Any], promise: Promise) in
      promise.reject(pendingScopeException())
    }
    AsyncFunction("getSnapshot") { () -> [String: Any] in
      Self.inactiveSnapshot()
    }
    AsyncFunction("listAssets") { (_: [String: Any]) -> [String: Any] in
      [
        "protocolVersion": 1,
        "revision": 0,
        "items": [[String: Any]](),
        "nextCursor": NSNull()
      ]
    }
  }

  private func lifecycle() throws -> NativeKeyLifecycle {
    if let productionLifecycle { return productionLifecycle }
    let value = try AppleNativeKeyInfrastructure.makeLifecycle()
    productionLifecycle = value
    return value
  }

  private func runLifecycleCleanup() {
    do {
      try lifecycle().runScheduledCleanup()
    } catch {
      // Access-locked and transient failures are retried on the next foreground wake.
    }
  }

  private static func string(_ command: [String: Any], _ key: String) throws -> String {
    try NativeCommandDecoder.string(command, key)
  }

  private static func integer(_ command: [String: Any], _ key: String) throws -> Int {
    try NativeCommandDecoder.integer(command, key)
  }

  private static func date(_ command: [String: Any], _ key: String) throws -> Date {
    try NativeCommandDecoder.date(command, key)
  }

  private static func bridgeException(_ error: Error) -> Exception {
    let code = publicErrorCode(error)
    return Exception(name: "CrewRollNativeKeyError", description: code, code: code)
  }

  private static func publicErrorCode(_ error: Error) -> String {
    guard let nativeError = error as? NativeKeyError else {
      return "KEY_MATERIAL_LOST"
    }
    switch nativeError.code {
    case "KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST", "KEY_ENVELOPE_INVALID":
      return nativeError.code
    default:
      return "KEY_ENVELOPE_INVALID"
    }
  }

  private static func inactiveSnapshot() -> [String: Any] {
    [
      "protocolVersion": 1,
      "revision": 0,
      "activeTripId": NSNull(),
      "paused": false,
      "counts": [
        "discovered": 0,
        "previewReady": 0,
        "originalsSaved": 0,
        "blocked": 0
      ],
      "blockers": [String]()
    ]
  }
}
