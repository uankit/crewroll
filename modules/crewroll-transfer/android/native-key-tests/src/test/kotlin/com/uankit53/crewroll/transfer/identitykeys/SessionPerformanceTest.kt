package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.spec.SecretKeySpec
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class SessionPerformanceTest {
  private val scope = NativeKeyScope("a".repeat(64), "installation_test")
  private val trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
  private fun context() = NativeMediaContext(scope,
    DeviceSessionRecord("018f0d98-76fa-7d1a-b4b4-1f742c2e3150", ByteArray(32) { 7 }, Instant.ofEpochSecond(1000), "https://example.test"),
    ActiveTripMetadata(trip, "018f0d98-76fa-7d1a-b4b4-1f742c2e3160", "2026-09-11T00:00:00Z", "2026-09-12T00:00:00Z", null, 1), ByteArray(32) { 9 })

  @Test fun `hundreds of status reads load secure storage once and own independent buffers`() {
    var loads = 0
    val source = context()
    val session = NativeMediaSession({ loads++; source }, { Instant.EPOCH })
    repeat(500) {
      val value = session.read()!!
      assertEquals(9.toByte(), value.tripKey[0])
      value.erase()
    }
    assertEquals(1, loads)
    assertEquals(7.toByte(), source.session.backgroundBearer[0])
    session.clear()
    assertTrue(source.tripKey.all { it == 0.toByte() })
    assertTrue(source.session.backgroundBearer.all { it == 0.toByte() })
  }

  @Test fun `session mutations never serve a previous account and failures invalidate too`() {
    var stored: NativeMediaContext? = context()
    val previous = stored!!
    val session = NativeMediaSession({ stored }, { Instant.EPOCH })
    session.read()!!.erase()
    session.change { stored = null }
    assertNull(session.read())
    assertTrue(previous.tripKey.all { it == 0.toByte() })
    session.change { stored = context() }
    session.read()!!.erase()
    val beforeFailure = stored!!
    assertThrows(IllegalStateException::class.java) {
      session.change<Unit> { stored = null; error("failed write") }
    }
    assertTrue(beforeFailure.session.backgroundBearer.all { it == 0.toByte() })
    assertNull(session.read())
  }

  @Test fun `expired leases are erased and failed loads are not cached as empty success`() {
    val source = context()
    var now = Instant.EPOCH
    var fail = true
    val session = NativeMediaSession({ if (fail) throw NativeKeyException.accessLocked(); source }, { now })
    assertThrows(NativeKeyException::class.java) { session.read() }
    fail = false
    session.read()!!.erase()
    now = Instant.ofEpochSecond(1000)
    assertThrows(NativeKeyException::class.java) { session.read() }
    assertTrue(source.tripKey.all { it == 0.toByte() })
  }

  @Test fun `foreground work returns immediately even with blocked secure storage`() {
    val started = CountDownLatch(1)
    val unblock = CountDownLatch(1)
    val queue = NativeOperationQueue()
    try {
      val pending = queue.submit("cleanup") { started.countDown(); unblock.await(2, TimeUnit.SECONDS) }
      assertTrue(started.await(1, TimeUnit.SECONDS))
      assertFalse(pending.isDone)
      val next = queue.submit("next") { 42 }
      assertFalse(next.isDone)
      unblock.countDown()
      assertEquals(42, next.get(1, TimeUnit.SECONDS))
    } finally { unblock.countDown(); queue.close() }
  }

  @Test fun `teardown erases owned secrets and permanently rejects new work`() {
    val source = context()
    var loads = 0
    val session = NativeMediaSession({ loads++; source }, { Instant.EPOCH })
    val caller = session.read()!!
    session.close()
    assertTrue(source.tripKey.all { it == 0.toByte() })
    assertTrue(source.session.backgroundBearer.all { it == 0.toByte() })
    assertEquals(9.toByte(), caller.tripKey[0])
    caller.erase()
    assertThrows(NativeKeyException::class.java) { session.read() }
    assertThrows(NativeKeyException::class.java) { session.change { error("must not run") } }
    assertEquals(1, loads)
    session.close()
  }

  @Test fun `empty cleanup never writes and scheduled cleanup skips reads until due`() {
    val disk = TestKeyPersistence()
    val store = AccountScopedKeyStore(disk)
    repeat(100) { assertNull(store.collectExpiredProvisional(Instant.EPOCH)) }
    assertEquals(0, disk.writes)
    val scheduler = ExecutorNativeKeyCleanupScheduler()
    val coordinator = NativeKeyCleanupCoordinator(NativeKeyCleanupRunner(NativeKeyClock { Instant.EPOCH }, store), scheduler)
    try {
      val before = disk.reads
      repeat(100) { coordinator.reconcileIfDue(Instant.EPOCH) }
      assertEquals(1, disk.reads - before)
      assertEquals(0, disk.writes)
    } finally { coordinator.cancel() }
  }

  @Test fun `key expiry writes once and installed keys survive cleanup`() {
    val disk = TestKeyPersistence()
    val store = AccountScopedKeyStore(disk)
    store.createTrip(scope, trip) { TripKeyRecord(ByteArray(32) { 3 }, KeyState.PROVISIONAL, Instant.EPOCH, Instant.ofEpochSecond(100)) }
    val before = disk.writes
    assertEquals(Instant.ofEpochSecond(100), store.collectExpiredProvisional(Instant.ofEpochSecond(99)))
    assertEquals(before, disk.writes)
    assertNull(store.collectExpiredProvisional(Instant.ofEpochSecond(100)))
    assertEquals(before + 1, disk.writes)
    assertNull(store.loadTrip(scope, trip))
    assertEquals(TripCreateOutcome.TOMBSTONED, store.createTrip(scope, trip) { error("must not recreate") })
    store.importTrip(scope, trip, ByteArray(32) { 5 }, context().metadata.endsAt, Instant.EPOCH)
    val installedWrites = disk.writes
    store.collectExpiredProvisional(Instant.ofEpochSecond(200))
    assertEquals(installedWrites, disk.writes)
    assertEquals(KeyState.INSTALLED, store.loadTrip(scope, trip)!!.state)
  }

  @Test fun `failed persistence does not advance durable state`() {
    val disk = TestKeyPersistence()
    val store = AccountScopedKeyStore(disk)
    store.importTrip(scope, trip, ByteArray(32) { 5 }, context().metadata.endsAt, Instant.EPOCH)
    disk.failWrite = true
    assertThrows(IllegalStateException::class.java) { store.activate(scope, context().metadata) }
    assertEquals(KeyState.INSTALLED, store.loadTrip(scope, trip)!!.state)
  }

  @Test fun `failed writes and loads invalidate metadata while destructive cleanup always revalidates storage`() {
    val disk = TestKeyPersistence()
    val store = AccountScopedKeyStore(disk)
    store.importTrip(scope, trip, ByteArray(32) { 5 }, context().metadata.endsAt, Instant.EPOCH)
    val deadline = NativeTripRetention.deadline(context().metadata)
    val expired = store.expiredTrips(deadline).single()
    disk.failWrite = true
    assertThrows(IllegalStateException::class.java) { store.purgeExpiredTrip(expired, deadline) }
    disk.failWrite = false
    val before = disk.reads
    assertEquals(deadline, store.nextTripRetentionDeadline())
    assertEquals(before + 1, disk.reads, "failed commit must not publish an uncommitted retention index")

    disk.failRead = true
    assertThrows(IllegalStateException::class.java) { store.loadTrip(scope, trip) }
    assertThrows(IllegalStateException::class.java) { store.expiredTrips(deadline) }
    disk.failRead = false
    assertEquals(listOf(expired), store.expiredTrips(deadline))
    disk.corruptRecord()
    var filesPurged = false
    assertThrows(NativeKeyException::class.java) { store.purgeExpiredTrip(expired, deadline) { filesPurged = true } }
    assertFalse(filesPurged, "cached expiry alone must never authorize deleting local files")
    assertThrows(NativeKeyException::class.java) { store.nextTripRetentionDeadline() }
  }

  @Test fun `read snapshots reject writes including nested upgrades and release their secrets on every exit`() {
    val disk = TestKeyPersistence()
    val store = AccountScopedKeyStore(disk)
    store.importTrip(scope, trip, ByteArray(32) { 5 }, context().metadata.endsAt, Instant.EPOCH)
    val writes = disk.writes
    val key = store.readSnapshot {
      val own = store.loadTrip(scope, trip)!!.key
      assertThrows(NativeKeyException::class.java) { store.discardProvisional(scope, trip) }
      assertThrows(NativeKeyException::class.java) { store.commandSnapshot { store.clearSession() } }
      own
    }
    assertEquals(writes, disk.writes)
    assertEquals(5.toByte(), key[0])
    key.fill(0)
    disk.loaded.forEach { database ->
      assertTrue(database.scopes.values.all { state -> state.trips.values.all { it.key.all { byte -> byte == 0.toByte() } } })
    }
    val before = disk.reads
    assertThrows(IllegalStateException::class.java) {
      store.commandSnapshot { store.loadTrip(scope, trip)!!.key.fill(0); error("command failed") }
    }
    assertEquals(5.toByte(), store.loadTrip(scope, trip)!!.key[0])
    assertEquals(before + 2, disk.reads, "a completed or failed scope must never become a long-lived key cache")
    disk.loaded.forEach { database ->
      assertTrue(database.scopes.values.all { state -> state.trips.values.all { it.key.all { byte -> byte == 0.toByte() } } })
    }
  }
}

private class TestKeyPersistence : ScopedDatabasePersistence {
  private val cipher = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 1 }, "AES"))
  private var bytes: ByteArray? = null
  var reads = 0
  var writes = 0
  var failWrite = false
  var failRead = false
  val loaded = mutableListOf<AndroidScopedDatabase>()
  fun corruptRecord() { bytes = bytes!!.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() } }
  override fun load(): AndroidScopedDatabase {
    reads++
    if (failRead) error("disk unavailable")
    return (bytes?.let { AndroidScopedDatabaseCodec.decode(it, cipher) } ?: AndroidScopedDatabase()).also(loaded::add)
  }
  override fun save(database: AndroidScopedDatabase) {
    if (failWrite) error("disk unavailable")
    bytes = AndroidScopedDatabaseCodec.encode(database, cipher)
    writes++
  }
}
