package com.uankit53.crewroll.transfer.identitykeys

import java.nio.ByteBuffer
import java.time.Instant
import java.time.OffsetDateTime
import java.time.Duration
import java.util.Base64
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class NativeKeyException(val code: String) : RuntimeException(code) {
  companion object {
    fun accessLocked() = NativeKeyException("KEY_ACCESS_LOCKED")
    fun materialLost() = NativeKeyException("KEY_MATERIAL_LOST")
    fun invalidEnvelope() = NativeKeyException("KEY_ENVELOPE_INVALID")
    fun invalidState() = NativeKeyException("ERR_CREWROLL_KEY_STATE")
    fun invalidCommand() = NativeKeyException("ERR_CREWROLL_NATIVE_PROTOCOL")
  }
}

fun interface NativeKeyClock { fun now(): Instant }
data class NativeKeyScope(val accountHash: String, val installationId: String)
fun interface AccountNamespaceHasher { fun hash(accountId: String): String }
enum class TripCreateOutcome { CREATED, EXISTING, TOMBSTONED }
enum class ProvisionalDiscardOutcome { ABSENT, DISCARDED, PROTECTED }
enum class TripImportOutcome { INSTALLED, EXISTING, CONFLICT }
enum class KeyState { PROVISIONAL, INSTALLED, ACTIVE, RETAINED }

data class TripKeyRecord(
  val key: ByteArray,
  val state: KeyState,
  val createdAt: Instant? = null,
  val provisionalExpiresAt: Instant? = null,
) {
  override fun equals(other: Any?) = other is TripKeyRecord &&
    key.contentEquals(other.key) && state == other.state &&
    createdAt == other.createdAt && provisionalExpiresAt == other.provisionalExpiresAt
  override fun hashCode() = 31 * key.contentHashCode() + state.hashCode()
}

data class DeviceIdentityMaterial(
  val installationId: String,
  val authenticationPublicKey: ByteArray,
  val e2eePublicKey: ByteArray,
  val e2eePrivateKey: ByteArray,
)

data class DeviceSessionRecord(
  val deviceId: String,
  val backgroundBearer: ByteArray,
  val expiresAt: Instant,
  val apiBaseUrl: String,
)
data class ScopedDeviceSession(val scope: NativeKeyScope, val session: DeviceSessionRecord)

data class ActiveTripMetadata(
  val tripId: String,
  val membershipId: String,
  val startsAt: String,
  val endsAt: String,
  val releaseAt: String?,
  val keyEpoch: Int,
)

interface NativeKeyStore {
  fun loadIdentity(accountHash: String): DeviceIdentityMaterial?
  fun reservePendingIdentity(accountHash: String, makeInstallationId: () -> String): NativeKeyScope
  fun finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial)
  fun hasScopedMaterial(accountHash: String): Boolean
  fun activeSession(): ScopedDeviceSession?
  fun installSession(scope: NativeKeyScope, value: DeviceSessionRecord)
  fun createTrip(scope: NativeKeyScope, tripId: String, makeValue: () -> TripKeyRecord): TripCreateOutcome
  fun loadTrip(scope: NativeKeyScope, tripId: String): TripKeyRecord?
  fun discardProvisional(scope: NativeKeyScope, tripId: String): ProvisionalDiscardOutcome
  fun collectExpiredProvisional(now: Instant): Instant?
  fun importTrip(scope: NativeKeyScope, tripId: String, key: ByteArray): TripImportOutcome
  fun activate(scope: NativeKeyScope, metadata: ActiveTripMetadata)
  fun deactivate(scope: NativeKeyScope, tripId: String)
}

data class X25519KeyPair(val publicKey: ByteArray, val privateKey: ByteArray)
interface NativeKeyCrypto {
  fun randomBytes(count: Int): ByteArray
  fun makeX25519KeyPair(): X25519KeyPair
  fun deriveX25519PublicKey(privateKey: ByteArray): ByteArray
  fun constantTimeEquals(lhs: ByteArray, rhs: ByteArray): Boolean
  fun zeroize(value: ByteArray)
  fun seal(plaintext: ByteArray, recipientPublicKey: ByteArray): ByteArray
  fun open(ciphertext: ByteArray, publicKey: ByteArray, privateKey: ByteArray): ByteArray
}
interface P256IdentityProvider {
  fun createPublicKey(scope: NativeKeyScope): ByteArray
  fun loadPublicKey(scope: NativeKeyScope): ByteArray?
}

internal fun androidP256Alias(scope: NativeKeyScope): String {
  if (!scope.accountHash.matches(Regex("^[a-f0-9]{64}$")) ||
    !scope.installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
    throw NativeKeyException.materialLost()
  }
  return "crewroll.p256.v2.${scope.accountHash}.${scope.installationId}"
}

data class NativeDeviceIdentity(
  val protocolVersion: Int = 1,
  val installationId: String,
  val authenticationKeyAlgorithm: String = "P-256",
  val authenticationPublicKey: String,
  val authenticationKeyVersion: Int = 1,
  val e2eeKeyAlgorithm: String = "X25519",
  val e2eePublicKey: String,
  val e2eeKeyVersion: Int = 1,
)

data class CreateTripKeyResult(val protocolVersion: Int = 1, val tripId: String, val keyEpoch: Int = 1)
data class WrapTripKeyResult(
  val protocolVersion: Int = 1,
  val tripId: String,
  val keyEpoch: Int = 1,
  val algorithmVersion: Int = 1,
  val senderDeviceId: String,
  val recipientDeviceId: String,
  val recipientE2eeKeyVersion: Int = 1,
  val wrappedKey: String,
)

object CanonicalBase64 {
  fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
  fun decode(value: String, exactBytes: Int): ByteArray {
    if (!value.matches(Regex("^[A-Za-z0-9+/]*={0,2}$"))) throw NativeKeyException.invalidEnvelope()
    val decoded = try { Base64.getDecoder().decode(value) } catch (_: IllegalArgumentException) {
      throw NativeKeyException.invalidEnvelope()
    }
    if (decoded.size != exactBytes || encode(decoded) != value) throw NativeKeyException.invalidEnvelope()
    return decoded
  }
}

object TripKeyEnvelopeV1 {
  fun encode(
    tripId: String,
    senderDeviceId: String,
    recipientDeviceId: String,
    recipientE2eeKeyVersion: Int,
    tripKey: ByteArray,
  ): ByteArray {
    if (recipientE2eeKeyVersion != 1 || tripKey.size != 32) throw NativeKeyException.invalidCommand()
    return ByteBuffer.allocate(100)
      .put("CRTKENV1".toByteArray(Charsets.US_ASCII))
      .putInt(1).put(uuidBytes(tripId)).putInt(1)
      .put(uuidBytes(senderDeviceId)).put(uuidBytes(recipientDeviceId)).putInt(1).put(tripKey)
      .array()
  }

  fun decode(
    value: ByteArray,
    tripId: String,
    senderDeviceId: String,
    recipientDeviceId: String,
    recipientE2eeKeyVersion: Int,
  ): ByteArray {
    if (value.size != 100 || recipientE2eeKeyVersion != 1 ||
      !value.copyOfRange(0, 8).contentEquals("CRTKENV1".toByteArray(Charsets.US_ASCII)) ||
      readU32(value, 8) != 1 || !value.copyOfRange(12, 28).contentEquals(uuidBytes(tripId)) ||
      readU32(value, 28) != 1 || !value.copyOfRange(32, 48).contentEquals(uuidBytes(senderDeviceId)) ||
      !value.copyOfRange(48, 64).contentEquals(uuidBytes(recipientDeviceId)) || readU32(value, 64) != 1
    ) throw NativeKeyException.invalidEnvelope()
    return value.copyOfRange(68, 100)
  }

  fun uuidBytes(value: String): ByteArray {
    val uuid = try { UUID.fromString(value) } catch (_: IllegalArgumentException) {
      throw NativeKeyException.invalidCommand()
    }
    return ByteBuffer.allocate(16).putLong(uuid.mostSignificantBits).putLong(uuid.leastSignificantBits).array()
  }
  private fun readU32(value: ByteArray, offset: Int) = ByteBuffer.wrap(value, offset, 4).int
}

enum class NativeCommandKind(val exactKeys: Set<String>, val hasTripId: Boolean) {
  ENSURE_DEVICE_IDENTITY(setOf("protocolVersion", "accountId"), false),
  INSTALL_DEVICE_SESSION(setOf(
    "protocolVersion",
    "accountId",
    "installationId",
    "deviceId",
    "backgroundBearer",
    "backgroundBearerExpiresAt",
    "apiBaseUrl",
  ), false),
  CREATE_TRIP_KEY(setOf("protocolVersion", "tripId", "keyEpoch"), true),
  DISCARD_PROVISIONAL_TRIP_KEY(setOf("protocolVersion", "tripId", "keyEpoch"), true),
  WRAP_TRIP_KEY(setOf(
    "protocolVersion",
    "tripId",
    "keyEpoch",
    "recipientDeviceId",
    "recipientE2eePublicKey",
    "recipientE2eeKeyVersion",
  ), true),
  IMPORT_TRIP_KEY(setOf(
    "protocolVersion",
    "tripId",
    "keyEpoch",
    "algorithmVersion",
    "expectedSenderDeviceId",
    "recipientDeviceId",
    "recipientE2eeKeyVersion",
    "wrappedKey",
  ), true),
  ACTIVATE_TRIP(setOf(
    "protocolVersion",
    "tripId",
    "membershipId",
    "startsAt",
    "endsAt",
    "releaseAt",
    "keyEpoch",
  ), true),
  DEACTIVATE_TRIP(setOf("protocolVersion", "tripId"), true),
}

object NativeCommandDecoder {
  private val rfc3339 = Regex(
    "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$",
  )

  fun require(command: Map<String, Any?>, kind: NativeCommandKind) {
    if (command.keys != kind.exactKeys) throw NativeKeyException.invalidCommand()
    requireProtocol(command)
    if (kind.hasTripId) requireTripId(string(command, "tripId"))
  }

  fun requireProtocol(command: Map<String, Any?>) {
    if (integer(command, "protocolVersion") != 1) throw NativeKeyException.invalidCommand()
  }

  fun string(command: Map<String, Any?>, key: String): String =
    (command[key] as? String)?.takeIf(String::isNotEmpty) ?: throw NativeKeyException.invalidCommand()

  fun integer(command: Map<String, Any?>, key: String): Int {
    val number = command[key] as? Number ?: throw NativeKeyException.invalidCommand()
    val value = number.toDouble()
    if (!value.isFinite() || value < 0 || value > Int.MAX_VALUE.toDouble() || value % 1.0 != 0.0) {
      throw NativeKeyException.invalidCommand()
    }
    return value.toInt().also {
      if (it.toDouble() != value) throw NativeKeyException.invalidCommand()
    }
  }

  fun instant(command: Map<String, Any?>, key: String): Instant = rfc3339Instant(string(command, key))

  fun activation(command: Map<String, Any?>): ActiveTripMetadata {
    require(command, NativeCommandKind.ACTIVATE_TRIP)
    if (!command.containsKey("releaseAt")) throw NativeKeyException.invalidCommand()
    val releaseAt = when (val raw = command["releaseAt"]) {
      null -> null
      is String -> raw.also(::rfc3339Instant)
      else -> throw NativeKeyException.invalidCommand()
    }
    return ActiveTripMetadata(
      string(command, "tripId"),
      string(command, "membershipId"),
      string(command, "startsAt"),
      string(command, "endsAt"),
      releaseAt,
      integer(command, "keyEpoch"),
    ).also(::validate)
  }

  fun validate(metadata: ActiveTripMetadata) {
    requireTripId(metadata.tripId)
    canonicalUuid(metadata.membershipId)
    rfc3339Instant(metadata.startsAt)
    rfc3339Instant(metadata.endsAt)
    metadata.releaseAt?.let(::rfc3339Instant)
    if (metadata.keyEpoch != 1) throw NativeKeyException.invalidCommand()
  }

  fun requireTripId(value: String) {
    val parsed = try { UUID.fromString(value) } catch (_: IllegalArgumentException) {
      throw NativeKeyException.invalidCommand()
    }
    if (parsed.toString() != value || parsed.version() != 7 || parsed.variant() != 2) {
      throw NativeKeyException.invalidCommand()
    }
  }

  private fun canonicalUuid(value: String) {
    val parsed = try { UUID.fromString(value) } catch (_: IllegalArgumentException) {
      throw NativeKeyException.invalidCommand()
    }
    if (parsed.toString() != value.lowercase()) throw NativeKeyException.invalidCommand()
  }

  private fun rfc3339Instant(value: String): Instant {
    if (!rfc3339.matches(value)) throw NativeKeyException.invalidCommand()
    return try { OffsetDateTime.parse(value).toInstant() } catch (_: Throwable) {
      throw NativeKeyException.invalidCommand()
    }
  }
}

interface NativeKeyCleanupScheduling {
  fun schedule(at: Instant, action: () -> Unit)
  fun cancel()
  fun close()
}

class ExecutorNativeKeyCleanupScheduler : NativeKeyCleanupScheduling {
  private val lock = Any()
  private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "crewroll-native-key-cleanup").apply { isDaemon = true }
  }
  private var pending: ScheduledFuture<*>? = null
  private var isClosed = false

  override fun schedule(at: Instant, action: () -> Unit) {
    val delayMillis = Duration.between(Instant.now(), at).toMillis().coerceAtLeast(0)
    synchronized(lock) {
      if (isClosed) return
      pending?.cancel(false)
      pending = executor.schedule(action, delayMillis, TimeUnit.MILLISECONDS)
    }
  }

  override fun cancel() = synchronized(lock) {
    pending?.cancel(false)
    pending = null
  }

  override fun close() {
    synchronized(lock) {
      if (isClosed) return
      isClosed = true
      pending?.cancel(false)
      pending = null
    }
    executor.shutdownNow()
  }
}

class NativeKeyCleanupRunner(
  private val clock: NativeKeyClock,
  private val store: NativeKeyStore,
) {
  private val lock = ReentrantLock()
  fun run(): Instant? = lock.withLock { store.collectExpiredProvisional(clock.now()) }
}

class NativeKeyCleanupCoordinator(
  private val runner: NativeKeyCleanupRunner,
  private val scheduler: NativeKeyCleanupScheduling,
) {
  private val lock = ReentrantLock()
  private var scheduledAt: Instant? = null
  private var generation = 0L
  private var isCancelled = false

  fun reconcile() {
    lock.withLock {
      if (isCancelled) return@withLock
      generation += 1
      scheduler.cancel()
      scheduledAt = null
      runner.run()?.let(::armLocked)
    }
  }

  fun schedule(at: Instant) {
    lock.withLock {
      if (isCancelled || scheduledAt?.let { !at.isBefore(it) } == true) {
        return@withLock
      }
      generation += 1
      scheduler.cancel()
      armLocked(at)
    }
  }

  fun cancel() {
    lock.withLock {
      if (isCancelled) return@withLock
      isCancelled = true
      generation += 1
      scheduledAt = null
      scheduler.close()
    }
  }

  private fun armLocked(at: Instant) {
    val expectedGeneration = generation
    scheduledAt = at
    scheduler.schedule(at) { fire(expectedGeneration, at) }
  }

  private fun fire(expectedGeneration: Long, expectedDate: Instant) {
    lock.withLock {
      if (isCancelled || generation != expectedGeneration || scheduledAt != expectedDate) {
        return@withLock
      }
      scheduledAt = null
      try {
        runner.run()?.let {
          generation += 1
          armLocked(it)
        }
      } catch (_: Throwable) {
        // Access-locked/transient failures remain disarmed until the next wake.
      }
    }
  }
}

class NativeKeyLifecycle(
  private val clock: NativeKeyClock,
  private val store: NativeKeyStore,
  private val crypto: NativeKeyCrypto,
  private val p256: P256IdentityProvider,
  private val accountHasher: AccountNamespaceHasher,
  cleanupScheduler: NativeKeyCleanupScheduling? = null,
) {
  private val cleanupRunner = NativeKeyCleanupRunner(clock, store)
  private val cleanupCoordinator = cleanupScheduler?.let {
    NativeKeyCleanupCoordinator(cleanupRunner, it)
  }
  fun ensureDeviceIdentity(accountId: String): NativeDeviceIdentity {
    prepare()
    val accountHash = hashAccountId(accountId)
    store.loadIdentity(accountHash)?.let { existing ->
      try {
        return publicIdentity(existing, NativeKeyScope(accountHash, existing.installationId))
      } finally { crypto.zeroize(existing.e2eePrivateKey) }
    }
    if (store.hasScopedMaterial(accountHash)) throw NativeKeyException.materialLost()
    val scope = store.reservePendingIdentity(accountHash) {
      val installationBytes = crypto.randomBytes(16)
      try {
        if (installationBytes.size != 16) throw NativeKeyException.materialLost()
        Base64.getUrlEncoder().withoutPadding().encodeToString(installationBytes).also {
          if (!validInstallationId(it)) throw NativeKeyException.materialLost()
        }
      } finally { crypto.zeroize(installationBytes) }
    }
    val authenticationPublicKey = p256.loadPublicKey(scope) ?: p256.createPublicKey(scope)
    val pair = crypto.makeX25519KeyPair()
    try {
      if (authenticationPublicKey.size != 65 || authenticationPublicKey.firstOrNull() != 4.toByte() ||
        pair.publicKey.size != 32 || pair.privateKey.size != 32 ||
        !validX25519Pair(pair.publicKey, pair.privateKey)
      ) throw NativeKeyException.materialLost()
      store.finalizeIdentity(
        scope,
        DeviceIdentityMaterial(
          scope.installationId,
          authenticationPublicKey,
          pair.publicKey,
          pair.privateKey,
        ),
      )
    } finally { crypto.zeroize(pair.privateKey) }
    val persisted = store.loadIdentity(accountHash) ?: throw NativeKeyException.materialLost()
    return try {
      if (persisted.installationId != scope.installationId) throw NativeKeyException.materialLost()
      publicIdentity(persisted, scope)
    } finally { crypto.zeroize(persisted.e2eePrivateKey) }
  }

  fun installDeviceSession(
    accountId: String,
    installationId: String,
    deviceId: String,
    backgroundBearer: String,
    expiresAt: Instant,
    apiBaseUrl: String,
  ) {
    prepare()
    val accountHash = hashAccountId(accountId)
    if (!validInstallationId(installationId)) throw NativeKeyException.materialLost()
    val identity = store.loadIdentity(accountHash) ?: throw NativeKeyException.materialLost()
    try {
      if (identity.installationId != installationId) throw NativeKeyException.materialLost()
      val scope = NativeKeyScope(accountHash, installationId)
      publicIdentity(identity, scope)
      TripKeyEnvelopeV1.uuidBytes(deviceId)
      if (!backgroundBearer.matches(Regex("^crb_[A-Za-z0-9_-]{12,512}$")) ||
        !apiBaseUrl.startsWith("https://")
      ) throw NativeKeyException.invalidCommand()
      val bearer = backgroundBearer.toByteArray()
      try {
        store.installSession(scope, DeviceSessionRecord(deviceId, bearer, expiresAt, apiBaseUrl))
      } finally { crypto.zeroize(bearer) }
    } finally { crypto.zeroize(identity.e2eePrivateKey) }
  }

  fun createTripKey(tripId: String, keyEpoch: Int): CreateTripKeyResult {
    val session = currentSession()
    requireV1(tripId, keyEpoch)
    var createdExpiry: Instant? = null
    val result = store.createTrip(session.scope, tripId) {
      val key = crypto.randomBytes(32)
      try {
        if (key.size != 32) throw NativeKeyException.materialLost()
        val now = clock.now()
        val expiresAt = now.plusSeconds(86_400)
        createdExpiry = expiresAt
        TripKeyRecord(key.copyOf(), KeyState.PROVISIONAL, now, expiresAt)
      } finally { crypto.zeroize(key) }
    }
    if (result == TripCreateOutcome.TOMBSTONED) throw NativeKeyException.materialLost()
    if (result == TripCreateOutcome.CREATED) {
      createdExpiry?.let { cleanupCoordinator?.schedule(it) }
    }
    return CreateTripKeyResult(tripId = tripId)
  }

  fun discardProvisionalTripKey(tripId: String, keyEpoch: Int) {
    val session = currentSession()
    requireV1(tripId, keyEpoch)
    if (store.discardProvisional(session.scope, tripId) == ProvisionalDiscardOutcome.PROTECTED) {
      throw NativeKeyException.invalidState()
    }
  }

  fun collectExpiredProvisionalKeys() = reconcileCleanup()

  fun runScheduledCleanup() = reconcileCleanup()

  fun cancelScheduledCleanup() = cleanupCoordinator?.cancel()

  fun wrapTripKey(
    tripId: String,
    keyEpoch: Int,
    recipientDeviceId: String,
    recipientE2eePublicKey: String,
    recipientE2eeKeyVersion: Int,
  ): WrapTripKeyResult {
    val session = currentSession()
    requireV1(tripId, keyEpoch)
    val record = store.loadTrip(session.scope, tripId) ?: throw NativeKeyException.materialLost()
    val tripKey = record.key
    var plaintext = ByteArray(0)
    var envelope = ByteArray(0)
    try {
      if (recipientE2eeKeyVersion != 1 || tripKey.size != 32 || record.state == KeyState.RETAINED) {
        throw NativeKeyException.materialLost()
      }
      val publicKey = CanonicalBase64.decode(recipientE2eePublicKey, 32)
      plaintext = TripKeyEnvelopeV1.encode(tripId, session.deviceId, recipientDeviceId, 1, tripKey)
      envelope = crypto.seal(plaintext, publicKey)
      if (envelope.size != 148) throw NativeKeyException.invalidEnvelope()
      return WrapTripKeyResult(
        tripId = tripId,
        senderDeviceId = session.deviceId,
        recipientDeviceId = recipientDeviceId,
        wrappedKey = CanonicalBase64.encode(envelope),
      )
    } finally {
      crypto.zeroize(tripKey); crypto.zeroize(plaintext); crypto.zeroize(envelope)
    }
  }

  fun importTripKey(
    tripId: String,
    keyEpoch: Int,
    algorithmVersion: Int,
    expectedSenderDeviceId: String,
    recipientDeviceId: String,
    recipientE2eeKeyVersion: Int,
    wrappedKey: String,
  ) {
    var envelope = ByteArray(0)
    var plaintext = ByteArray(0)
    var key = ByteArray(0)
    try {
      val session = currentSession()
      requireV1(tripId, keyEpoch)
      if (algorithmVersion != 1 || recipientE2eeKeyVersion != 1 || session.deviceId != recipientDeviceId) {
        throw NativeKeyException.invalidEnvelope()
      }
      envelope = CanonicalBase64.decode(wrappedKey, 148)
      plaintext = withValidatedIdentity(session.scope) { identity ->
        crypto.open(envelope, identity.e2eePublicKey, identity.e2eePrivateKey)
      }
      key = TripKeyEnvelopeV1.decode(plaintext, tripId, expectedSenderDeviceId, recipientDeviceId, 1)
      if (store.importTrip(session.scope, tripId, key) == TripImportOutcome.CONFLICT) {
        throw NativeKeyException.invalidEnvelope()
      }
    } catch (error: NativeKeyException) {
      if (error.code == "KEY_ACCESS_LOCKED" || error.code == "KEY_MATERIAL_LOST") throw error
      throw NativeKeyException.invalidEnvelope()
    } catch (_: Throwable) { throw NativeKeyException.invalidEnvelope() }
    finally {
      crypto.zeroize(envelope); crypto.zeroize(plaintext); crypto.zeroize(key)
    }
  }

  fun activateTrip(metadata: ActiveTripMetadata) {
    NativeCommandDecoder.validate(metadata)
    val session = currentSession()
    store.activate(session.scope, metadata)
  }

  fun deactivateTrip(tripId: String) {
    val session = currentSession()
    NativeCommandDecoder.requireTripId(tripId)
    store.deactivate(session.scope, tripId)
  }

  private fun prepare() = reconcileCleanup()
  private fun reconcileCleanup() {
    cleanupCoordinator?.reconcile() ?: run { cleanupRunner.run() }
  }
  private data class SessionContext(val scope: NativeKeyScope, val deviceId: String)
  private fun currentSession(): SessionContext {
    prepare()
    val session = store.activeSession() ?: throw NativeKeyException.materialLost()
    return try {
      withValidatedIdentity(session.scope) { }
      SessionContext(session.scope, session.session.deviceId)
    } finally { crypto.zeroize(session.session.backgroundBearer) }
  }
  private fun <T> withValidatedIdentity(scope: NativeKeyScope, body: (DeviceIdentityMaterial) -> T): T {
    val material = store.loadIdentity(scope.accountHash) ?: throw NativeKeyException.materialLost()
    return try {
      if (material.installationId != scope.installationId) throw NativeKeyException.materialLost()
      publicIdentity(material, scope)
      body(material)
    } finally { crypto.zeroize(material.e2eePrivateKey) }
  }
  private fun publicIdentity(material: DeviceIdentityMaterial, scope: NativeKeyScope): NativeDeviceIdentity {
    val authenticationPublicKey = p256.loadPublicKey(scope) ?: throw NativeKeyException.materialLost()
    if (material.authenticationPublicKey.size != 65 || material.authenticationPublicKey.firstOrNull() != 4.toByte() ||
      !crypto.constantTimeEquals(material.authenticationPublicKey, authenticationPublicKey) ||
      material.e2eePublicKey.size != 32 || material.e2eePrivateKey.size != 32 ||
      !validX25519Pair(material.e2eePublicKey, material.e2eePrivateKey)
    ) throw NativeKeyException.materialLost()
    return NativeDeviceIdentity(
      installationId = material.installationId,
      authenticationPublicKey = CanonicalBase64.encode(material.authenticationPublicKey),
      e2eePublicKey = CanonicalBase64.encode(material.e2eePublicKey),
    )
  }
  private fun validX25519Pair(publicKey: ByteArray, privateKey: ByteArray): Boolean {
    val privateCopy = privateKey.copyOf()
    var derived = ByteArray(0)
    return try {
      derived = crypto.deriveX25519PublicKey(privateCopy)
      derived.size == 32 && crypto.constantTimeEquals(derived, publicKey)
    } finally { crypto.zeroize(privateCopy); crypto.zeroize(derived) }
  }
  private fun hashAccountId(accountId: String): String {
    if (accountId.toByteArray(Charsets.US_ASCII).toString(Charsets.US_ASCII) != accountId ||
      accountId.length !in 1..255 || !accountId.matches(Regex("^[A-Za-z0-9_-]+$"))
    ) throw NativeKeyException.invalidCommand()
    val value = accountHasher.hash(accountId)
    if (!value.matches(Regex("^[a-f0-9]{64}$"))) throw NativeKeyException.materialLost()
    return value
  }
  private fun validInstallationId(value: String) = value.length in 8..128 && value.matches(Regex("^[A-Za-z0-9_-]+$"))
  private fun requireV1(tripId: String, keyEpoch: Int) {
    if (keyEpoch != 1) throw NativeKeyException.invalidCommand()
    NativeCommandDecoder.requireTripId(tripId)
  }
}
