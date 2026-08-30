package com.uankit53.crewroll.transfer.identitykeys

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.time.Instant
import javax.crypto.spec.SecretKeySpec
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AndroidScopedDatabaseCodecTest {
  private fun cipher() = AesGcmScopedSecretCipher(
    SecretKeySpec(ByteArray(32) { 0x5a }, "AES"),
  )

  @Test fun `round trip preserves scoped secrets and rejects corrupt records`() {
    val accountHash = "a".repeat(64)
    val installationId = "install_A-123456"
    val scope = NativeKeyScope(accountHash, installationId)
    val tripId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
    val identity = DeviceIdentityMaterial(
      installationId,
      byteArrayOf(4) + ByteArray(64) { 0x31 },
      ByteArray(32) { 0x32 },
      ByteArray(32) { 0x33 },
    )
    val state = AndroidScopedState(
      scope = scope,
      session = DeviceSessionRecord(
        "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
        "crb_fixture_write_only".toByteArray(),
        Instant.ofEpochMilli(1_000),
        "https://api.crewroll.app",
      ),
    )
    state.trips[tripId] = TripKeyRecord(
      ByteArray(32) { 0x44 },
      KeyState.PROVISIONAL,
      Instant.ofEpochMilli(10),
      Instant.ofEpochMilli(86_400_010),
    )
    state.tombstones += "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
    state.activeMetadata = ActiveTripMetadata(
      tripId,
      "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
      "2026-08-29T12:00:00Z",
      "2026-09-02T12:00:00.123Z",
      null,
      1,
    )
    state.frozenMetadata[tripId] = state.activeMetadata!!
    val database = AndroidScopedDatabase(
      mutableMapOf(accountHash to identity),
      mutableMapOf("b".repeat(64) to "pending_install_123"),
      mutableMapOf(androidScopeKey(scope) to state),
      scope,
    )

    val cipher = cipher()
    val encoded = AndroidScopedDatabaseCodec.encode(database, cipher)
    assertFalse(String(encoded, Charsets.ISO_8859_1).contains("user_A-1"))
    assertFalse(encoded.containsSubsequence(identity.e2eePrivateKey))
    assertFalse(encoded.containsSubsequence(state.session!!.backgroundBearer))
    assertFalse(encoded.containsSubsequence(state.trips[tripId]!!.key))
    val decoded = AndroidScopedDatabaseCodec.decode(encoded, cipher)
    val decodedIdentity = decoded.identities[accountHash]!!
    assertEquals(installationId, decodedIdentity.installationId)
    assertArrayEquals(identity.authenticationPublicKey, decodedIdentity.authenticationPublicKey)
    assertArrayEquals(identity.e2eePublicKey, decodedIdentity.e2eePublicKey)
    assertArrayEquals(identity.e2eePrivateKey, decodedIdentity.e2eePrivateKey)
    assertEquals("pending_install_123", decoded.pendingIdentities["b".repeat(64)])
    assertEquals(scope, decoded.selectedScope)
    val decodedState = decoded.scopes[androidScopeKey(scope)]!!
    assertEquals(state.session?.deviceId, decodedState.session?.deviceId)
    assertArrayEquals(state.session?.backgroundBearer, decodedState.session?.backgroundBearer)
    assertEquals(state.trips[tripId], decodedState.trips[tripId])
    assertEquals(state.tombstones, decodedState.tombstones)
    assertEquals(state.activeMetadata, decodedState.activeMetadata)
    assertEquals(state.frozenMetadata, decodedState.frozenMetadata)

    val corrupt = encoded.copyOf().also { it[0] = (it[0].toInt() xor 0xff).toByte() }
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      AndroidScopedDatabaseCodec.decode(corrupt, cipher)
    }.code)
    assertThrows(NativeKeyException::class.java) {
      AndroidScopedDatabaseCodec.decode(encoded.copyOf(encoded.size - 1), cipher)
    }

    val legacy = legacyIdentityDatabase(accountHash, identity)
    val migrated = AndroidScopedDatabaseCodec.decode(legacy, cipher)
    assertArrayEquals(identity.e2eePrivateKey, migrated.identities[accountHash]?.e2eePrivateKey)
    val migratedEncoding = AndroidScopedDatabaseCodec.encode(migrated, cipher)
    assertFalse(migratedEncoding.containsSubsequence(identity.e2eePrivateKey))
  }

  @Test fun `each secret uses a fresh nonce and canonical scope type id version aad`() {
    val scope = NativeKeyScope("a".repeat(64), "install_A-123456")
    val otherScope = NativeKeyScope("b".repeat(64), "install_B-123456")
    val secret = ByteArray(32) { 0x41 }
    val aad = androidScopedSecretAad(
      scope,
      AndroidScopedSecretType.TRIP_KEY,
      "018f0d98-76fa-7d1a-b4b4-1f742c2e3130",
      1,
    )
    val cipher = cipher()
    val first = cipher.seal(secret, aad)
    val second = cipher.seal(secret, aad)
    assertFalse(first.contentEquals(second), "AES-GCM nonce must be fresh for every record write")
    assertArrayEquals(secret, cipher.open(first, aad))

    listOf(
      androidScopedSecretAad(otherScope, AndroidScopedSecretType.TRIP_KEY, "018f0d98-76fa-7d1a-b4b4-1f742c2e3130", 1),
      androidScopedSecretAad(scope, AndroidScopedSecretType.SESSION_BEARER, "018f0d98-76fa-7d1a-b4b4-1f742c2e3130", 1),
      androidScopedSecretAad(scope, AndroidScopedSecretType.TRIP_KEY, "018f0d98-76fa-7d1a-b4b4-1f742c2e3140", 1),
      androidScopedSecretAad(scope, AndroidScopedSecretType.TRIP_KEY, "018f0d98-76fa-7d1a-b4b4-1f742c2e3130", 2),
    ).forEach { wrongAad ->
      assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
        cipher.open(first, wrongAad)
      }.code)
    }
  }

  @Test fun `session replacement wipes the prior bearer before installing a copy`() {
    val priorBearer = "crb_prior_write_only".toByteArray()
    val replacementBearer = "crb_replacement_write_only".toByteArray()
    val state = AndroidScopedState(
      NativeKeyScope("a".repeat(64), "install_A-123456"),
      DeviceSessionRecord(
        "018f0d98-76fa-7d1a-b4b4-1f742c2e3150",
        priorBearer,
        Instant.ofEpochSecond(100),
        "https://api.crewroll.app",
      ),
    )

    state.secureReplaceSession(
      DeviceSessionRecord(
        "018f0d98-76fa-7d1a-b4b4-1f742c2e3160",
        replacementBearer,
        Instant.ofEpochSecond(200),
        "https://api.crewroll.app",
      ),
    )

    assertTrue(priorBearer.all { it == 0.toByte() })
    assertNotSame(replacementBearer, state.session!!.backgroundBearer)
    assertArrayEquals(replacementBearer, state.session!!.backgroundBearer)
  }
}

private fun ByteArray.containsSubsequence(candidate: ByteArray): Boolean =
  candidate.isNotEmpty() && indices.any { start ->
    start + candidate.size <= size && copyOfRange(start, start + candidate.size).contentEquals(candidate)
  }

private fun legacyIdentityDatabase(
  accountHash: String,
  identity: DeviceIdentityMaterial,
): ByteArray = ByteArrayOutputStream().use { buffer ->
  DataOutputStream(buffer).use { output ->
    fun text(value: String) {
      val bytes = value.toByteArray(Charsets.UTF_8)
      output.writeInt(bytes.size)
      output.write(bytes)
    }
    output.writeInt(0x43524b32)
    output.writeInt(1)
    output.writeInt(1)
    text(accountHash)
    text(identity.installationId)
    output.write(identity.authenticationPublicKey)
    output.write(identity.e2eePublicKey)
    output.write(identity.e2eePrivateKey)
    output.writeInt(0)
    output.writeBoolean(false)
  }
  buffer.toByteArray()
}
