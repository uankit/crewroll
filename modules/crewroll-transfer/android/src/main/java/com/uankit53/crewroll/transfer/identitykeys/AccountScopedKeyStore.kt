package com.uankit53.crewroll.transfer.identitykeys

import java.security.MessageDigest
import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Persistence owns encryption and atomic disk I/O; domain transactions own key state. */
internal interface ScopedDatabasePersistence {
  fun load(): AndroidScopedDatabase
  fun save(database: AndroidScopedDatabase)
}

internal class AccountScopedKeyStore(private val persistence: ScopedDatabasePersistence) : NativeKeyStore {
  private val lock = ReentrantLock()
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

  override fun finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial): Unit = transaction { database ->
    if (database.pendingIdentities[scope.accountHash] != scope.installationId ||
      value.installationId != scope.installationId || database.identities.containsKey(scope.accountHash)
    ) throw NativeKeyException.materialLost()
    database.identities[scope.accountHash] = value.deepCopy()
    database.scopes.putIfAbsent(androidScopeKey(scope), AndroidScopedState(scope))
    database.pendingIdentities.remove(scope.accountHash)
    Unit
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
  override fun mediaContext(): NativeMediaContext? = read { database ->
    val scope = database.selectedScope ?: return@read null
    val state = database.scopes[androidScopeKey(scope)] ?: return@read null
    val metadata = state.activeMetadata ?: return@read null
    val session = state.session ?: return@read null
    val trip = state.trips[metadata.tripId] ?: throw NativeKeyException.materialLost()
    if (trip.state != KeyState.ACTIVE) throw NativeKeyException.invalidState()
    NativeMediaContext(scope, session.deepCopy(), metadata, trip.key.copyOf())
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

  override fun clearSession(): Unit = transaction { database ->
    database.selectedScope?.let { scope ->
      database.scopes[androidScopeKey(scope)]?.let { state ->
        state.session?.backgroundBearer?.fill(0)
        state.session = null
        state.activeMetadata?.tripId?.let { id ->
          state.trips[id]?.let { state.trips[id] = it.copy(state = KeyState.INSTALLED) }
        }
        state.activeMetadata = null
      }
    }
    database.selectedScope = null
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

  override fun collectExpiredProvisional(now: Instant): Instant? = lock.withLock {
    val database = persistence.load()
    try {
    var changed = false
    database.scopes.values.forEach { state ->
      state.trips.toMap().forEach { (tripId, snapshot) ->
        if (snapshot.state != KeyState.PROVISIONAL) return@forEach
        val expiresAt = snapshot.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
        val current = state.trips[tripId]
        if (!expiresAt.isAfter(now) && current?.state == KeyState.PROVISIONAL) {
          state.trips.remove(tripId)?.key?.fill(0)
          state.tombstones.add(tripId)
          changed = true
        }
      }
    }
    if (changed) persistence.save(database)
    database.scopes.values.asSequence()
      .flatMap { it.trips.values.asSequence() }
      .filter { it.state == KeyState.PROVISIONAL }
      .map {
        it.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
      }
      .minOrNull()
    } finally { database.zeroize() }
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
    val database = persistence.load()
    try { body(database) } finally { database.zeroize() }
  }

  private fun <T> transaction(body: (AndroidScopedDatabase) -> T): T = lock.withLock {
    val database = persistence.load()
    try {
      val result = body(database)
      persistence.save(database)
      result
    } finally { database.zeroize() }
  }


}

private fun DeviceIdentityMaterial.deepCopy() = copy(
  authenticationPublicKey = authenticationPublicKey.copyOf(),
  e2eePublicKey = e2eePublicKey.copyOf(),
  e2eePrivateKey = e2eePrivateKey.copyOf(),
)

private fun DeviceSessionRecord.deepCopy() = copy(backgroundBearer = backgroundBearer.copyOf())
private fun TripKeyRecord.deepCopy() = copy(key = key.copyOf())
