import ExpoModulesCore

private let notImplementedCode = "ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED"
private let notImplementedDescription =
  "Native transfer work is not implemented in NAT-001."

private func notImplementedException() -> Exception {
  Exception(
    name: "CrewRollTransferNotImplemented",
    description: notImplementedDescription,
    code: notImplementedCode
  )
}

public final class CrewRollTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")

    AsyncFunction("ensureDeviceIdentity") { (promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("installDeviceSession") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("createTripKey") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("discardProvisionalTripKey") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("wrapTripKey") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("importTripKey") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("activateTrip") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("deactivateTrip") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("setTransferPolicy") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("reconcileNow") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
    }
    AsyncFunction("retry") { (_: [String: Any], promise: Promise) in
      promise.reject(notImplementedException())
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
