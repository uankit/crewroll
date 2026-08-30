package com.uankit53.crewroll.transfer

import com.uankit53.crewroll.transfer.identitykeys.AndroidNativeKeyInfrastructure
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyException
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyLifecycle
import com.uankit53.crewroll.transfer.identitykeys.NativeCommandDecoder
import com.uankit53.crewroll.transfer.identitykeys.NativeCommandKind
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.time.Instant

private const val PENDING_SCOPE_CODE = "ERR_CREWROLL_TRANSFER_SCOPE_PENDING"
private const val PENDING_SCOPE_MESSAGE =
  "This native transfer operation is outside the identity and key vertical."

private fun pendingScopeException() = CodedException(PENDING_SCOPE_CODE, PENDING_SCOPE_MESSAGE, null)

class CrewRollTransferModule : Module() {
  private var productionLifecycle: NativeKeyLifecycle? = null

  override fun definition() = ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")
    OnCreate {
      runLifecycleCleanup()
    }
    OnActivityEntersForeground {
      runLifecycleCleanup()
    }
    OnDestroy {
      productionLifecycle?.cancelScheduledCleanup()
      productionLifecycle = null
    }

    AsyncFunction("ensureDeviceIdentity") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.ENSURE_DEVICE_IDENTITY)
        val lifecycle = lifecycle()
        val identity = lifecycle.ensureDeviceIdentity(string(command, "accountId"))
        mapOf(
          "protocolVersion" to identity.protocolVersion,
          "installationId" to identity.installationId,
          "authenticationKeyAlgorithm" to identity.authenticationKeyAlgorithm,
          "authenticationPublicKey" to identity.authenticationPublicKey,
          "authenticationKeyVersion" to identity.authenticationKeyVersion,
          "e2eeKeyAlgorithm" to identity.e2eeKeyAlgorithm,
          "e2eePublicKey" to identity.e2eePublicKey,
          "e2eeKeyVersion" to identity.e2eeKeyVersion,
        )
      }
    }
    AsyncFunction("installDeviceSession") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.INSTALL_DEVICE_SESSION)
        val lifecycle = lifecycle()
        lifecycle.installDeviceSession(
          accountId = string(command, "accountId"),
          installationId = string(command, "installationId"),
          deviceId = string(command, "deviceId"),
          backgroundBearer = string(command, "backgroundBearer"),
          expiresAt = instant(command, "backgroundBearerExpiresAt"),
          apiBaseUrl = string(command, "apiBaseUrl"),
        )
        null
      }
    }
    AsyncFunction("createTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.CREATE_TRIP_KEY)
        val lifecycle = lifecycle()
        val result = lifecycle.createTripKey(string(command, "tripId"), integer(command, "keyEpoch"))
        mapOf(
          "protocolVersion" to result.protocolVersion,
          "tripId" to result.tripId,
          "keyEpoch" to result.keyEpoch,
        )
      }
    }
    AsyncFunction("discardProvisionalTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.DISCARD_PROVISIONAL_TRIP_KEY)
        val lifecycle = lifecycle()
        lifecycle.discardProvisionalTripKey(string(command, "tripId"), integer(command, "keyEpoch"))
        null
      }
    }
    AsyncFunction("wrapTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.WRAP_TRIP_KEY)
        val lifecycle = lifecycle()
        val result = lifecycle.wrapTripKey(
          tripId = string(command, "tripId"),
          keyEpoch = integer(command, "keyEpoch"),
          recipientDeviceId = string(command, "recipientDeviceId"),
          recipientE2eePublicKey = string(command, "recipientE2eePublicKey"),
          recipientE2eeKeyVersion = integer(command, "recipientE2eeKeyVersion"),
        )
        mapOf(
          "protocolVersion" to result.protocolVersion,
          "tripId" to result.tripId,
          "keyEpoch" to result.keyEpoch,
          "algorithmVersion" to result.algorithmVersion,
          "senderDeviceId" to result.senderDeviceId,
          "recipientDeviceId" to result.recipientDeviceId,
          "recipientE2eeKeyVersion" to result.recipientE2eeKeyVersion,
          "wrappedKey" to result.wrappedKey,
        )
      }
    }
    AsyncFunction("importTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.IMPORT_TRIP_KEY)
        val lifecycle = lifecycle()
        lifecycle.importTripKey(
          tripId = string(command, "tripId"),
          keyEpoch = integer(command, "keyEpoch"),
          algorithmVersion = integer(command, "algorithmVersion"),
          expectedSenderDeviceId = string(command, "expectedSenderDeviceId"),
          recipientDeviceId = string(command, "recipientDeviceId"),
          recipientE2eeKeyVersion = integer(command, "recipientE2eeKeyVersion"),
          wrappedKey = string(command, "wrappedKey"),
        )
        null
      }
    }
    AsyncFunction("activateTrip") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.ACTIVATE_TRIP)
        val lifecycle = lifecycle()
        lifecycle.activateTrip(NativeCommandDecoder.activation(command))
        null
      }
    }
    AsyncFunction("deactivateTrip") { command: Map<String, Any?>, promise: Promise ->
      bridge(promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.DEACTIVATE_TRIP)
        val lifecycle = lifecycle()
        lifecycle.deactivateTrip(string(command, "tripId"))
        null
      }
    }
    AsyncFunction("setTransferPolicy") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(pendingScopeException())
    }
    AsyncFunction("reconcileNow") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(pendingScopeException())
    }
    AsyncFunction("retry") { _: Map<String, Any?>, promise: Promise ->
      promise.reject(pendingScopeException())
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

  private fun lifecycle(): NativeKeyLifecycle {
    productionLifecycle?.let { return it }
    val context = appContext.reactContext ?: throw NativeKeyException.materialLost()
    return AndroidNativeKeyInfrastructure.makeLifecycle(context).also { productionLifecycle = it }
  }

  private fun runLifecycleCleanup() {
    try {
      lifecycle().runScheduledCleanup()
    } catch (_: Throwable) {
      // Access-locked and transient failures are retried on the next foreground wake.
    }
  }

  private fun bridge(promise: Promise, operation: () -> Any?) {
    try {
      promise.resolve(operation())
    } catch (error: NativeKeyException) {
      val code = publicErrorCode(error)
      promise.reject(CodedException(code, code, null))
    } catch (_: Throwable) {
      val code = "KEY_MATERIAL_LOST"
      promise.reject(CodedException(code, code, null))
    }
  }

  private fun publicErrorCode(error: NativeKeyException) = when (error.code) {
    "KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST", "KEY_ENVELOPE_INVALID" -> error.code
    else -> "KEY_ENVELOPE_INVALID"
  }

  private fun string(command: Map<String, Any?>, key: String): String =
    NativeCommandDecoder.string(command, key)

  private fun integer(command: Map<String, Any?>, key: String): Int =
    NativeCommandDecoder.integer(command, key)

  private fun instant(command: Map<String, Any?>, key: String): Instant =
    NativeCommandDecoder.instant(command, key)

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
