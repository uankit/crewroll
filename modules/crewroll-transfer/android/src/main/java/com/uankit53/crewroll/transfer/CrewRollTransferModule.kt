package com.uankit53.crewroll.transfer

import com.uankit53.crewroll.transfer.identitykeys.NativeKeyException
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyLifecycle
import com.uankit53.crewroll.transfer.identitykeys.NativeCommandDecoder
import com.uankit53.crewroll.transfer.identitykeys.NativeCommandKind
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.time.Instant
import java.util.concurrent.CompletableFuture
import com.uankit53.crewroll.transfer.media.NativePhotoTransferEngine
import android.util.Log
import com.uankit53.crewroll.transfer.identitykeys.NativeOperationQueue

class CrewRollTransferModule : Module() {
  private var runtimeValue: CrewRollNativeRuntime? = null
  private val invalidation: (Long) -> Unit = { revision -> sendEvent("engineInvalidated", mapOf("protocolVersion" to 1, "type" to "ENGINE_INVALIDATED", "revision" to revision)) }
  @Volatile private var foreground = true
  private val commands = NativeOperationQueue { name, state, ms ->
    Log.i("CrewRollSession", "operation=$name state=$state durationMs=$ms")
  }
  private val mediaSession get() = runtime().mediaSession

  override fun definition() = ModuleDefinition {
    Name("CrewRollTransfer")
    Events("engineInvalidated")
    OnCreate {
      commands.submit("startup") {
        runtime().listen(invalidation)
        runLifecycleCleanup()
        runtime().foreground(foreground)
      }
    }
    OnActivityEntersForeground {
      foreground = true
      commands.submit("foregroundCleanup") {
        runLifecycleCleanup()
        runtime().foreground(foreground)
      }
    }
    OnActivityEntersBackground {
      foreground = false
      commands.submit("background") { runtime().foreground(foreground) }
    }
    OnDestroy {
      commands.submit("detach") {
        runtimeValue?.unlisten(invalidation)
        runtimeValue = null
      }
      commands.close()
    }

    AsyncFunction("ensureDeviceIdentity") { command: Map<String, Any?>, promise: Promise ->
      bridge("ensureDeviceIdentity", promise) {
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
    AsyncFunction("restoreDeviceSession") { command: Map<String, Any?>, promise: Promise ->
      bridge("restoreDeviceSession", promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.RESTORE_DEVICE_SESSION)
        val deviceId = lifecycle().restoreDeviceSession(
          string(command, "accountId"), string(command, "installationId"), string(command, "apiBaseUrl"),
        )
        deviceId?.let { mapOf("protocolVersion" to 1, "deviceId" to it) }
      }
    }
    AsyncFunction("installDeviceSession") { command: Map<String, Any?>, promise: Promise ->
      bridge("installDeviceSession", promise) {
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
    AsyncFunction("clearDeviceSession") { command: Map<String, Any?>, promise: Promise ->
      future("clearDeviceSession", promise) {
        requireCommand(command, setOf("protocolVersion"))
        val lifecycle = lifecycle()
        runtime().policy(false)
        engine().stop().thenApply { mediaSession.change { lifecycle.clearDeviceSession() }; null }
      }
    }
    AsyncFunction("eraseAccount") { command: Map<String, Any?>, promise: Promise ->
      future("eraseAccount", promise) {
        requireCommand(command, setOf("protocolVersion", "accountId"))
        val accountId = string(command, "accountId")
        runtime().policy(false)
        engine().stop().thenCompose {
          val hash = mediaSession.change { lifecycle().eraseAccount(accountId) }
          engine().eraseAccount(hash)
        }.thenApply { null }
      }
    }
    AsyncFunction("createTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge("createTripKey", promise) {
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
      bridge("discardProvisionalTripKey", promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.DISCARD_PROVISIONAL_TRIP_KEY)
        val lifecycle = lifecycle()
        lifecycle.discardProvisionalTripKey(string(command, "tripId"), integer(command, "keyEpoch"))
        null
      }
    }
    AsyncFunction("wrapTripKey") { command: Map<String, Any?>, promise: Promise ->
      bridge("wrapTripKey", promise) {
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
      bridge("importTripKey", promise) {
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
      future("activateTrip", promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.ACTIVATE_TRIP)
        val lifecycle = lifecycle()
        lifecycle.activateTrip(NativeCommandDecoder.activation(command))
        runtime().policy(true, cellular = true)
        engine().activate().thenApply { null }
      }
    }
    AsyncFunction("deactivateTrip") { command: Map<String, Any?>, promise: Promise ->
      future("deactivateTrip", promise) {
        NativeCommandDecoder.require(command, NativeCommandKind.DEACTIVATE_TRIP)
        val lifecycle = lifecycle()
        lifecycle.deactivateTrip(string(command, "tripId"))
        runtime().policy(false)
        engine().stop().thenApply { null }
      }
    }
    AsyncFunction("setTransferPolicy") { command: Map<String, Any?>, promise: Promise ->
      future("setTransferPolicy", promise) {
        NativeCommandDecoder.requireProtocol(command)
        if (command.keys != setOf("protocolVersion", "paused", "cellularAllowed") || command["paused"] !is Boolean || command["cellularAllowed"] !is Boolean) {
          throw NativeKeyException.invalidCommand()
        }
        runtime().policy(!(command["paused"] as Boolean), command["cellularAllowed"] as Boolean)
        engine().policy(command["paused"] as Boolean, command["cellularAllowed"] as Boolean).thenApply { null }
      }
    }
    AsyncFunction("reconcileNow") { command: Map<String, Any?>, promise: Promise ->
      future("reconcileNow", promise, changesSession = false) { requireCommand(command, setOf("protocolVersion")); runtime().let { if (it.enabled && it.foreground) CrewRollSyncJobs.syncNow(it.context, it.cellular) }; engine().requestReconcile().thenApply { null } }
    }
    AsyncFunction("retry") { command: Map<String, Any?>, promise: Promise ->
      future("retry", promise, changesSession = false) { requireCommand(command, setOf("protocolVersion", "workId")); engine().retry(string(command, "workId")).thenApply { null } }
    }
    AsyncFunction("getSnapshot") { promise: Promise ->
      future("getSnapshot", promise, changesSession = false) { engine().snapshot() }
    }
    AsyncFunction("listAssets") { command: Map<String, Any?>, promise: Promise ->
      future("listAssets", promise, changesSession = false) {
        val options = setOf("sourceMembershipId", "capturedFrom", "capturedBefore", "order")
        requireCommand(command, setOf("protocolVersion", "limit", "cursor") + options.filter { command.containsKey(it) })
        if (command["cursor"] != null && command["cursor"] !is String) throw NativeKeyException.invalidCommand()
        if (options.any { command.containsKey(it) && command[it] !is String }) throw NativeKeyException.invalidCommand()
        val query = com.uankit53.crewroll.transfer.media.NativeGalleryQuery(command["sourceMembershipId"] as? String,
          command["capturedFrom"] as? String, command["capturedBefore"] as? String, command["order"] as? String ?: "NEWEST")
        engine().assets(integer(command, "limit"), command["cursor"] as? String, query)
      }
    }
  }

  private fun runtime(): CrewRollNativeRuntime {
    runtimeValue?.let { return it }
    val context = appContext.reactContext?.applicationContext ?: throw NativeKeyException.materialLost()
    return CrewRollNativeRuntime.get(context).also { runtimeValue = it }
  }
  private fun lifecycle(): NativeKeyLifecycle = runtime().lifecycle
  private fun engine(): NativePhotoTransferEngine = runtime().engine
  private fun requireCommand(command: Map<String, Any?>, keys: Set<String>) {
    if (command.keys != keys) throw NativeKeyException.invalidCommand()
    NativeCommandDecoder.requireProtocol(command)
  }
  private fun future(name: String, promise: Promise, changesSession: Boolean = true, operation: () -> CompletableFuture<*>) {
    val started = System.nanoTime()
    commands.submit("dispatch_$name") {
      if (changesSession) mediaSession.change(operation) else operation()
    }.whenComplete { pending, queueError ->
      if (queueError != null) reject(promise, queueError)
      else pending.whenComplete { value, error ->
        if (changesSession) mediaSession.clear()
        val elapsed = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        Log.i("CrewRollSession", "operation=$name state=${if (error == null) "completed" else "failed"} durationMs=$elapsed")
        if (error == null) promise.resolve(value) else reject(promise, error)
      }
    }
  }

  private fun runLifecycleCleanup() {
    // Errors are recorded by the queue and surfaced by the next session operation.
    lifecycle().runScheduledCleanup()
  }

  private fun bridge(name: String, promise: Promise, operation: () -> Any?) {
    commands.submit(name) { mediaSession.change(operation) }.whenComplete { value, error ->
      if (error == null) promise.resolve(value) else reject(promise, error)
    }
  }

  private fun reject(promise: Promise, error: Throwable) {
    val cause = error.cause ?: error
    val code = if (cause is NativeKeyException) publicErrorCode(cause) else "ERR_CREWROLL_NATIVE_PROTOCOL"
    promise.reject(CodedException(code, code, null))
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

}
