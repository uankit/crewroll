package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.spec.SecretKeySpec
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class SelectiveProtectedStorageTest {
  private val scope = NativeKeyScope("a".repeat(64), "install_A-123456")
  private val target = uuid(1)
  private val metadata = ActiveTripMetadata(target, uuid(2), "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", null, 1)

  @Test fun `selected reads use a fixed number of real cipher operations regardless of unrelated accounts and trips`() {
    for (unrelated in listOf(0, 4, 24)) {
      val disk = encryptedDisk(unrelated)
      val store = AccountScopedKeyStore(disk)
      disk.resetCounters()
      store.readSnapshot {
        val identity = store.loadIdentity(scope.accountHash)!!
        assertEquals(scope.installationId, identity.installationId)
        identity.e2eePrivateKey.fill(0)
        val session = store.activeSession()!!
        assertEquals(scope, session.scope)
        session.session.backgroundBearer.fill(0)
        assertEquals(NativeSelectedTrip(scope, metadata), store.activeSelection())
        val trip = store.loadTrip(scope, target)!!
        assertEquals(7.toByte(), trip.key[0]); trip.key.fill(0)
      }
      assertEquals(1, disk.outer.opens, "one authenticated container open, unrelated=$unrelated")
      assertEquals(3, disk.inner.opens, "only the selected identity, bearer and key, unrelated=$unrelated")
      assertEquals(0, disk.inner.seals)
      assertEquals(0, disk.outer.seals)
      assertTrue(disk.inner.opened.all { bytes -> bytes.all { it == 0.toByte() } })
      disk.loaded.forEach(::assertErased)
    }
  }

  @Test fun `selection and retention inspect authenticated metadata without opening any secret`() {
    val disk = encryptedDisk(8)
    val store = AccountScopedKeyStore(disk)
    disk.resetCounters()
    assertEquals(NativeSelectedTrip(scope, metadata), store.activeSelection())
    assertEquals(KeyState.ACTIVE, store.tripMetadata(scope, target)!!.state)
    assertTrue(store.expiredTrips(Instant.parse("2030-01-01T00:00:00Z")).isEmpty())
    assertEquals(0, disk.inner.opens)
    assertEquals(0, disk.inner.seals)
    disk.loaded.forEach(::assertErased)
  }

  @Test fun `metadata commits preserve every existing sealed secret and keep the outer atomic save`() {
    val disk = encryptedDisk(4)
    val before = disk.secretRecords(scope, target)
    val store = AccountScopedKeyStore(disk)
    disk.resetCounters()
    store.deactivate(scope, target)
    assertEquals(0, disk.inner.opens)
    assertEquals(0, disk.inner.seals)
    assertEquals(1, disk.outer.opens)
    assertEquals(1, disk.outer.seals)
    val after = disk.secretRecords(scope, target)
    before.zip(after).forEach { (a, b) -> assertArrayEquals(a, b) }
    val database = disk.load()
    assertEquals(KeyState.INSTALLED, database.scopes[androidScopeKey(scope)]!!.trips[target]!!.state)
    assertNull(database.scopes[androidScopeKey(scope)]!!.activeMetadata)
    database.zeroize()
  }

  @Test fun `removing expired and erased records never decrypts their secrets or unrelated accounts`() {
    val disk = encryptedDisk(4)
    val store = AccountScopedKeyStore(disk)
    disk.resetCounters()
    val deadline = NativeTripRetention.deadline(metadata)
    assertTrue(store.purgeExpiredTrip(NativeExpiredTrip(scope, target, deadline), deadline))
    assertEquals(0, disk.inner.opens)
    assertEquals(0, disk.inner.seals)
    assertEquals(1, disk.outer.seals)
    val removedScopes = mutableListOf<NativeKeyScope>()
    store.eraseAccount(scope.accountHash) { removedScopes += it }
    assertEquals(listOf(scope), removedScopes)
    assertEquals(0, disk.inner.opens)
    assertEquals(0, disk.inner.seals)
    val database = disk.load()
    assertFalse(database.identities.containsKey(scope.accountHash))
    assertFalse(database.scopes.containsKey(androidScopeKey(scope)))
    assertEquals(4, database.scopes.size)
    database.zeroize()
  }

  @Test fun `an unopened bad trip cannot block public selection but fails closed when its key is requested`() {
    val disk = encryptedDisk(4)
    disk.inner.failAad = AndroidScopedDatabaseCodec.tripAad(scope, target)
    val store = AccountScopedKeyStore(disk)
    disk.resetCounters()
    assertEquals(target, store.activeSelection()!!.metadata.tripId)
    assertEquals(0, disk.inner.opens)
    val before = disk.bytes.copyOf()
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) { store.activate(scope, metadata) }.code)
    assertArrayEquals(before, disk.bytes, "damaged key activation must not write a successful selection")
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) { store.mediaContext() }.code)
    assertTrue(disk.inner.opened.all { bytes -> bytes.all { it == 0.toByte() } })
    assertNull(store.activeSelection()?.takeIf { it.scope != scope })
  }

  @Test fun `sealed records cannot be moved to another canonical aad during a metadata save`() {
    val disk = encryptedDisk(0)
    val before = disk.bytes.copyOf()
    val database = disk.load()
    val state = database.scopes[androidScopeKey(scope)]!!
    state.trips[uuid(99)] = state.trips.remove(target)!!
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) { disk.save(database) }.code)
    assertArrayEquals(before, disk.bytes)
    database.zeroize()
  }

  @Test fun `outer authentication still rejects metadata or ciphertext corruption before any inner open`() {
    val disk = encryptedDisk(4)
    disk.resetCounters()
    disk.bytes[disk.bytes.lastIndex] = (disk.bytes.last().toInt() xor 1).toByte()
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) { disk.load() }.code)
    assertEquals(0, disk.inner.opens)
  }

  @Test fun `failed metadata commit leaves the previous durable state and permits a clean retry`() {
    val disk = encryptedDisk(4)
    val store = AccountScopedKeyStore(disk)
    val before = disk.bytes.copyOf()
    disk.failBeforeCommit = true
    assertThrows(IllegalStateException::class.java) { store.deactivate(scope, target) }
    assertArrayEquals(before, disk.bytes)
    disk.loaded.forEach(::assertErased)
    disk.failBeforeCommit = false
    assertEquals(target, store.activeSelection()!!.metadata.tripId)
    store.deactivate(scope, target)
    assertNull(store.activeSelection())
    assertEquals(0, disk.inner.opens)
  }

  @Test fun `maintenance requests remain nonblocking coalesced and cancellable while work waits`() {
    val executor = Executors.newSingleThreadExecutor()
    val entered = CountDownLatch(1)
    val release = CompletableFuture<Unit>()
    var calls = 0
    val maintenance = NativeDeferredMaintenance({ task -> executor.execute(task) }) {
      calls++; entered.countDown(); release
    }
    try {
      maintenance.request()
      assertTrue(entered.await(3, TimeUnit.SECONDS))
      val requesting = Executors.newSingleThreadExecutor()
      try { requesting.submit { repeat(100) { maintenance.request() } }.get(1, TimeUnit.SECONDS) }
      finally { requesting.shutdownNow() }
      assertEquals(1, calls)
      maintenance.close()
      release.complete(Unit)
      maintenance.request()
      executor.submit {}.get(3, TimeUnit.SECONDS)
      assertEquals(1, calls)
      val queued = mutableListOf<() -> Unit>()
      var cancelledWork = 0
      val cancelled = NativeDeferredMaintenance({ task -> queued += task }) {
        cancelledWork++; CompletableFuture.completedFuture(Unit)
      }
      cancelled.request(); cancelled.close(); queued.single().invoke()
      assertEquals(0, cancelledWork)
    } finally { release.complete(Unit); maintenance.close(); executor.shutdownNow() }
  }

  @Test fun `utility failure can retry without a busy loop and device preparation never reloads an old selection`() {
    val queue = mutableListOf<() -> Unit>()
    var calls = 0
    val maintenance = NativeDeferredMaintenance({ task -> queue += task }) {
      calls++
      if (calls == 1) throw IllegalStateException("fixture maintenance failure")
      CompletableFuture.completedFuture(Unit)
    }
    maintenance.request(); queue.removeAt(0).invoke()
    assertEquals(1, calls); assertTrue(queue.isEmpty())
    maintenance.request(); queue.removeAt(0).invoke()
    assertEquals(2, calls)
    var fallbackLoads = 0
    val media = NativeMediaSession({ fallbackLoads++; error("old selection must not be restored") })
    media.prepareDevice { Unit }
    assertNull(media.read()); assertEquals(0, fallbackLoads); assertFalse(media.hasPreparedContext())
    assertThrows(IllegalStateException::class.java) { media.prepareDevice { error("fixture prepare failed") } }
    assertNull(media.read()); assertEquals(0, fallbackLoads)
    media.close()
  }

  private fun encryptedDisk(unrelatedAccounts: Int): ProtectedPersistence {
    val database = AndroidScopedDatabase()
    fun add(account: NativeKeyScope, index: Int, selected: Boolean) {
      database.identities[account.accountHash] = AndroidStoredIdentity.from(DeviceIdentityMaterial(account.installationId,
        byteArrayOf(4) + ByteArray(64) { 3 }, ByteArray(32) { 4 }, ByteArray(32) { 5 }))
      val state = AndroidScopedState(account, DeviceSessionRecord(uuid(10_000 + index), "crb_fixture_write_only".toByteArray(),
        Instant.parse("2099-01-01T00:00:00Z"), "https://api.crewroll.app"))
      repeat(if (selected) 1 else 32) { id ->
        val trip = if (selected) target else uuid(100_000 + index * 32 + id)
        state.trips[trip] = AndroidStoredTrip.from(TripKeyRecord(ByteArray(32) { 7 }, if (selected) KeyState.ACTIVE else KeyState.INSTALLED))
        state.tripEndsAt[trip] = metadata.endsAt
      }
      if (selected) { state.activeMetadata = metadata; state.frozenMetadata[target] = metadata }
      database.scopes[androidScopeKey(account)] = state
    }
    add(scope, 0, true)
    repeat(unrelatedAccounts) { index -> add(NativeKeyScope((index + 1).toString(16).padStart(64, '0'), "install_unrelated_$index"), index + 1, false) }
    database.selectedScope = scope
    return ProtectedPersistence(database)
  }

  private fun assertErased(database: AndroidScopedDatabase) {
    assertTrue(database.identities.values.all { it.privateKey.isErased })
    database.scopes.values.forEach { s ->
      assertTrue(s.session?.bearer?.isErased != false)
      assertTrue(s.trips.values.all { it.secret.isErased })
    }
  }
}

private fun uuid(value: Int) = "01990000-0000-7000-8000-" + value.toString(16).padStart(12, '0')

private class CipherCalls : AndroidScopedSecretCipher {
  private val actual = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 0x35 }, "AES"))
  var opens = 0
  var seals = 0
  var failAad: ByteArray? = null
  val opened = mutableListOf<ByteArray>()
  override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray { seals++; return actual.seal(plaintext, aad) }
  override fun open(record: ByteArray, aad: ByteArray): ByteArray {
    opens++
    if (failAad?.contentEquals(aad) == true) throw NativeKeyException.materialLost()
    return actual.open(record, aad).also(opened::add)
  }
  fun reset() { opens = 0; seals = 0; opened.clear() }
}

/** Exercises the same authenticated outer container plus lazy inner codec. The
 * real AES-GCM API calls are counted; this is not Android hardware timing. */
private class ProtectedPersistence(database: AndroidScopedDatabase) : ScopedDatabasePersistence {
  val inner = CipherCalls()
  val outer = CipherCalls()
  val loaded = mutableListOf<AndroidScopedDatabase>()
  private val outerAad = "CRKEYDB3|atomic-container|2".toByteArray()
  var bytes: ByteArray = ByteArray(0)
  var failBeforeCommit = false
  init { save(database); database.zeroize() }
  override fun load(): AndroidScopedDatabase {
    val body = outer.open(bytes, outerAad)
    return try { AndroidScopedDatabaseCodec.decode(body, inner).also(loaded::add) }
    finally { body.fill(0) }
  }
  override fun save(database: AndroidScopedDatabase) {
    val body = AndroidScopedDatabaseCodec.encode(database, inner)
    val replacement = try { outer.seal(body, outerAad) } finally { body.fill(0) }
    if (failBeforeCommit) { replacement.fill(0); throw IllegalStateException("fixture pre-commit failure") }
    bytes = replacement
  }
  fun resetCounters() { inner.reset(); outer.reset(); loaded.clear() }
  fun secretRecords(scope: NativeKeyScope, trip: String): List<ByteArray> {
    val database = load()
    return try {
      val state = database.scopes[androidScopeKey(scope)]!!
      listOf(database.identities[scope.accountHash]!!.privateKey.sealedCopy(AndroidScopedDatabaseCodec.identityAad(scope), inner),
        state.session!!.bearer.sealedCopy(AndroidScopedDatabaseCodec.sessionAad(scope, state.session!!.deviceId), inner),
        state.trips[trip]!!.secret.sealedCopy(AndroidScopedDatabaseCodec.tripAad(scope, trip), inner))
    } finally { database.zeroize() }
  }
}
