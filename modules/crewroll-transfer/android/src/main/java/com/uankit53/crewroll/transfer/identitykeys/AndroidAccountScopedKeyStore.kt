package com.uankit53.crewroll.transfer.identitykeys

import android.content.Context
import android.os.Build
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.concurrent.withLock

class AndroidAccountNamespaceHasher : AccountNamespaceHasher {
  override fun hash(accountId: String): String {
    val input = accountId.toByteArray(Charsets.US_ASCII)
    return try {
      MessageDigest.getInstance("SHA-256").digest(input).joinToString("") { "%02x".format(it) }
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      input.fill(0)
    }
  }
}

class AndroidAccountScopedKeyStore(context: Context) : NativeKeyStore {
  private val appContext = context.applicationContext
  private val userManager = appContext.getSystemService(UserManager::class.java)
  private val directory = File(appContext.noBackupFilesDir, "crewroll-native-keys-v2")
  private val databaseFile = File(directory, "scoped-database.v2")
  private val temporaryFile = File(directory, "scoped-database.v2.tmp")
  private val random = SecureRandom()
  private val keyAlias = "crewroll.native-record-kek.v2"
  private val lock = ReentrantLock()
  private val legacyOuterMagic = "CRK2".toByteArray(Charsets.US_ASCII)
  private val outerMagic = "CRK3".toByteArray(Charsets.US_ASCII)
  private val legacyOuterAad = "CRKEYDB2|account-hash|installation|1".toByteArray(Charsets.US_ASCII)
  private val outerAad = "CRKEYDB3|atomic-container|2".toByteArray(Charsets.US_ASCII)

  override fun loadIdentity(accountHash: String): DeviceIdentityMaterial? = read { database ->
    database.identities[accountHash]?.deepCopy()
  }

  override fun reservePendingIdentity(
    accountHash: String,
    makeInstallationId: () -> String,
  ): NativeKeyScope = transaction { database ->
    if (!accountHash.matches(Regex("^[a-f0-9]{64}$"))) throw NativeKeyException.materialLost()
    database.pendingIdentities[accountHash]?.let { installationId ->
      if (!installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$")) ||
        database.identities.containsKey(accountHash) || database.scopes.values.any {
          it.scope.accountHash == accountHash
        }
      ) {
        throw NativeKeyException.materialLost()
      }
      return@transaction NativeKeyScope(accountHash, installationId)
    }
    if (database.identities.containsKey(accountHash) || database.scopes.values.any {
        it.scope.accountHash == accountHash
      }
    ) throw NativeKeyException.materialLost()
    val installationId = makeInstallationId()
    if (!installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$"))) {
      throw NativeKeyException.materialLost()
    }
    database.pendingIdentities[accountHash] = installationId
    NativeKeyScope(accountHash, installationId)
  }

  override fun finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial) = transaction { database ->
    if (database.pendingIdentities[scope.accountHash] != scope.installationId ||
      value.installationId != scope.installationId || database.identities.containsKey(scope.accountHash)
    ) throw NativeKeyException.materialLost()
    database.identities[scope.accountHash] = value.deepCopy()
    database.scopes.putIfAbsent(androidScopeKey(scope), AndroidScopedState(scope))
    database.pendingIdentities.remove(scope.accountHash)
  }

  override fun hasScopedMaterial(accountHash: String): Boolean = read { database ->
    database.scopes.values.any { state ->
      state.scope.accountHash == accountHash &&
        (state.session != null || state.trips.isNotEmpty() || state.tombstones.isNotEmpty() || state.activeMetadata != null)
    }
  }

  override fun activeSession(): ScopedDeviceSession? = read { database ->
    val scope = database.selectedScope ?: return@read null
    val session = database.scopes[androidScopeKey(scope)]?.session ?: return@read null
    ScopedDeviceSession(scope, session.deepCopy())
  }

  override fun installSession(scope: NativeKeyScope, value: DeviceSessionRecord) = transaction { database ->
    database.selectedScope?.takeIf { it != scope }?.let { prior ->
      database.scopes[androidScopeKey(prior)]?.let { priorState ->
        priorState.activeMetadata?.tripId?.let { activeId ->
          priorState.trips[activeId]?.let { active ->
            priorState.trips[activeId] = active.copy(state = KeyState.INSTALLED)
          }
        }
        priorState.session?.backgroundBearer?.fill(0)
        priorState.session = null
        priorState.activeMetadata = null
      }
    }
    database.scopes.getOrPut(androidScopeKey(scope)) {
      AndroidScopedState(scope)
    }.secureReplaceSession(value)
    database.selectedScope = scope
  }

  override fun createTrip(
    scope: NativeKeyScope,
    tripId: String,
    makeValue: () -> TripKeyRecord,
  ): TripCreateOutcome = transaction { database ->
    val state = database.scopes.getOrPut(androidScopeKey(scope)) { AndroidScopedState(scope) }
    if (state.tombstones.contains(tripId)) return@transaction TripCreateOutcome.TOMBSTONED
    if (state.trips.containsKey(tripId)) return@transaction TripCreateOutcome.EXISTING
    val value = makeValue()
    try { state.trips[tripId] = value.deepCopy() }
    finally { value.key.fill(0) }
    TripCreateOutcome.CREATED
  }

  override fun loadTrip(scope: NativeKeyScope, tripId: String): TripKeyRecord? = read { database ->
    database.scopes[androidScopeKey(scope)]?.trips?.get(tripId)?.deepCopy()
  }

  override fun discardProvisional(
    scope: NativeKeyScope,
    tripId: String,
  ): ProvisionalDiscardOutcome = transaction { database ->
    val state = database.scopes[androidScopeKey(scope)] ?: return@transaction ProvisionalDiscardOutcome.ABSENT
    val record = state.trips[tripId] ?: return@transaction ProvisionalDiscardOutcome.ABSENT
    if (record.state != KeyState.PROVISIONAL) return@transaction ProvisionalDiscardOutcome.PROTECTED
    state.trips.remove(tripId)?.key?.fill(0)
    state.tombstones.add(tripId)
    ProvisionalDiscardOutcome.DISCARDED
  }

  override fun collectExpiredProvisional(now: Instant) = transaction { database ->
    database.scopes.values.forEach { state ->
      state.trips.toMap().forEach { (tripId, snapshot) ->
        if (snapshot.state != KeyState.PROVISIONAL) return@forEach
        val expiresAt = snapshot.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
        val current = state.trips[tripId]
        if (!expiresAt.isAfter(now) && current?.state == KeyState.PROVISIONAL) {
          state.trips.remove(tripId)?.key?.fill(0)
          state.tombstones.add(tripId)
        }
      }
    }
    database.scopes.values.asSequence()
      .flatMap { it.trips.values.asSequence() }
      .filter { it.state == KeyState.PROVISIONAL }
      .map {
        it.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
      }
      .minOrNull()
  }

  override fun importTrip(
    scope: NativeKeyScope,
    tripId: String,
    key: ByteArray,
  ): TripImportOutcome = transaction { database ->
    if (key.size != 32) throw NativeKeyException.invalidEnvelope()
    val state = database.scopes.getOrPut(androidScopeKey(scope)) { AndroidScopedState(scope) }
    val existing = state.trips[tripId]
    if (existing != null) {
      if (!MessageDigest.isEqual(existing.key, key)) return@transaction TripImportOutcome.CONFLICT
      if (existing.state == KeyState.PROVISIONAL) {
        state.trips[tripId] = existing.copy(state = KeyState.INSTALLED)
      }
      state.tombstones.remove(tripId)
      return@transaction TripImportOutcome.EXISTING
    }
    state.trips[tripId] = TripKeyRecord(key.copyOf(), KeyState.INSTALLED)
    state.tombstones.remove(tripId)
    TripImportOutcome.INSTALLED
  }

  override fun activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) = transaction { database ->
    val state = database.scopes[androidScopeKey(scope)] ?: throw NativeKeyException.materialLost()
    val target = state.trips[metadata.tripId] ?: throw NativeKeyException.materialLost()
    if (target.state != KeyState.INSTALLED && target.state != KeyState.ACTIVE) {
      throw NativeKeyException.materialLost()
    }
    state.frozenMetadata[metadata.tripId]?.takeIf { it != metadata }?.let {
      throw NativeKeyException.invalidState()
    }
    state.activeMetadata?.tripId?.takeIf { it != metadata.tripId }?.let { priorId ->
      state.trips[priorId]?.let { prior -> state.trips[priorId] = prior.copy(state = KeyState.INSTALLED) }
    }
    state.trips[metadata.tripId] = target.copy(state = KeyState.ACTIVE)
    state.frozenMetadata[metadata.tripId] = metadata
    state.activeMetadata = metadata
  }

  override fun deactivate(scope: NativeKeyScope, tripId: String) = transaction { database ->
    val state = database.scopes[androidScopeKey(scope)] ?: return@transaction
    if (state.activeMetadata?.tripId != tripId) return@transaction
    state.trips[tripId]?.let { state.trips[tripId] = it.copy(state = KeyState.INSTALLED) }
    state.activeMetadata = null
  }

  private fun <T> read(body: (AndroidScopedDatabase) -> T): T = lock.withLock {
    val database = loadDatabase()
    try { body(database) } finally { database.zeroize() }
  }

  private fun <T> transaction(body: (AndroidScopedDatabase) -> T): T = lock.withLock {
    val database = loadDatabase()
    try {
      val result = body(database)
      saveDatabase(database)
      result
    } finally { database.zeroize() }
  }

  private fun loadDatabase(): AndroidScopedDatabase {
    requireUnlocked()
    if (!databaseFile.exists()) {
      if (temporaryFile.exists()) throw NativeKeyException.materialLost()
      return AndroidScopedDatabase()
    }
    var record = ByteArray(0)
    var plaintext = ByteArray(0)
    return try {
      record = databaseFile.readBytes()
      if (record.size < 33) {
        throw NativeKeyException.materialLost()
      }
      val aad = when {
        record.copyOfRange(0, 4).contentEquals(legacyOuterMagic) -> legacyOuterAad
        record.copyOfRange(0, 4).contentEquals(outerMagic) -> outerAad
        else -> throw NativeKeyException.materialLost()
      }
      val key = existingKek()
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record.copyOfRange(4, 16)))
      cipher.updateAAD(aad)
      plaintext = cipher.doFinal(record.copyOfRange(16, record.size))
      AndroidScopedDatabaseCodec.decode(plaintext, AesGcmScopedSecretCipher(key, random))
    } catch (error: NativeKeyException) {
      throw error
    } catch (_: AEADBadTagException) {
      throw NativeKeyException.materialLost()
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      plaintext.fill(0)
      record.fill(0)
    }
  }

  private fun saveDatabase(database: AndroidScopedDatabase) {
    requireUnlocked()
    var plaintext = ByteArray(0)
    var ciphertext = ByteArray(0)
    var record = ByteArray(0)
    try {
      if (!directory.exists() && !directory.mkdirs()) throw NativeKeyException.materialLost()
      val key = kekForWrite()
      plaintext = AndroidScopedDatabaseCodec.encode(database, AesGcmScopedSecretCipher(key, random))
      val nonce = ByteArray(12).also(random::nextBytes)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
      cipher.updateAAD(outerAad)
      ciphertext = cipher.doFinal(plaintext)
      record = outerMagic + nonce + ciphertext
      FileOutputStream(temporaryFile).use { output ->
        output.write(record)
        output.fd.sync()
      }
      Files.move(temporaryFile.toPath(), databaseFile.toPath(), REPLACE_EXISTING, ATOMIC_MOVE)
    } catch (error: NativeKeyException) {
      throw error
    } catch (_: Throwable) {
      throw NativeKeyException.materialLost()
    } finally {
      plaintext.fill(0)
      ciphertext.fill(0)
      record.fill(0)
    }
  }

  private fun requireUnlocked() {
    if (!userManager.isUserUnlocked || appContext.isDeviceProtectedStorage) {
      throw NativeKeyException.accessLocked()
    }
  }

  private fun existingKek(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return keyStore.getKey(keyAlias, null) as? SecretKey ?: throw NativeKeyException.materialLost()
  }

  private fun kekForWrite(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
    if (databaseFile.exists()) throw NativeKeyException.materialLost()
    return generateKek(strongBox = true)
  }

  private fun generateKek(strongBox: Boolean): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val builder = KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setRandomizedEncryptionRequired(true)
      .setUserAuthenticationRequired(false)
    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
    return try {
      generator.init(builder.build())
      generator.generateKey()
    } catch (_: StrongBoxUnavailableException) {
      generateKek(strongBox = false)
    }
  }
}

private fun DeviceIdentityMaterial.deepCopy() = copy(
  authenticationPublicKey = authenticationPublicKey.copyOf(),
  e2eePublicKey = e2eePublicKey.copyOf(),
  e2eePrivateKey = e2eePrivateKey.copyOf(),
)

private fun DeviceSessionRecord.deepCopy() = copy(backgroundBearer = backgroundBearer.copyOf())
private fun TripKeyRecord.deepCopy() = copy(key = key.copyOf())
