import ExpoModulesCore
import CoreFoundation

public final class CrewRollTransferModule: Module {
  private var invalidationObserver: NSObjectProtocol?
  private var pushObserver: NSObjectProtocol?
  private let transferCommands = NativeTransferCommandFence.shared

  public func definition() -> ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated", "pushHint")
    OnCreate {
      self.invalidationObserver = NotificationCenter.default.addObserver(forName: .crewRollEngineInvalidated, object: nil, queue: nil) { [weak self] event in
        if let revision = event.userInfo?["revision"] as? Int { self?.sendEvent("engineInvalidated", ["protocolVersion": 1, "type": "ENGINE_INVALIDATED", "revision": revision]) }
      }
      self.pushObserver = NotificationCenter.default.addObserver(forName: .crewRollPushHint, object: nil, queue: nil) { [weak self] event in
        guard let info = event.userInfo else { return }
        var data: [String: Any] = [:]
        for key in ["type", "deviceId", "tripId", "eventId"] { data[key] = info[key] }
        if let hint = NativePushHint.parse(data) { self?.sendEvent("pushHint", hint.data) }
      }
    }
    OnAppEntersForeground {
      CrewRollAppleRuntime.lifecycleWork.submit {
        CrewRollAppleRuntime.setForeground(true)
      }
    }
    OnDestroy {
      if let observer = self.invalidationObserver { NotificationCenter.default.removeObserver(observer) }
      self.invalidationObserver = nil
      if let observer = self.pushObserver { NotificationCenter.default.removeObserver(observer) }
      self.pushObserver = nil
    }

    AsyncFunction("prepareDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .prepareDeviceSession)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        let prepared = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.prepareDeviceSession(accountID: Self.string(command, "accountId"),
            apiBaseURL: Self.string(command, "apiBaseUrl"))
        }
        let identity = prepared.identity
        var result: [String: Any] = [
          "protocolVersion": 1,
          "identity": [
            "protocolVersion": identity.protocolVersion,
            "installationId": identity.installationID,
            "authenticationKeyAlgorithm": identity.authenticationKeyAlgorithm,
            "authenticationPublicKey": identity.authenticationPublicKey,
            "authenticationKeyVersion": identity.authenticationKeyVersion,
            "e2eeKeyAlgorithm": identity.e2eeKeyAlgorithm,
            "e2eePublicKey": identity.e2eePublicKey,
            "e2eeKeyVersion": identity.e2eeKeyVersion,
          ],
          "restoredSession": NSNull(),
          "activeTripId": NSNull(),
        ]
        if let deviceID = prepared.restoredDeviceID {
          result["restoredSession"] = ["protocolVersion": 1, "deviceId": deviceID]
        }
        if let tripID = prepared.activeTripID { result["activeTripId"] = tripID }
        promise.resolve(result)
        CrewRollAppleRuntime.existing()?.requestRetentionMaintenance()
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("ensureDeviceIdentity") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .ensureDeviceIdentity)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        let identity = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.ensureDeviceIdentity(
            accountID: try Self.string(command, "accountId")
          )
        }
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
    AsyncFunction("getActiveTripSelection") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .getActiveTripSelection)
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        let selected = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.getActiveTripSelection(accountID: Self.string(command, "accountId"),
            installationID: Self.string(command, "installationId"))
        }
        var result: [String: Any] = ["protocolVersion": 1, "activeTripId": NSNull()]
        if let selected { result["activeTripId"] = selected }
        promise.resolve(result)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("restoreDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .restoreDeviceSession)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        let deviceID = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.restoreDeviceSession(
            accountID: try Self.string(command, "accountId"),
            installationID: try Self.string(command, "installationId"),
            apiBaseURL: try Self.string(command, "apiBaseUrl")
          )
        }
        if let deviceID { promise.resolve(["protocolVersion": 1, "deviceId": deviceID]) }
        else { promise.resolve(nil) }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("installDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .installDeviceSession)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        try self.transferCommands.withCurrent(epoch) {
          try lifecycle.installDeviceSession(
            accountID: try Self.string(command, "accountId"),
            installationID: try Self.string(command, "installationId"),
            deviceID: try Self.string(command, "deviceId"),
            backgroundBearer: try Self.string(command, "backgroundBearer"),
            expiresAt: try Self.date(command, "backgroundBearerExpiresAt"),
            apiBaseURL: try Self.string(command, "apiBaseUrl")
          )
        }
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("refreshDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .refreshDeviceSession)
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        let changed = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.refreshDeviceSession(
            accountID: try Self.string(command, "accountId"),
            installationID: try Self.string(command, "installationId"),
            deviceID: try Self.string(command, "deviceId"),
            backgroundBearer: try Self.string(command, "backgroundBearer"),
            expiresAt: try Self.date(command, "backgroundBearerExpiresAt"),
            apiBaseURL: try Self.string(command, "apiBaseUrl")
          )
        }
        if changed {
          let engine = try self.engine()
          let deviceID = try Self.string(command, "deviceId")
          let fence = self.transferCommands
          Task { try? await engine.credentialRefreshed(deviceID: deviceID, ifCurrent: { fence.matches(epoch) }) }
        }
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("clearDeviceSession") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion"])
        let epoch = self.transferCommands.advance()
        let runtime = try CrewRollAppleRuntime.get()
        let lifecycle = runtime.lifecycle
        let engine = runtime.existingEngine
        try self.transferCommands.withCurrent(epoch) { runtime.policy(enabled: false) }
        Task {
          do {
            if let engine { await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { self.transferCommands.matches(epoch) }) }
            try await AppleBackgroundTransfer.shared.clear(ifCurrent: { self.transferCommands.matches(epoch) },
              protectedMutation: { work in try self.transferCommands.withCurrent(epoch, work) })
            try self.transferCommands.withCurrent(epoch) { try lifecycle.clearDeviceSession() }
            promise.resolve(nil)
          } catch { promise.reject(Self.bridgeException(error)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("eraseAccount") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion", "accountId"])
        let epoch = self.transferCommands.advance()
        let accountID = try Self.string(command, "accountId")
        let runtime = try CrewRollAppleRuntime.get()
        let lifecycle = runtime.lifecycle
        let engine = runtime.engine
        try self.transferCommands.withCurrent(epoch) { runtime.policy(enabled: false) }
        Task {
          do {
            await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { self.transferCommands.matches(epoch) })
            try await AppleBackgroundTransfer.shared.clear(ifCurrent: { self.transferCommands.matches(epoch) },
              protectedMutation: { work in try self.transferCommands.withCurrent(epoch, work) })
            let hash = try self.transferCommands.withCurrent(epoch) { try lifecycle.eraseAccount(accountID: accountID) }
            try await engine.eraseAccount(accountHash: hash, ifCurrent: { self.transferCommands.matches(epoch) },
              protectedMutation: { work in try self.transferCommands.withCurrent(epoch, work) })
            promise.resolve(nil)
          } catch { promise.reject(Self.bridgeException(error)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("createTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .createTripKey)
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        let result = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.createTripKey(
            tripID: try Self.string(command, "tripId"),
            keyEpoch: try Self.integer(command, "keyEpoch")
          )
        }
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
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        try self.transferCommands.withCurrent(epoch) {
          try lifecycle.discardProvisionalTripKey(
            tripID: try Self.string(command, "tripId"),
            keyEpoch: try Self.integer(command, "keyEpoch")
          )
        }
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("wrapTripKey") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .wrapTripKey)
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        let result = try self.transferCommands.withCurrent(epoch) {
          try lifecycle.wrapTripKey(
            tripID: try Self.string(command, "tripId"),
            keyEpoch: try Self.integer(command, "keyEpoch"),
            recipientDeviceID: try Self.string(command, "recipientDeviceId"),
            recipientE2EEPublicKey: try Self.string(command, "recipientE2eePublicKey"),
            recipientE2EEKeyVersion: try Self.integer(command, "recipientE2eeKeyVersion")
          )
        }
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
        let epoch = self.transferCommands.current()
        let lifecycle = try self.lifecycle()
        try self.transferCommands.withCurrent(epoch) {
          try lifecycle.importTripKey(
            tripID: try Self.string(command, "tripId"),
            keyEpoch: try Self.integer(command, "keyEpoch"),
            algorithmVersion: try Self.integer(command, "algorithmVersion"),
            expectedSenderDeviceID: try Self.string(command, "expectedSenderDeviceId"),
            recipientDeviceID: try Self.string(command, "recipientDeviceId"),
            recipientE2EEKeyVersion: try Self.integer(command, "recipientE2eeKeyVersion"),
            wrappedKey: try Self.string(command, "wrappedKey"),
            endsAt: try Self.string(command, "endsAt")
          )
        }
        let engine = try self.engine()
        Task { try? await engine.reconcileRetention(force: true) }
        promise.resolve(nil)
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("importAndActivateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .importAndActivateTrip)
        let epoch = self.transferCommands.advance()
        let runtime = try CrewRollAppleRuntime.get()
        try self.transferCommands.withCurrent(epoch) {
          try runtime.lifecycle.importAndActivateTrip(command)
          runtime.policy(enabled: true, cellular: true)
        }
        let engine = runtime.engine
        // Preserve import's independent retention wake without holding the
        // selection fence across an engine await.
        Task { try? await engine.reconcileRetention(force: true) }
        Task {
          do {
            await engine.foreground(runtime.foregroundSnapshot)
            await engine.activate(ifCurrent: { self.transferCommands.matches(epoch) })
            try self.transferCommands.withCurrent(epoch) { }
            promise.resolve(nil)
          } catch { promise.reject(Self.bridgeException(NativeKeyError.tripActivationFailed)) }
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("activateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .activateTrip)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        let runtime = try CrewRollAppleRuntime.get()
        let engine = runtime.engine
        try self.transferCommands.withCurrent(epoch) {
          try lifecycle.activateTrip(try NativeCommandDecoder.activation(command))
          runtime.policy(enabled: true, cellular: true)
        }
        Task {
          await engine.foreground(runtime.foregroundSnapshot)
          await engine.activate(ifCurrent: { self.transferCommands.matches(epoch) })
          promise.resolve(nil)
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("deactivateTrip") { (command: [String: Any], promise: Promise) in
      do {
        try NativeCommandDecoder.require(command, for: .deactivateTrip)
        let epoch = self.transferCommands.advance()
        let lifecycle = try self.lifecycle()
        let runtime = try CrewRollAppleRuntime.get()
        let engine = runtime.engine
        try self.transferCommands.withCurrent(epoch) {
          try lifecycle.deactivateTrip(tripID: try Self.string(command, "tripId"))
          runtime.policy(enabled: false)
        }
        Task {
          await engine.setPolicy(paused: true, cellularAllowed: false, ifCurrent: { self.transferCommands.matches(epoch) })
          promise.resolve(nil)
        }
      } catch { promise.reject(Self.bridgeException(error)) }
    }
    AsyncFunction("setTransferPolicy") { (command: [String: Any], promise: Promise) in
      do {
        try Self.require(command, keys: ["protocolVersion", "paused", "cellularAllowed"])
        guard let pausedValue = command["paused"] as? NSNumber, CFGetTypeID(pausedValue) == CFBooleanGetTypeID(),
              let cellularValue = command["cellularAllowed"] as? NSNumber, CFGetTypeID(cellularValue) == CFBooleanGetTypeID() else { throw NativeKeyError.invalidCommand }
        let epoch = self.transferCommands.advance()
        let runtime = try CrewRollAppleRuntime.get()
        try self.transferCommands.withCurrent(epoch) {
          runtime.policy(enabled: !pausedValue.boolValue, cellular: cellularValue.boolValue)
        }
        if pausedValue.boolValue && runtime.existingEngine == nil {
          // No native lanes or saves exist to drain in this process. Persisting
          // the paused policy and advancing the fence is the complete boundary.
          promise.resolve(nil)
          runtime.requestRetentionMaintenance()
          return
        }
        let engine = runtime.engine
        Task {
          if !pausedValue.boolValue { await engine.foreground(runtime.foregroundSnapshot) }
          await engine.setPolicy(paused: pausedValue.boolValue, cellularAllowed: cellularValue.boolValue, ifCurrent: { self.transferCommands.matches(epoch) })
          promise.resolve(nil)
          runtime.requestRetentionMaintenance()
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
    case "KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST", "KEY_ENVELOPE_INVALID", "ERR_CREWROLL_TRIP_ACTIVATION":
      return nativeError.code
    default:
      return "KEY_ENVELOPE_INVALID"
    }
  }

}
