package com.uankit53.crewroll.transfer

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val NOT_IMPLEMENTED_CODE =
  "ERR_CREWROLL_TRANSFER_NOT_IMPLEMENTED"
private const val NOT_IMPLEMENTED_MESSAGE =
  "Native transfer work is not implemented in NAT-001."

private fun notImplementedException() =
  CodedException(NOT_IMPLEMENTED_CODE, NOT_IMPLEMENTED_MESSAGE, null)

class CrewRollTransferModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")

    AsyncFunction("ensureDeviceIdentity") { promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("installDeviceSession") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("createTripKey") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("discardProvisionalTripKey") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("wrapTripKey") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("importTripKey") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("activateTrip") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("deactivateTrip") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("setTransferPolicy") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("reconcileNow") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("retry") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(notImplementedException())
    }
    AsyncFunction("getSnapshot") {
      inactiveSnapshot()
    }
    AsyncFunction("listAssets") { _: Map<String, Any?> ->
      mapOf(
        "protocolVersion" to 1,
        "revision" to 0,
        "items" to emptyList<Map<String, Any?>>(),
        "nextCursor" to null
      )
    }
  }

  private fun inactiveSnapshot() = mapOf(
    "protocolVersion" to 1,
    "revision" to 0,
    "activeTripId" to null,
    "paused" to false,
    "counts" to mapOf(
      "discovered" to 0,
      "previewReady" to 0,
      "originalsSaved" to 0,
      "blocked" to 0
    ),
    "blockers" to emptyList<String>()
  )
}
