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
  // Only identifiers and deadlines survive a synchronous command. No identity,
  // session bearer, trip key, or decrypted database is retained between calls.
  private var retentionIndex: List<NativeExpiredTrip>? = null
  private class Snapshot(var database: AndroidScopedDatabase? = null, var readOnly: Boolean)
  private var snapshot: Snapshot? = null

  override fun <T> readSnapshot(body: () -> T): T = withSnapshot(true, body)
  override fun <T> commandSnapshot(body: () -> T): T = withSnapshot(false, body)

  override fun expiredTrips(now: Instant): List<NativeExpiredTrip> = lock.withLock {
    retentionIndex().filter { it.deadline <= now }
  }
  override fun nextTripRetentionDeadline(): Instant? = lock.withLock {
    retentionIndex().minOfOrNull { it.deadline }
  }
  override fun tripRetentionDeadline(scope: NativeKeyScope, tripId: String): Instant? = read { database ->
    database.scopes[androidScopeKey(scope)]?.authoritativeDeadline(tripId)
  }
  override fun purgeExpiredTrip(trip: NativeExpiredTrip, now: Instant, beforeKeyRemoval: () -> Unit): Boolean = transaction { database ->
    val state = database.scopes[androidScopeKey(trip.scope)] ?: return@transaction false
    val deadline = state.cleanupDeadline(trip.tripId) ?: return@transaction false
    if (deadline != trip.deadline || deadline > now || !state.trips.containsKey(trip.tripId)) return@transaction false
    // No import/backfill can invalidate eligibility between file cleanup and
    // the final key deletion while this store transaction lock is held.
    beforeKeyRemoval()
    state.trips.remove(trip.tripId)?.key?.fill(0)
    state.tombstones.add(trip.tripId)
    if (state.activeMetadata?.tripId == trip.tripId) state.activeMetadata = null
    // Retain authoritative timing as a replay fence. Undated quarantine
    // tombstones can recover through an authenticated dated envelope.
    true
  }
  override fun eraseAccount(accountHash: String, removeIdentity: (NativeKeyScope) -> Unit): Unit = transaction { database ->
    if (!accountHash.matches(Regex("^[a-f0-9]{64}$"))) throw NativeKeyException.invalidCommand()
    val installations = database.scopes.values.filter { it.scope.accountHash == accountHash }.map { it.scope.installationId }.toMutableSet()
    database.identities[accountHash]?.let { installations.add(it.installationId) }
    database.pendingIdentities[accountHash]?.let { installations.add(it) }
    installations.forEach { removeIdentity(NativeKeyScope(accountHash, it)) }
    database.identities.remove(accountHash)?.e2eePrivateKey?.fill(0)
    database.pendingIdentities.remove(accountHash)
    database.scopes.entries.removeAll { entry ->
      if (entry.value.scope.accountHash != accountHash) false else {
        entry.value.session?.backgroundBearer?.fill(0)
        entry.value.trips.values.forEach { it.key.fill(0) }
        true
      }
    }
    if (database.selectedScope?.accountHash == accountHash) database.selectedScope = null
  }
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
    if (trip.state != KeyState.ACTIVE || state.authoritativeDeadline(metadata.tripId) != NativeTripRetention.deadline(metadata))
      throw NativeKeyException.invalidState()
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

  override fun collectExpiredProvisional(now: Instant): Instant? {
    var changed = false
    return transaction(persistWhen = { changed }) { database ->
    database.scopes.values.forEach { state ->
      state.trips.toMap().forEach { (tripId, snapshot) ->
        val metadata = state.frozenMetadata[tripId] ?: state.activeMetadata?.takeIf { it.tripId == tripId }
        if (metadata != null) {
          val existing = state.tripEndsAt[tripId]
          if (existing == null) {
            state.tripEndsAt[tripId] = metadata.endsAt
            changed = true
          } else if (NativeTripRetention.deadline(existing) != NativeTripRetention.deadline(metadata)) {
            throw NativeKeyException.materialLost()
          }
        }
        if (snapshot.state != KeyState.PROVISIONAL) {
          if (!state.tripEndsAt.containsKey(tripId) && !state.legacyReconciliationDeadlines.containsKey(tripId)) {
            state.legacyReconciliationDeadlines[tripId] = now.plusSeconds(NativeTripRetention.RECONCILIATION_GRACE_SECONDS)
            changed = true
          }
          return@forEach
        }
        val expiresAt = snapshot.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
        val current = state.trips[tripId]
        if (!expiresAt.isAfter(now) && current?.state == KeyState.PROVISIONAL) {
          state.trips.remove(tripId)?.key?.fill(0)
          state.tombstones.add(tripId)
          changed = true
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
  }

  override fun importTrip(
    scope: NativeKeyScope,
    tripId: String,
    key: ByteArray,
    endsAt: String,
    now: Instant,
  ): TripImportOutcome {
    var changed = false
    return transaction(persistWhen = { changed }) { database ->
    if (key.size != 32) throw NativeKeyException.invalidEnvelope()
    val state = database.scopes.getOrPut(androidScopeKey(scope)) { AndroidScopedState(scope) }
    val deadline = NativeTripRetention.deadline(endsAt)
    if (deadline <= now) throw NativeKeyException.materialLost()
    state.authoritativeDeadline(tripId)?.let {
      if (it != deadline) return@transaction TripImportOutcome.CONFLICT
    }
    if (state.tombstones.contains(tripId) && state.authoritativeDeadline(tripId) != null)
      return@transaction TripImportOutcome.CONFLICT
    val existing = state.trips[tripId]
    if (existing != null) {
      if (!MessageDigest.isEqual(existing.key, key)) return@transaction TripImportOutcome.CONFLICT
      if (existing.state == KeyState.PROVISIONAL) {
        state.trips[tripId] = existing.copy(state = KeyState.INSTALLED)
        changed = true
      }
      if (state.tripEndsAt[tripId] != endsAt) { state.tripEndsAt[tripId] = endsAt; changed = true }
      if (state.legacyReconciliationDeadlines.remove(tripId) != null) changed = true
      if (state.tombstones.remove(tripId)) changed = true
      return@transaction TripImportOutcome.EXISTING
    }
    state.trips[tripId] = TripKeyRecord(key.copyOf(), KeyState.INSTALLED)
    state.tripEndsAt[tripId] = endsAt
    state.legacyReconciliationDeadlines.remove(tripId)
    state.tombstones.remove(tripId)
    changed = true
    TripImportOutcome.INSTALLED
    }
  }

  override fun activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) {
    var changed = false
    transaction(persistWhen = { changed }) { database ->
    val state = database.scopes[androidScopeKey(scope)] ?: throw NativeKeyException.materialLost()
    val target = state.trips[metadata.tripId] ?: throw NativeKeyException.materialLost()
    if (target.state != KeyState.INSTALLED && target.state != KeyState.ACTIVE) {
      throw NativeKeyException.materialLost()
    }
    if (state.authoritativeDeadline(metadata.tripId) != NativeTripRetention.deadline(metadata))
      throw NativeKeyException.invalidState()
    state.frozenMetadata[metadata.tripId]?.takeIf { it != metadata }?.let {
      throw NativeKeyException.invalidState()
    }
    if (target.state == KeyState.ACTIVE && state.activeMetadata == metadata &&
      state.frozenMetadata[metadata.tripId] == metadata) return@transaction
    state.activeMetadata?.tripId?.takeIf { it != metadata.tripId }?.let { priorId ->
      state.trips[priorId]?.let { prior -> state.trips[priorId] = prior.copy(state = KeyState.INSTALLED) }
    }
    state.trips[metadata.tripId] = target.copy(state = KeyState.ACTIVE)
    state.frozenMetadata[metadata.tripId] = metadata
    state.activeMetadata = metadata
    changed = true
    }
  }

  override fun deactivate(scope: NativeKeyScope, tripId: String) = transaction { database ->
    val state = database.scopes[androidScopeKey(scope)] ?: return@transaction
    if (state.activeMetadata?.tripId != tripId) return@transaction
    state.trips[tripId]?.let { state.trips[tripId] = it.copy(state = KeyState.INSTALLED) }
    state.activeMetadata = null
  }

  private fun <T> read(body: (AndroidScopedDatabase) -> T): T = lock.withLock {
    val scope = snapshot
    val database = scope?.database ?: load().also { scope?.database = it }
    try { body(database) } finally { if (scope == null) database.zeroize() }
  }

  private fun <T> transaction(persistWhen: (T) -> Boolean = { true }, body: (AndroidScopedDatabase) -> T): T = lock.withLock {
    val scope = snapshot
    if (scope?.readOnly == true) throw NativeKeyException.invalidState()
    val database = scope?.database ?: load().also { scope?.database = it }
    try {
      val result = body(database)
      // Never defer or coalesce saves: pending identity reservation and every
      // other existing mutation remain individually crash-durable.
      if (persistWhen(result)) persistence.save(database)
      updateRetentionIndex(database)
      result
    } catch (error: Throwable) {
      retentionIndex = null
      if (scope != null) { database.zeroize(); scope.database = null }
      throw error
    } finally { if (scope == null) database.zeroize() }
  }

  private fun <T> withSnapshot(readOnly: Boolean, body: () -> T): T = lock.withLock {
    val existing = snapshot
    if (existing != null) {
      if (!readOnly && existing.readOnly) throw NativeKeyException.invalidState()
      val previousReadOnly = existing.readOnly
      existing.readOnly = existing.readOnly || readOnly
      try { return@withLock body() } finally { existing.readOnly = previousReadOnly }
    }
    val owned = Snapshot(readOnly = readOnly)
    snapshot = owned
    try { body() }
    catch (error: Throwable) { retentionIndex = null; throw error }
    finally { owned.database?.zeroize(); snapshot = null }
  }

  private fun load(): AndroidScopedDatabase {
    retentionIndex = null
    val database = persistence.load()
    try { updateRetentionIndex(database); return database }
    catch (error: Throwable) { database.zeroize(); throw error }
  }

  private fun retentionIndex(): List<NativeExpiredTrip> {
    retentionIndex?.let { return it }
    read { }
    return retentionIndex ?: throw NativeKeyException.materialLost()
  }

  private fun updateRetentionIndex(database: AndroidScopedDatabase) {
    retentionIndex = database.scopes.values.flatMap { state ->
      state.trips.keys.mapNotNull { tripId ->
        state.cleanupDeadline(tripId)?.let { NativeExpiredTrip(state.scope, tripId, it) }
      }
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
