package com.uankit53.crewroll.transfer.identitykeys

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.SecureRandom
import java.security.MessageDigest
import java.time.Instant
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** A secret is opened only when a domain operation requests it. The ciphertext
 * remains bound to its original canonical record AAD and can be copied through
 * metadata-only commits without another hardware operation. This object belongs
 * to one synchronous database snapshot; it never escapes that snapshot. */
internal class AndroidStoredSecret private constructor(
  private var plaintext: ByteArray?,
  private var sealed: ByteArray?,
  private var boundAad: ByteArray?,
  private var cipher: AndroidScopedSecretCipher?,
  private val sizeRange: IntRange,
) {
  var isErased = false
    private set
  val isMaterialized get() = plaintext != null

  fun copyPlaintext(): ByteArray {
    if (isErased) throw NativeKeyException.invalidState()
    val value = plaintext ?: run {
      val source = sealed ?: throw NativeKeyException.materialLost()
      val aad = boundAad ?: throw NativeKeyException.materialLost()
      val opened = (cipher ?: throw NativeKeyException.materialLost()).open(source, aad)
      if (opened.size !in sizeRange) { opened.fill(0); throw NativeKeyException.materialLost() }
      plaintext = opened
      opened
    }
    return value.copyOf()
  }

  fun sealedCopy(aad: ByteArray, sealer: AndroidScopedSecretCipher): ByteArray {
    if (isErased) throw NativeKeyException.invalidState()
    boundAad?.let { if (!MessageDigest.isEqual(it, aad)) throw NativeKeyException.materialLost() }
    val current = sealed
    if (current != null) return current.copyOf()
    val value = plaintext ?: throw NativeKeyException.materialLost()
    if (value.size !in sizeRange) throw NativeKeyException.materialLost()
    val record = sealer.seal(value, aad)
    if (record.size != value.size + 28) { record.fill(0); throw NativeKeyException.materialLost() }
    sealed = record
    boundAad = aad.copyOf()
    cipher = sealer
    return record.copyOf()
  }

  fun erase() {
    plaintext?.fill(0); sealed?.fill(0); boundAad?.fill(0)
    plaintext = null; sealed = null; boundAad = null; cipher = null
    isErased = true
  }

  companion object {
    fun plaintext(value: ByteArray, range: IntRange): AndroidStoredSecret {
      if (value.size !in range) throw NativeKeyException.materialLost()
      return AndroidStoredSecret(value.copyOf(), null, null, null, range)
    }
    fun sealed(record: ByteArray, aad: ByteArray, cipher: AndroidScopedSecretCipher, range: IntRange): AndroidStoredSecret {
      if (record.size !in (range.first + 28)..(range.last + 28)) throw NativeKeyException.materialLost()
      return AndroidStoredSecret(null, record.copyOf(), aad.copyOf(), cipher, range)
    }
  }
}

internal data class AndroidStoredIdentity(
  val installationId: String,
  val authenticationPublicKey: ByteArray,
  val e2eePublicKey: ByteArray,
  val privateKey: AndroidStoredSecret,
) {
  fun materialize() = DeviceIdentityMaterial(installationId, authenticationPublicKey.copyOf(), e2eePublicKey.copyOf(), privateKey.copyPlaintext())
  companion object {
    fun from(value: DeviceIdentityMaterial) = AndroidStoredIdentity(value.installationId,
      value.authenticationPublicKey.copyOf(), value.e2eePublicKey.copyOf(), AndroidStoredSecret.plaintext(value.e2eePrivateKey, 32..32))
  }
}

internal data class AndroidStoredSession(
  val deviceId: String,
  val bearer: AndroidStoredSecret,
  val expiresAt: Instant,
  val apiBaseUrl: String,
) {
  fun materialize() = DeviceSessionRecord(deviceId, bearer.copyPlaintext(), expiresAt, apiBaseUrl)
  companion object {
    fun from(value: DeviceSessionRecord) = AndroidStoredSession(value.deviceId,
      AndroidStoredSecret.plaintext(value.backgroundBearer, 16..516), value.expiresAt, value.apiBaseUrl)
  }
}

internal data class AndroidStoredTrip(
  val secret: AndroidStoredSecret,
  val state: KeyState,
  val createdAt: Instant? = null,
  val provisionalExpiresAt: Instant? = null,
) {
  fun materialize() = TripKeyRecord(secret.copyPlaintext(), state, createdAt, provisionalExpiresAt)
  companion object {
    fun from(value: TripKeyRecord) = AndroidStoredTrip(AndroidStoredSecret.plaintext(value.key, 32..32),
      value.state, value.createdAt, value.provisionalExpiresAt)
  }
}

internal data class AndroidScopedState(
  val scope: NativeKeyScope,
  var session: AndroidStoredSession? = null,
  val trips: MutableMap<String, AndroidStoredTrip> = mutableMapOf(),
  val tombstones: MutableSet<String> = mutableSetOf(),
  var activeMetadata: ActiveTripMetadata? = null,
  val frozenMetadata: MutableMap<String, ActiveTripMetadata> = mutableMapOf(),
  val tripEndsAt: MutableMap<String, String> = mutableMapOf(),
  val legacyReconciliationDeadlines: MutableMap<String, Instant> = mutableMapOf(),
) {
  constructor(scope: NativeKeyScope, session: DeviceSessionRecord) : this(scope, AndroidStoredSession.from(session))
  fun authoritativeDeadline(tripId: String): Instant? = tripEndsAt[tripId]?.let(NativeTripRetention::deadline)
    ?: (frozenMetadata[tripId] ?: activeMetadata?.takeIf { it.tripId == tripId })?.let(NativeTripRetention::deadline)
  fun cleanupDeadline(tripId: String): Instant? = authoritativeDeadline(tripId) ?: legacyReconciliationDeadlines[tripId]
}

internal data class AndroidScopedDatabase(
  val identities: MutableMap<String, AndroidStoredIdentity> = mutableMapOf(),
  val pendingIdentities: MutableMap<String, String> = mutableMapOf(),
  val scopes: MutableMap<String, AndroidScopedState> = mutableMapOf(),
  var selectedScope: NativeKeyScope? = null,
)

internal fun androidScopeKey(scope: NativeKeyScope) = "${scope.accountHash}.${scope.installationId}"

internal enum class AndroidScopedSecretType(val wireName: String) {
  IDENTITY_PRIVATE("identity-x25519-private"),
  SESSION_BEARER("session-background-bearer"),
  TRIP_KEY("trip-key"),
}

internal interface AndroidScopedSecretCipher {
  fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray
  fun open(record: ByteArray, aad: ByteArray): ByteArray
}

internal class AesGcmScopedSecretCipher(
  private val key: SecretKey,
  private val random: SecureRandom = SecureRandom(),
) : AndroidScopedSecretCipher {
  override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray = try {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    // AndroidKeyStore requires provider-generated IVs when randomized encryption is enabled.
    cipher.init(Cipher.ENCRYPT_MODE, key, random)
    val nonce = cipher.iv
    if (nonce.size != 12) throw NativeKeyException.materialLost()
    cipher.updateAAD(aad)
    nonce + cipher.doFinal(plaintext)
  } catch (_: Throwable) {
    throw NativeKeyException.materialLost()
  }

  override fun open(record: ByteArray, aad: ByteArray): ByteArray {
    if (record.size < 28) throw NativeKeyException.materialLost()
    var plaintext = ByteArray(0)
    return try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record.copyOfRange(0, 12)))
      cipher.updateAAD(aad)
      cipher.doFinal(record.copyOfRange(12, record.size)).also { plaintext = it }
    } catch (_: Throwable) {
      plaintext.fill(0)
      throw NativeKeyException.materialLost()
    }
  }
}

internal fun androidScopedSecretAad(
  scope: NativeKeyScope,
  type: AndroidScopedSecretType,
  recordId: String,
  recordVersion: Int,
): ByteArray {
  if (!scope.accountHash.matches(Regex("^[a-f0-9]{64}$")) ||
    !scope.installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$")) ||
    recordId.toByteArray(Charsets.UTF_8).size !in 1..128 || recordVersion <= 0
  ) throw NativeKeyException.materialLost()
  return ByteArrayOutputStream().use { buffer ->
    DataOutputStream(buffer).use { output ->
      output.write("CRAAD2".toByteArray(Charsets.US_ASCII))
      output.writeInt(recordVersion)
      listOf(scope.accountHash, scope.installationId, type.wireName, recordId).forEach { value ->
        val bytes = value.toByteArray(Charsets.UTF_8)
        output.writeInt(bytes.size)
        output.write(bytes)
      }
    }
    buffer.toByteArray()
  }
}

internal object AndroidScopedDatabaseCodec {
  private const val MAGIC = 0x43524b32
  private const val VERSION = 1
  private const val V2_VERSION = 2
  private const val V3_VERSION = 3
  private const val SECRET_VERSION = 1

  private fun decodeLegacy(bytes: ByteArray): AndroidScopedDatabase {
    val database = AndroidScopedDatabase()
    return try {
      ScopedRecordInput(ByteArrayInputStream(bytes)).use { input ->
        if (input.readInt() != MAGIC || input.readInt() != VERSION) throw NativeKeyException.materialLost()
        repeat(input.count(64)) {
          val accountHash = input.text(64)
          if (!accountHash.matches(Regex("^[a-f0-9]{64}$")) ||
            database.identities.containsKey(accountHash)
          ) throw NativeKeyException.materialLost()
          database.identities[accountHash] = input.identity()
        }
        repeat(input.count(128)) {
          val scope = input.scope()
          if (database.scopes.containsKey(androidScopeKey(scope))) {
            throw NativeKeyException.materialLost()
          }
          val state = AndroidScopedState(scope)
          database.scopes[androidScopeKey(scope)] = state
          state.session = input.optional { input.session() }
          repeat(input.count(512)) {
            val tripId = input.text(64)
            if (state.trips.containsKey(tripId)) throw NativeKeyException.materialLost()
            state.trips[tripId] = input.trip()
          }
          repeat(input.count(512)) {
            if (!state.tombstones.add(input.text(64))) throw NativeKeyException.materialLost()
          }
          state.activeMetadata = input.optional { input.metadata() }
          repeat(input.count(512)) {
            val tripId = input.text(64)
            if (state.frozenMetadata.put(tripId, input.metadata()) != null) {
              throw NativeKeyException.materialLost()
            }
          }
        }
        database.selectedScope = input.optional { input.scope() }
        if (input.available() != 0) throw NativeKeyException.materialLost()
      }
      database
    } catch (_: Throwable) {
      database.zeroize()
      throw NativeKeyException.materialLost()
    }
  }

  fun encode(database: AndroidScopedDatabase, cipher: AndroidScopedSecretCipher): ByteArray =
    ByteArrayOutputStream().use { buffer ->
      ScopedRecordOutputV2(buffer, cipher).use { output ->
        output.writeInt(MAGIC)
        output.writeInt(V3_VERSION)
        output.writeCount(database.identities.size, 64)
        database.identities.toSortedMap().forEach { (accountHash, identity) ->
          output.text(accountHash, 64)
          output.identity(accountHash, identity)
        }
        output.writeCount(database.pendingIdentities.size, 64)
        database.pendingIdentities.toSortedMap().forEach { (accountHash, installationId) ->
          output.text(accountHash, 64)
          output.text(installationId, 128)
        }
        output.writeCount(database.scopes.size, 128)
        database.scopes.toSortedMap().forEach { (alias, state) ->
          if (alias != androidScopeKey(state.scope)) throw NativeKeyException.materialLost()
          output.scope(state.scope)
          output.optional(state.session) { session(state.scope, it) }
          output.writeCount(state.trips.size, 512)
          state.trips.toSortedMap().forEach { (tripId, record) ->
            output.text(tripId, 64)
            output.trip(state.scope, tripId, record)
          }
          output.writeCount(state.tombstones.size, 512)
          state.tombstones.sorted().forEach { output.text(it, 64) }
          output.optional(state.activeMetadata) { metadata(it) }
          output.writeCount(state.frozenMetadata.size, 512)
          state.frozenMetadata.toSortedMap().forEach { (tripId, metadata) ->
            output.text(tripId, 64)
            output.metadata(metadata)
          }
          output.writeCount(state.tripEndsAt.size, 512)
          state.tripEndsAt.toSortedMap().forEach { (tripId, endsAt) ->
            output.text(tripId, 64)
            output.text(endsAt, 64)
          }
          output.writeCount(state.legacyReconciliationDeadlines.size, 512)
          state.legacyReconciliationDeadlines.toSortedMap().forEach { (tripId, deadline) ->
            output.text(tripId, 64)
            output.text(deadline.toString(), 64)
          }
        }
        output.optional(database.selectedScope) { scope(it) }
      }
      buffer.toByteArray()
    }

  fun decode(bytes: ByteArray, cipher: AndroidScopedSecretCipher): AndroidScopedDatabase {
    val version = try {
      DataInputStream(ByteArrayInputStream(bytes)).use { input ->
        if (input.readInt() != MAGIC) throw NativeKeyException.materialLost()
        input.readInt()
      }
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    }
    if (version == VERSION) return decodeLegacy(bytes)
    if (version != V2_VERSION && version != V3_VERSION) throw NativeKeyException.materialLost()
    val database = AndroidScopedDatabase()
    return try {
      ScopedRecordInputV2(ByteArrayInputStream(bytes), cipher).use { input ->
        if (input.readInt() != MAGIC || input.readInt() != version) {
          throw NativeKeyException.materialLost()
        }
        repeat(input.count(64)) {
          val accountHash = input.accountHash()
          if (database.identities.containsKey(accountHash)) throw NativeKeyException.materialLost()
          database.identities[accountHash] = input.identity(accountHash)
        }
        repeat(input.count(64)) {
          val accountHash = input.accountHash()
          val installationId = input.installationId()
          if (database.identities.containsKey(accountHash) ||
            database.pendingIdentities.put(accountHash, installationId) != null
          ) throw NativeKeyException.materialLost()
        }
        repeat(input.count(128)) {
          val scope = input.scope()
          if (database.scopes.containsKey(androidScopeKey(scope))) {
            throw NativeKeyException.materialLost()
          }
          val state = AndroidScopedState(scope)
          database.scopes[androidScopeKey(scope)] = state
          state.session = input.optional { input.session(scope) }
          repeat(input.count(512)) {
            val tripId = input.canonicalUuid()
            if (state.trips.containsKey(tripId)) throw NativeKeyException.materialLost()
            state.trips[tripId] = input.trip(scope, tripId)
          }
          repeat(input.count(512)) {
            if (!state.tombstones.add(input.canonicalUuid())) throw NativeKeyException.materialLost()
          }
          state.activeMetadata = input.optional { input.metadata() }
          repeat(input.count(512)) {
            val tripId = input.canonicalUuid()
            val metadata = input.metadata()
            if (metadata.tripId != tripId || state.frozenMetadata.put(tripId, metadata) != null) {
              throw NativeKeyException.materialLost()
            }
          }
          if (version >= V3_VERSION) {
            repeat(input.count(512)) {
              val tripId = input.canonicalUuid()
              val endsAt = input.text(64)
              NativeTripRetention.deadline(endsAt)
              if (state.tripEndsAt.put(tripId, endsAt) != null) throw NativeKeyException.materialLost()
            }
            repeat(input.count(512)) {
              val tripId = input.canonicalUuid()
              val deadline = Instant.parse(input.text(64))
              if (state.legacyReconciliationDeadlines.put(tripId, deadline) != null) throw NativeKeyException.materialLost()
            }
          }
        }
        database.selectedScope = input.optional { input.scope() }
        if (input.available() != 0 || database.pendingIdentities.keys.any { pendingHash ->
            database.scopes.values.any { it.scope.accountHash == pendingHash }
          } || database.selectedScope?.let {
            database.scopes[androidScopeKey(it)] == null
          } == true
        ) throw NativeKeyException.materialLost()
      }
      database
    } catch (_: Throwable) {
      database.zeroize()
      throw NativeKeyException.materialLost()
    }
  }

  internal fun identityAad(scope: NativeKeyScope) = androidScopedSecretAad(
    scope, AndroidScopedSecretType.IDENTITY_PRIVATE, "e2ee-v1", SECRET_VERSION,
  )
  internal fun sessionAad(scope: NativeKeyScope, deviceId: String) = androidScopedSecretAad(
    scope, AndroidScopedSecretType.SESSION_BEARER, deviceId, SECRET_VERSION,
  )
  internal fun tripAad(scope: NativeKeyScope, tripId: String) = androidScopedSecretAad(
    scope, AndroidScopedSecretType.TRIP_KEY, tripId, SECRET_VERSION,
  )
}

private class ScopedRecordInput(buffer: ByteArrayInputStream) : DataInputStream(buffer) {
  fun count(maximum: Int): Int = readInt().also {
    if (it !in 0..maximum) throw NativeKeyException.materialLost()
  }
  fun text(maximum: Int): String {
    val size = count(maximum)
    return String(ByteArray(size).also(::readFully), Charsets.UTF_8)
  }
  fun bytes(exact: Int) = ByteArray(exact).also(::readFully)
  fun instant(): Instant? = optional { Instant.ofEpochMilli(readLong()) }
  fun <T> optional(body: () -> T): T? = if (readBoolean()) body() else null
  fun scope(): NativeKeyScope {
    val value = NativeKeyScope(text(64), text(128))
    if (!value.accountHash.matches(Regex("^[a-f0-9]{64}$")) ||
      !value.installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
      throw NativeKeyException.materialLost()
    }
    return value
  }
  fun identity(): AndroidStoredIdentity {
    val material = DeviceIdentityMaterial(text(128), bytes(65), bytes(32), bytes(32))
    return try { AndroidStoredIdentity.from(material) } finally { material.e2eePrivateKey.fill(0) }
  }
  fun session(): AndroidStoredSession {
    val deviceId = text(64)
    val bearerSize = count(516)
    if (bearerSize < 16) throw NativeKeyException.materialLost()
    val bearer = ByteArray(bearerSize).also(::readFully)
    return try {
      val expiresAt = Instant.ofEpochMilli(readLong())
      val apiBaseUrl = text(2048)
      AndroidStoredSession(deviceId, AndroidStoredSecret.plaintext(bearer, 16..516), expiresAt, apiBaseUrl)
    } finally { bearer.fill(0) }
  }
  fun trip(): AndroidStoredTrip {
    val key = bytes(32)
    return try {
      val state = KeyState.entries.getOrNull(readInt()) ?: throw NativeKeyException.materialLost()
      val createdAt = instant()
      val expiresAt = instant()
      AndroidStoredTrip(AndroidStoredSecret.plaintext(key, 32..32), state, createdAt, expiresAt)
    } finally { key.fill(0) }
  }
  fun metadata() = ActiveTripMetadata(
    text(64),
    text(64),
    text(64),
    text(64),
    optional { text(64) },
    readInt(),
  )
}

private class ScopedRecordOutputV2(
  buffer: ByteArrayOutputStream,
  private val cipher: AndroidScopedSecretCipher,
) : DataOutputStream(buffer) {
  fun writeCount(value: Int, maximum: Int) {
    if (value !in 0..maximum) throw NativeKeyException.materialLost()
    writeInt(value)
  }
  fun text(value: String, maximum: Int) {
    val bytes = value.toByteArray(Charsets.UTF_8)
    if (bytes.size !in 0..maximum) throw NativeKeyException.materialLost()
    writeInt(bytes.size)
    write(bytes)
  }
  fun bytes(value: ByteArray, exact: Int) {
    if (value.size != exact) throw NativeKeyException.materialLost()
    write(value)
  }
  fun wrapped(value: AndroidStoredSecret, aad: ByteArray, maximum: Int) {
    val record = value.sealedCopy(aad, cipher)
    try {
      if (record.size !in 29..maximum) throw NativeKeyException.materialLost()
      writeInt(record.size); write(record)
    } finally { record.fill(0); aad.fill(0) }
  }
  fun instant(value: Instant?) = optional(value) { writeLong(it.toEpochMilli()) }
  fun <T> optional(value: T?, body: ScopedRecordOutputV2.(T) -> Unit) {
    writeBoolean(value != null)
    if (value != null) body(value)
  }
  fun scope(value: NativeKeyScope) {
    text(value.accountHash, 64)
    text(value.installationId, 128)
  }
  fun identity(accountHash: String, value: AndroidStoredIdentity) {
    val scope = NativeKeyScope(accountHash, value.installationId)
    text(value.installationId, 128)
    bytes(value.authenticationPublicKey, 65)
    bytes(value.e2eePublicKey, 32)
    wrapped(value.privateKey, AndroidScopedDatabaseCodec.identityAad(scope), 128)
  }
  fun session(scope: NativeKeyScope, value: AndroidStoredSession) {
    text(value.deviceId, 64)
    writeLong(value.expiresAt.toEpochMilli())
    text(value.apiBaseUrl, 2048)
    wrapped(value.bearer, AndroidScopedDatabaseCodec.sessionAad(scope, value.deviceId), 600)
  }
  fun trip(scope: NativeKeyScope, tripId: String, value: AndroidStoredTrip) {
    writeInt(value.state.ordinal)
    instant(value.createdAt)
    instant(value.provisionalExpiresAt)
    wrapped(value.secret, AndroidScopedDatabaseCodec.tripAad(scope, tripId), 128)
  }
  fun metadata(value: ActiveTripMetadata) {
    text(value.tripId, 64)
    text(value.membershipId, 64)
    text(value.startsAt, 64)
    text(value.endsAt, 64)
    optional(value.releaseAt) { text(it, 64) }
    writeInt(value.keyEpoch)
  }
}

private class ScopedRecordInputV2(
  buffer: ByteArrayInputStream,
  private val cipher: AndroidScopedSecretCipher,
) : DataInputStream(buffer) {
  fun count(maximum: Int): Int = readInt().also {
    if (it !in 0..maximum) throw NativeKeyException.materialLost()
  }
  fun text(maximum: Int): String {
    val size = count(maximum)
    return String(ByteArray(size).also(::readFully), Charsets.UTF_8)
  }
  fun bytes(exact: Int) = ByteArray(exact).also(::readFully)
  fun wrapped(aad: ByteArray, range: IntRange, maximum: Int): AndroidStoredSecret {
    val record = ByteArray(count(maximum)).also(::readFully)
    return try { AndroidStoredSecret.sealed(record, aad, cipher, range) }
    finally { record.fill(0); aad.fill(0) }
  }
  fun instant(): Instant? = optional { Instant.ofEpochMilli(readLong()) }
  fun <T> optional(body: () -> T): T? = if (readBoolean()) body() else null
  fun accountHash() = text(64).also {
    if (!it.matches(Regex("^[a-f0-9]{64}$"))) throw NativeKeyException.materialLost()
  }
  fun installationId() = text(128).also {
    if (!it.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) throw NativeKeyException.materialLost()
  }
  fun scope() = NativeKeyScope(accountHash(), installationId())
  fun canonicalUuid() = text(64).also { value ->
    val parsed = try { java.util.UUID.fromString(value) } catch (_: IllegalArgumentException) {
      throw NativeKeyException.materialLost()
    }
    if (parsed.toString() != value.lowercase()) throw NativeKeyException.materialLost()
  }
  fun identity(accountHash: String): AndroidStoredIdentity {
    val installationId = installationId()
    val scope = NativeKeyScope(accountHash, installationId)
    return AndroidStoredIdentity(
      installationId,
      bytes(65),
      bytes(32),
      wrapped(AndroidScopedDatabaseCodec.identityAad(scope), 32..32, 128),
    )
  }
  fun session(scope: NativeKeyScope): AndroidStoredSession {
    val deviceId = canonicalUuid()
    val expiresAt = Instant.ofEpochMilli(readLong())
    val apiBaseUrl = text(2048)
    return AndroidStoredSession(
      deviceId,
      wrapped(AndroidScopedDatabaseCodec.sessionAad(scope, deviceId), 16..516, 600),
      expiresAt,
      apiBaseUrl,
    )
  }
  fun trip(scope: NativeKeyScope, tripId: String): AndroidStoredTrip {
    val state = KeyState.entries.getOrNull(readInt()) ?: throw NativeKeyException.materialLost()
    val createdAt = instant()
    val expiresAt = instant()
    return AndroidStoredTrip(
      wrapped(AndroidScopedDatabaseCodec.tripAad(scope, tripId), 32..32, 128),
      state,
      createdAt,
      expiresAt,
    )
  }
  fun metadata() = ActiveTripMetadata(
    canonicalUuid(),
    canonicalUuid(),
    text(64),
    text(64),
    optional { text(64) },
    readInt(),
  ).also(NativeCommandDecoder::validate)
}

internal fun AndroidScopedDatabase.zeroize() {
  identities.values.forEach { it.privateKey.erase() }
  scopes.values.forEach { state ->
    state.session?.bearer?.erase()
    state.trips.values.forEach { it.secret.erase() }
  }
}

internal fun AndroidScopedState.secureReplaceSession(value: DeviceSessionRecord) {
  session?.bearer?.erase()
  session = AndroidStoredSession.from(value)
}
