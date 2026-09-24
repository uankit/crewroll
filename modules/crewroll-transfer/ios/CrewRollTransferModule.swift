import ExpoModulesCore
import CoreFoundation

public final class CrewRollTransferModule: Module {
  private var invalidationObserver: NSObjectProtocol?
  private let transferCommands = NativeTransferCommandFence()

  public func definition() -> ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")
    OnCreate {
      self.runLifecycleCleanup()
      self.invalidationObserver = NotificationCenter.default.addObserver(forName: .crewRollEngineInvalidated, object: nil, queue: nil) { [weak self] event in
        if let revision = event.userInfo?["revision"] as? Int { self?.sendEvent("engineInvalidated", ["protocolVersion": 1, "type": "ENGINE_INVALIDATED", "revision": revision]) }
      }
    }
    OnAppEntersForeground {
      self.runLifecycleCleanup()
      try? CrewRollAppleRuntime.get().foreground(true)
      if let engine = try? self.engine() { Task { await engine.wake() } }
    }
    OnDestroy {
      if let observer = self.invalidationObserver { NotificationCenter.default.removeObserver(observer) }
      self.invalidationObserver = nil
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
    AsyncFunction("restoreDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .restoreDeviceSession)
        let deviceID = try self.lifecycle().restoreDeviceSession(
          accountID: try Self.string(command, "accountId"),
          installationID: try Self.string(command, "installationId"),
          apiBaseURL: try Self.string(command, "apiBaseUrl")
        )
        if let deviceID { promise.resolve(["protocolVersion": 1, "deviceId": deviceID]) }
        else { promise.resolve(nil) }
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
    AsyncFunction("clearDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion"])
        let lifecycle = try self.lifecycle()
        let engine = try self.engine()
        let epoch = self.transferCommands.advance()
        Task {
          await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { self.transferCommands.matches(epoch) })
          do {
            guard self.transferCommands.matches(epoch) else { throw NativeKeyError.invalidCommand }
            try CrewRollAppleRuntime.get().policy(enabled: false)
            await AppleBackgroundTransfer.shared.clear()
            try lifecycle.clearDeviceSession()
            promise.resolve(nil)
          } catch { promise.reject(Self.bridgeException(error)) }
        }
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
        try CrewRollAppleRuntime.get().policy(enabled: true, cellular: true)
        let engine = try self.engine()
        let epoch = self.transferCommands.advance()
        Task {
          await engine.activate(ifCurrent: { self.transferCommands.matches(epoch) })
          promise.resolve(nil)
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("deactivateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .deactivateTrip)
        let lifecycle = try self.lifecycle()
        try lifecycle.deactivateTrip(tripID: try Self.string(command, "tripId"))
        try CrewRollAppleRuntime.get().policy(enabled: false)
        let epoch = self.transferCommands.advance()
        if let engine = try? self.engine() {
          Task {
            await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { self.transferCommands.matches(epoch) })
            promise.resolve(nil)
          }
        } else { promise.resolve(nil) }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("setTransferPolicy") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion", "paused", "cellularAllowed"])
        guard let pausedValue = command["paused"] as? NSNumber, CFGetTypeID(pausedValue) == CFBooleanGetTypeID(),
              let cellularValue = command["cellularAllowed"] as? NSNumber, CFGetTypeID(cellularValue) == CFBooleanGetTypeID() else { throw NativeKeyError.invalidCommand }
        let engine = try self.engine()
        try CrewRollAppleRuntime.get().policy(enabled: !pausedValue.boolValue, cellular: cellularValue.boolValue)
        let epoch = self.transferCommands.advance()
        Task {
          await engine.setPolicy(paused: pausedValue.boolValue, cellularAllowed: cellularValue.boolValue, ifCurrent: { self.transferCommands.matches(epoch) })
          promise.resolve(nil)
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("reconcileNow") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion"])
        let engine = try self.engine()
        Task { do { try await engine.reconcileNow(); promise.resolve(nil) } catch { promise.reject(Self.bridgeException(error)) } }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("retry") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion", "workId"])
        let workID = try Self.string(command, "workId")
        guard UUID(uuidString: workID) != nil else { throw NativeKeyError.invalidCommand }
        let engine = try self.engine()
        Task {
          do { try await engine.retry(workID: workID.lowercased()); promise.resolve(nil) }
          catch { promise.reject(Self.bridgeException(error)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("getSnapshot") { (promise: Promise) in
      do {
        let engine = try self.engine()
        Task {
          do { promise.resolve(try await engine.snapshot()) }
          catch { promise.reject(Self.bridgeException(error)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("listAssets") { (command: [String: Any], promise: Promise) in
      do {
        let options: Set<String> = ["sourceMembershipId", "capturedFrom", "capturedBefore", "order"]
        try Self.require(command, keys: Set(["protocolVersion", "cursor", "limit"]).union(options.intersection(command.keys)))
        guard options.allSatisfy({ command[$0] == nil || command[$0] is String }) else { throw NativeKeyError.invalidCommand }
        let query = try NativeGalleryQuery(sourceMembershipID: command["sourceMembershipId"] as? String,
          capturedFrom: command["capturedFrom"] as? String, capturedBefore: command["capturedBefore"] as? String, order: command["order"] as? String ?? "NEWEST")
        let limit = try Self.integer(command, "limit")
        let cursor = command["cursor"] as? String
        guard cursor != nil || command["cursor"] is NSNull else { throw NativeKeyError.invalidCommand }
        let engine = try self.engine()
        Task {
          do { promise.resolve(try await engine.listAssets(limit: limit, cursor: cursor, query: query)) }
          catch { promise.reject(Self.bridgeException(error)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
  }

  private func engine() throws -> ApplePhotoTransferEngine { try CrewRollAppleRuntime.get().engine }

  private static func require(_ command: [String: Any], keys: Set<String>) throws {
    guard Set(command.keys) == keys else { throw NativeKeyError.invalidCommand }
    try NativeCommandDecoder.requireProtocol(command)
  }

  private func lifecycle() throws -> NativeKeyLifecycle { try CrewRollAppleRuntime.get().lifecycle }

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

}
