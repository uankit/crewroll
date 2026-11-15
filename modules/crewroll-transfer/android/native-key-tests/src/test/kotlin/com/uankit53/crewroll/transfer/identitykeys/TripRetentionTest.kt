package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class TripRetentionTest {
  private val scope = NativeKeyScope("a".repeat(64), "installation_retention")
  private val trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
  private val metadata = ActiveTripMetadata(trip, "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
    "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", null, 1)
  private val deadline = Instant.parse("2030-01-09T00:00:00Z")
  private val key = ByteArray(32) { 3 }
  private val before = Instant.parse("2030-01-01T00:00:00Z")

  @Test fun `known trip keys survive delivery window and are tombstoned exactly at hard expiry`() {
    val disk = Persistence()
    val store = AccountScopedKeyStore(disk)
    store.installSession(scope, DeviceSessionRecord("018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
      ByteArray(32) { 7 }, Instant.parse("2031-01-01T00:00:00Z"), "https://example.test"))
    store.importTrip(scope, trip, key, metadata.endsAt, before)
    store.activate(scope, metadata)
    val expired = NativeExpiredTrip(scope, trip, deadline)
    assertEquals(deadline, store.nextTripRetentionDeadline())
    assertTrue(store.expiredTrips(deadline.minusMillis(1)).isEmpty())
    assertFalse(store.purgeExpiredTrip(expired, deadline.minusMillis(1)))
    store.mediaContext()!!.erase()

    val reopened = AccountScopedKeyStore(disk)
    assertEquals(listOf(expired), reopened.expiredTrips(deadline))
    assertTrue(reopened.purgeExpiredTrip(expired, deadline))
    assertNull(reopened.loadTrip(scope, trip))
    assertNull(reopened.mediaContext())
    assertNotNull(reopened.activeSession())
    assertNull(reopened.nextTripRetentionDeadline())
    assertEquals(deadline, reopened.tripRetentionDeadline(scope, trip))
    assertThrows(NativeKeyException::class.java) { reopened.importTrip(scope, trip, key, metadata.endsAt, deadline) }
    // A moved date or device clock rollback cannot defeat the durable tombstone.
    assertEquals(TripImportOutcome.CONFLICT, reopened.importTrip(scope, trip, key, "2031-01-02T00:00:00Z", before))
    assertEquals(TripImportOutcome.CONFLICT, reopened.importTrip(scope, trip, key, metadata.endsAt, before))
    assertEquals(TripCreateOutcome.TOMBSTONED, reopened.createTrip(scope, trip) { error("must not recreate") })
  }

  @Test fun `import alone atomically freezes expiry without activation or sharing`() {
    val disk = Persistence()
    val store = AccountScopedKeyStore(disk)
    disk.failWrite = true
    assertThrows(IllegalStateException::class.java) { store.importTrip(scope, trip, key, metadata.endsAt, before) }
    disk.failWrite = false
    assertNull(store.loadTrip(scope, trip))
    assertNull(store.tripRetentionDeadline(scope, trip))
    store.importTrip(scope, trip, key, metadata.endsAt, before)
    val reopened = AccountScopedKeyStore(disk)
    assertEquals(KeyState.INSTALLED, reopened.loadTrip(scope, trip)!!.state)
    assertNull(reopened.mediaContext())
    assertEquals(deadline, reopened.nextTripRetentionDeadline())
    assertEquals(listOf(NativeExpiredTrip(scope, trip, deadline)), reopened.expiredTrips(deadline))
    assertEquals(TripImportOutcome.EXISTING, reopened.importTrip(scope, trip, key, "2030-01-02T01:00:00+01:00", before.plusSeconds(2)))
    assertEquals(deadline, reopened.tripRetentionDeadline(scope, trip))
    assertEquals(TripImportOutcome.CONFLICT, reopened.importTrip(scope, trip, key, "2030-01-03T00:00:00Z", before))
    assertEquals(TripImportOutcome.CONFLICT, reopened.importTrip(scope, trip, ByteArray(32) { 4 }, metadata.endsAt, before))
    assertThrows(NativeKeyException::class.java) { reopened.activate(scope, metadata.copy(endsAt = "2030-01-03T00:00:00Z")) }
    assertNull(reopened.mediaContext())
    assertTrue(reopened.purgeExpiredTrip(reopened.expiredTrips(deadline).single(), deadline))
  }

  @Test fun `past or invalid import deadlines never install a key`() {
    val store = AccountScopedKeyStore(Persistence())
    assertThrows(NativeKeyException::class.java) { store.importTrip(scope, trip, key, metadata.endsAt, deadline) }
    assertThrows(NativeKeyException::class.java) { store.importTrip(scope, trip, key, "2030-02-30T00:00:00Z", before) }
    assertNull(store.loadTrip(scope, trip))
    assertNull(store.nextTripRetentionDeadline())
  }

  @Test fun `legacy quarantine deadline is persisted once across restart rollback and repeated cleanup`() {
    val disk = legacyDisk()
    val store = AccountScopedKeyStore(disk)
    store.collectExpiredProvisional(before)
    val grace = before.plusSeconds(7 * 86_400L)
    assertNull(store.tripRetentionDeadline(scope, trip)) // not an authoritative trip date
    assertEquals(grace, store.nextTripRetentionDeadline())
    assertThrows(NativeKeyException::class.java) { store.activate(scope, metadata) }
    val writes = disk.writes
    val reopened = AccountScopedKeyStore(disk)
    repeat(10) { reopened.collectExpiredProvisional(before.minusSeconds(86_400)) }
    reopened.collectExpiredProvisional(before.plusSeconds(86_400))
    assertEquals(writes, disk.writes)
    assertEquals(grace, reopened.nextTripRetentionDeadline())
    assertTrue(reopened.expiredTrips(grace.minusNanos(1)).isEmpty())
    assertTrue(reopened.purgeExpiredTrip(reopened.expiredTrips(grace).single(), grace))
    assertNull(reopened.loadTrip(scope, trip))
    // Quarantine is a migration bound, not proof that the real trip has expired.
    assertEquals(TripImportOutcome.INSTALLED, reopened.importTrip(scope, trip, key, metadata.endsAt, grace))
    assertEquals(deadline, reopened.tripRetentionDeadline(scope, trip))
  }

  @Test fun `authenticated backfill replaces quarantine and rejects a stale purge candidate`() {
    val disk = legacyDisk()
    val store = AccountScopedKeyStore(disk)
    store.collectExpiredProvisional(before)
    val grace = before.plusSeconds(7 * 86_400L)
    val stale = store.expiredTrips(grace).single()
    assertEquals(TripImportOutcome.EXISTING, store.importTrip(scope, trip, key, metadata.endsAt, before.plusSeconds(60)))
    assertEquals(deadline, AccountScopedKeyStore(disk).nextTripRetentionDeadline())
    assertFalse(store.purgeExpiredTrip(stale, grace) { fail<Unit>("stale candidate must not delete files") })
    assertNotNull(store.loadTrip(scope, trip))
    assertTrue(store.expiredTrips(grace).isEmpty())
    store.activate(scope, metadata)
  }

  @Test fun `known legacy frozen metadata backfills exact original expiry without a grace extension`() {
    val disk = legacyDisk(metadata)
    val store = AccountScopedKeyStore(disk)
    store.collectExpiredProvisional(deadline.plusSeconds(100))
    assertEquals(deadline, store.tripRetentionDeadline(scope, trip))
    assertEquals(deadline, store.nextTripRetentionDeadline())
    assertEquals(listOf(NativeExpiredTrip(scope, trip, deadline)), store.expiredTrips(deadline))
    assertEquals(metadata.endsAt, disk.load().scopes[androidScopeKey(scope)]!!.tripEndsAt[trip])
  }

  @Test fun `a failed migration or expired-key commit remains retryable`() {
    val disk = legacyDisk()
    val store = AccountScopedKeyStore(disk)
    disk.failWrite = true
    assertThrows(IllegalStateException::class.java) { store.collectExpiredProvisional(before) }
    disk.failWrite = false
    assertNull(store.nextTripRetentionDeadline())
    store.importTrip(scope, trip, key, metadata.endsAt, before)
    val expired = store.expiredTrips(deadline).single()
    disk.failWrite = true
    assertThrows(IllegalStateException::class.java) { store.purgeExpiredTrip(expired, deadline) }
    disk.failWrite = false
    assertNotNull(store.loadTrip(scope, trip))
    assertEquals(listOf(expired), store.expiredTrips(deadline))
    assertTrue(store.purgeExpiredTrip(expired, deadline))
  }

  @Test fun `local file cleanup failure preserves the eligible key for a keys-last retry`() {
    val store = AccountScopedKeyStore(Persistence())
    store.importTrip(scope, trip, key, metadata.endsAt, before)
    val candidate = store.expiredTrips(deadline).single()
    assertThrows(IllegalStateException::class.java) {
      store.purgeExpiredTrip(candidate, deadline) { error("filesystem unavailable") }
    }
    assertNotNull(store.loadTrip(scope, trip))
    var cleaned = false
    assertTrue(store.purgeExpiredTrip(candidate, deadline) {
      assertNotNull(store.loadTrip(scope, trip))
      cleaned = true
    })
    assertTrue(cleaned)
    assertNull(store.loadTrip(scope, trip))
  }

  @Test fun `a cached media lease stops at trip hard expiry even while its bearer is valid`() {
    var now = deadline.minusMillis(1)
    val source = NativeMediaContext(scope, DeviceSessionRecord("018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
      ByteArray(32) { 7 }, deadline.plusSeconds(86_400), "https://example.test"), metadata, key.copyOf())
    val session = NativeMediaSession({ source }, { now })
    session.read()!!.erase()
    now = deadline
    assertThrows(NativeKeyException::class.java) { session.read() }
    assertTrue(source.tripKey.all { it == 0.toByte() })
    assertTrue(source.session.backgroundBearer.all { it == 0.toByte() })
  }

  private fun legacyDisk(frozen: ActiveTripMetadata? = null): Persistence = Persistence().also { disk ->
    val state = AndroidScopedState(scope)
    state.trips[trip] = AndroidStoredTrip.from(TripKeyRecord(key.copyOf(), KeyState.INSTALLED))
    if (frozen != null) state.frozenMetadata[trip] = frozen
    disk.save(AndroidScopedDatabase(scopes = mutableMapOf(androidScopeKey(scope) to state)))
  }

  private class Persistence : ScopedDatabasePersistence {
    private val cipher = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 1 }, "AES"))
    private var bytes: ByteArray? = null
    var failWrite = false
    var writes = 0
    override fun load() = bytes?.let { AndroidScopedDatabaseCodec.decode(it, cipher) } ?: AndroidScopedDatabase()
    override fun save(database: AndroidScopedDatabase) {
      if (failWrite) error("disk unavailable")
      bytes = AndroidScopedDatabaseCodec.encode(database, cipher)
      writes++
    }
  }
}
