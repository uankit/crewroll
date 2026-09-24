package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AccountErasureTest {
  private class Persistence : ScopedDatabasePersistence {
    private val cipher = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 9 }, "AES"))
    private var bytes = AndroidScopedDatabaseCodec.encode(AndroidScopedDatabase(), cipher)
    override fun load() = AndroidScopedDatabaseCodec.decode(bytes, cipher)
    override fun save(database: AndroidScopedDatabase) { bytes = AndroidScopedDatabaseCodec.encode(database, cipher) }
  }

  @Test fun `erasure retries after hardware failure and preserves the other account`() {
    val store = AccountScopedKeyStore(Persistence())
    val hashA = "a".repeat(64)
    val hashB = "b".repeat(64)
    fun install(hash: String, id: String): NativeKeyScope {
      val scope = store.reservePendingIdentity(hash) { id }
      store.finalizeIdentity(scope, DeviceIdentityMaterial(id, byteArrayOf(4) + ByteArray(64) { 1 }, ByteArray(32) { 2 }, ByteArray(32) { 3 }))
      return scope
    }
    val a = install(hashA, "install_account_a")
    val b = install(hashB, "install_account_b")
    val trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
    store.createTrip(a, trip) { TripKeyRecord(ByteArray(32) { 7 }, KeyState.PROVISIONAL, Instant.now(), Instant.now().plusSeconds(86400)) }
    store.installSession(b, DeviceSessionRecord("018f0d98-76fa-7d1a-b4b4-1f742c2e3150", "crb_fixture_write_only".toByteArray(), Instant.ofEpochMilli(3600000), "https://api.example.test"))
    assertThrows(IllegalStateException::class.java) { store.eraseAccount(hashA) { throw IllegalStateException("locked") } }
    assertNotNull(store.loadIdentity(hashA))
    assertNotNull(store.loadTrip(a, trip))
    val removed = mutableListOf<NativeKeyScope>()
    store.eraseAccount(hashA) { removed.add(it) }
    store.eraseAccount(hashA) { removed.add(it) }
    assertEquals(listOf(a), removed)
    assertNull(store.loadIdentity(hashA))
    assertNull(store.loadTrip(a, trip))
    assertFalse(store.hasScopedMaterial(hashA))
    assertNotNull(store.loadIdentity(hashB))
    assertEquals(b, store.activeSession()?.scope)
    store.eraseAccount(hashB) {}
    assertNull(store.activeSession())
  }

  @Test fun `erasure removes an interrupted identity reservation`() {
    val store = AccountScopedKeyStore(Persistence())
    val hash = "a".repeat(64)
    val scope = store.reservePendingIdentity(hash) { "pending_install_a" }
    val removed = mutableListOf<NativeKeyScope>()
    store.eraseAccount(hash) { removed.add(it) }
    assertEquals(listOf(scope), removed)
    assertNotEquals(scope, store.reservePendingIdentity(hash) { "fresh_install_a" })
  }
}
