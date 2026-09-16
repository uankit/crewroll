package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class AccountScopedLifecycleTest {
  private val accountA = "user_A-1"
  private val accountB = "user_B-2"
  private val hashA = "a".repeat(64)
  private val hashB = "b".repeat(64)
  private val tripA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
  private val tripB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
  private val deviceA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
  private val deviceB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160"

  @Test fun `restart restores only valid credentials for the same account installation and server`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountB, scope.installationId, "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountA, "another_installation", "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://other.crewroll.app"))
    fixture.clock.now = Instant.ofEpochSecond(600)
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    fixture.clock.now = Instant.ofEpochSecond(100)
    restarted.clearDeviceSession()
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
  }

  @Test fun `restore fails closed if persisted private keys are damaged`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.store.corruptPrivateKey(scope)
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app")
    }
  }

  @Test fun `identity is account scoped and rejects orphaned or mismatched material`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
    val identityA = fixture.subject.ensureDeviceIdentity(accountA)
    assertEquals(identityA, fixture.subject.ensureDeviceIdentity(accountA))
    val identityB = fixture.subject.ensureDeviceIdentity(accountB)
    assertNotEquals(identityA.installationId, identityB.installationId)
    assertNotEquals(identityA.authenticationPublicKey, identityB.authenticationPublicKey)
    assertNotEquals(identityA.e2eePublicKey, identityB.e2eePublicKey)
    assertTrue(fixture.store.persistedAliases.none { it.contains(accountA) || it.contains(accountB) })

    val scopeA = fixture.store.scope(hashA)
    fixture.store.corruptPrivateKey(scopeA)
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      fixture.subject.ensureDeviceIdentity(accountA)
    }.code)

    val missingP256 = ScopedFixture(mapOf(accountA to hashA))
    missingP256.subject.ensureDeviceIdentity(accountA)
    val missingScope = missingP256.store.scope(hashA)
    missingP256.p256.remove(missingScope)
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      missingP256.subject.ensureDeviceIdentity(accountA)
    }.code)

    val mismatchedP256 = ScopedFixture(mapOf(accountA to hashA))
    mismatchedP256.subject.ensureDeviceIdentity(accountA)
    val mismatchedScope = mismatchedP256.store.scope(hashA)
    mismatchedP256.p256.replace(
      mismatchedScope,
      byteArrayOf(4) + ByteArray(64) { 0x7f },
    )
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      mismatchedP256.subject.ensureDeviceIdentity(accountA)
    }.code)

    val orphan = ScopedFixture(mapOf(accountA to hashA))
    orphan.store.addTombstone(hashA, "orphan_install", tripA)
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      orphan.subject.ensureDeviceIdentity(accountA)
    }.code)
  }

  @Test fun `p256 aliases contain only account hash and installation scope`() {
    val scope = NativeKeyScope(hashA, "install_01J6D4M4KB8J8G3AZXJ3PZV1Z9")
    assertEquals(
      "crewroll.p256.v2.$hashA.install_01J6D4M4KB8J8G3AZXJ3PZV1Z9",
      androidP256Alias(scope),
    )
    assertFalse(androidP256Alias(scope).contains(accountA))
  }

  @Test fun `interrupted identity provisioning resumes the exact pending p256 alias`() {
    listOf("reservation", "p256", "x25519", "finalize").forEach { failure ->
      val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
      when (failure) {
        "reservation" -> fixture.store.failNextReservationCommit = true
        "p256" -> fixture.p256.failAfterCreateOnce = true
        "x25519" -> fixture.crypto.failNextPair = true
        "finalize" -> fixture.store.failNextFinalizeCommit = true
      }

      assertThrows(NativeKeyException::class.java) { fixture.subject.ensureDeviceIdentity(accountA) }
      val reservedAfterFailure = fixture.store.pendingScope(hashA)
      if (failure == "reservation") {
        assertNull(reservedAfterFailure)
        assertTrue(fixture.p256.scopes.isEmpty())
      } else {
        assertNotNull(reservedAfterFailure)
      }

      val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
      val recovered = restarted.ensureDeviceIdentity(accountA)
      val recoveredScope = NativeKeyScope(hashA, recovered.installationId)
      reservedAfterFailure?.let { assertEquals(it, recoveredScope, failure) }
      assertNull(fixture.store.pendingScope(hashA))
      assertEquals(1, fixture.p256.scopes.count { it == recoveredScope })
      assertEquals(1, fixture.p256.scopes.toSet().size)

      val other = restarted.ensureDeviceIdentity(accountB)
      val otherScope = NativeKeyScope(hashB, other.installationId)
      assertNotEquals(recoveredScope, otherScope)
      assertFalse(fixture.p256.scopes.any {
        it.accountHash == hashB && it.installationId == recoveredScope.installationId
      })
    }
  }

  @Test fun `sign out erases session and preserves identity and trip keys`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.subject.createTripKey(tripA, 1)
    val before = fixture.subject.ensureDeviceIdentity(accountA)
    fixture.subject.clearDeviceSession()
    fixture.subject.clearDeviceSession()
    assertNull(fixture.store.activeSession())
    assertNull(fixture.store.session(scope))
    assertNotNull(fixture.store.trip(scope, tripA))
    assertEquals(before, fixture.subject.ensureDeviceIdentity(accountA))
    fixture.ensureAndInstall(accountA, deviceA)
    assertEquals(scope, fixture.store.activeSession()?.scope)
  }

  @Test fun `installed session is sole scope and switch quarantines prior keys`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
    val scopeA = fixture.ensureAndInstall(accountA, deviceA)
    fixture.subject.createTripKey(tripA, 1)
    assertTrue(fixture.store.lastCreatedTransientKey!!.all { it == 0.toByte() })
    val wrappedForA = fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scopeA), 1)
    val scopeB = fixture.ensureAndInstall(accountB, deviceB)

    assertEquals(scopeB, fixture.store.activeSession()?.scope)
    assertNull(fixture.store.session(scopeA))
    assertNotNull(fixture.store.trip(scopeA, tripA))
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      fixture.subject.wrapTripKey(tripA, 1, deviceB, fixture.identityPublicKey(scopeB), 1)
    }.code)
    assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
      fixture.subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrappedForA.wrappedKey)
    }.code)
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      fixture.subject.activateTrip(fixture.metadata(tripA))
    }.code)
  }

  @Test fun `gc tombstones expired key and cannot delete concurrent promotion`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB), Instant.ofEpochSecond(100))
    val scopeA = fixture.ensureAndInstall(accountA, deviceA)
    fixture.subject.createTripKey(tripA, 1)
    fixture.clock.now = Instant.ofEpochSecond(86_500)
    fixture.subject.ensureDeviceIdentity(accountB)
    assertNull(fixture.store.trip(scopeA, tripA))
    assertTrue(fixture.store.hasTombstone(scopeA, tripA))
    fixture.ensureAndInstall(accountA, deviceA)
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      fixture.subject.createTripKey(tripA, 1)
    }.code)

    fixture.clock.now = Instant.ofEpochSecond(200)
    fixture.subject.createTripKey(tripB, 1)
    fixture.clock.now = Instant.ofEpochSecond(86_600)
    fixture.store.promoteDuringNextGc = scopeA to tripB
    fixture.subject.ensureDeviceIdentity(accountA)
    assertEquals(KeyState.INSTALLED, fixture.store.trip(scopeA, tripB)?.state)
    assertFalse(fixture.store.hasTombstone(scopeA, tripB))
  }

  @Test fun `scheduled cleanup handles relaunch idempotency and access locked retry`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA), Instant.ofEpochSecond(100))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.subject.createTripKey(tripA, 1)
    fixture.clock.now = Instant.ofEpochSecond(86_501)
    val relaunched = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)

    relaunched.runScheduledCleanup()
    assertNull(fixture.store.trip(scope, tripA))
    assertTrue(fixture.store.hasTombstone(scope, tripA))
    val commits = fixture.store.gcCommitCount
    relaunched.runScheduledCleanup()
    assertEquals(commits + 1, fixture.store.gcCommitCount)
    assertTrue(fixture.store.hasTombstone(scope, tripA))

    fixture.clock.now = Instant.ofEpochSecond(200)
    relaunched.createTripKey(tripB, 1)
    fixture.clock.now = Instant.ofEpochSecond(86_601)
    fixture.store.failNextGcWithAccessLocked = true
    assertEquals("KEY_ACCESS_LOCKED", assertThrows(NativeKeyException::class.java) {
      relaunched.runScheduledCleanup()
    }.code)
    assertNotNull(fixture.store.trip(scope, tripB))
    assertFalse(fixture.store.hasTombstone(scope, tripB))
    relaunched.runScheduledCleanup()
    assertNull(fixture.store.trip(scope, tripB))
    assertTrue(fixture.store.hasTombstone(scope, tripB))
  }

  @Test fun `internal scheduler cleans at expiry retries on wake and cancels without duplicates`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA), Instant.ofEpochSecond(100))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    val scheduler = ScopedCleanupScheduler()
    val scheduled = NativeKeyLifecycle(
      fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher, scheduler,
    )

    scheduled.createTripKey(tripA, 1)
    assertEquals(Instant.ofEpochSecond(86_500), scheduler.scheduledAt)
    fixture.clock.now = Instant.ofEpochSecond(86_501)
    scheduler.fire()
    assertNull(fixture.store.trip(scope, tripA))
    assertTrue(fixture.store.hasTombstone(scope, tripA))

    fixture.clock.now = Instant.ofEpochSecond(86_502)
    scheduled.createTripKey(tripB, 1)
    assertEquals(Instant.ofEpochSecond(172_902), scheduler.scheduledAt)
    fixture.clock.now = Instant.ofEpochSecond(172_903)
    fixture.store.failNextGcWithAccessLocked = true
    scheduler.fire()
    assertNotNull(fixture.store.trip(scope, tripB))
    assertNull(scheduler.scheduledAt, "access lock must wait for a wake, not busy-loop")
    scheduled.runScheduledCleanup()
    assertNull(fixture.store.trip(scope, tripB))
    assertTrue(fixture.store.hasTombstone(scope, tripB))

    val tripC = "018f0d98-76fa-7d1a-b4b4-1f742c2e3190"
    fixture.clock.now = Instant.ofEpochSecond(172_904)
    scheduled.createTripKey(tripC, 1)
    scheduled.runScheduledCleanup()
    scheduled.runScheduledCleanup()
    assertEquals(1, scheduler.maxPendingCount)
    scheduled.cancelScheduledCleanup()
    assertTrue(scheduler.isClosed)
    fixture.clock.now = Instant.ofEpochSecond(259_305)
    scheduler.fire()
    assertNotNull(fixture.store.trip(scope, tripC))
    assertFalse(fixture.store.hasTombstone(scope, tripC))
  }

  @Test fun `scheduled cleanup serializes concurrent foreground and timer wake`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    fixture.ensureAndInstall(accountA, deviceA)
    val scheduler = ScopedCleanupScheduler()
    val scheduled = NativeKeyLifecycle(
      fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher, scheduler,
    )
    scheduled.createTripKey(tripA, 1)
    val firstEntered = CountDownLatch(1)
    val secondEntered = CountDownLatch(1)
    val release = CountDownLatch(1)
    fixture.store.gcFirstEntered = firstEntered
    fixture.store.gcSecondEntered = secondEntered
    fixture.store.gcRelease = release

    val first = thread { scheduler.fire() }
    assertTrue(firstEntered.await(1, TimeUnit.SECONDS))
    val second = thread { scheduled.runScheduledCleanup() }
    assertFalse(secondEntered.await(100, TimeUnit.MILLISECONDS))
    release.countDown()
    first.join(1_000)
    second.join(1_000)
    assertFalse(first.isAlive)
    assertFalse(second.isAlive)
    assertEquals(1, fixture.store.maxConcurrentGc)
  }

  @Test fun `activation is exclusive immutable replay safe stale safe and rolls back`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    assertTrue(fixture.crypto.zeroizedSizes.contains("crb_fixture_write_only".toByteArray().size))
    fixture.store.putTrip(scope, tripA, TripKeyRecord(ByteArray(32) { 0x41 }, KeyState.INSTALLED))
    fixture.store.putTrip(scope, tripB, TripKeyRecord(ByteArray(32) { 0x42 }, KeyState.INSTALLED))
    val first = fixture.metadata(tripA)
    val second = fixture.metadata(tripB)

    fixture.subject.activateTrip(first)
    fixture.subject.activateTrip(first)
    assertEquals(first, fixture.store.activeMetadata(scope))
    fixture.subject.activateTrip(second)
    assertEquals(KeyState.INSTALLED, fixture.store.trip(scope, tripA)?.state)
    assertEquals(KeyState.ACTIVE, fixture.store.trip(scope, tripB)?.state)
    fixture.subject.deactivateTrip(tripA)
    assertEquals(second, fixture.store.activeMetadata(scope))

    val changed = second.copy(membershipId = "018f0d98-76fa-7d1a-b4b4-1f742c2e3199")
    assertThrows(NativeKeyException::class.java) { fixture.subject.activateTrip(changed) }
    assertEquals(second, fixture.store.activeMetadata(scope))

    fixture.subject.deactivateTrip(tripB)
    fixture.subject.activateTrip(first)
    fixture.store.failNextCommit = true
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      fixture.subject.activateTrip(second)
    }.code)
    assertEquals(first, fixture.store.activeMetadata(scope))
    assertEquals(KeyState.ACTIVE, fixture.store.trip(scope, tripA)?.state)
    assertEquals(KeyState.INSTALLED, fixture.store.trip(scope, tripB)?.state)
  }

  @Test fun `activation decoder rejects malformed values without freezing corrected replay`() {
    val base: Map<String, Any?> = mapOf(
      "protocolVersion" to 1,
      "tripId" to tripA,
      "membershipId" to "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
      "startsAt" to "2026-08-29T12:00:00Z",
      "endsAt" to "2026-09-02T12:00:00.123+05:30",
      "releaseAt" to null,
      "keyEpoch" to 1,
    )
    assertDoesNotThrow { NativeCommandDecoder.require(base, NativeCommandKind.ACTIVATE_TRIP) }
    assertDoesNotThrow { NativeCommandDecoder.activation(base) }
    listOf(
      base + ("protocolVersion" to 1.9),
      base + ("protocolVersion" to 4_294_967_297L),
      base + ("tripId" to "not-a-uuid"),
      base + ("membershipId" to "018f0d98-invalid"),
      base + ("startsAt" to "2026-08-29 12:00:00"),
      base + ("endsAt" to "2026-02-30T12:00:00Z"),
      base + ("releaseAt" to 123),
      base + ("releaseAt" to "tomorrow"),
      base + ("keyEpoch" to 1.9),
      base + ("envelope" to "forbidden"),
      base + ("wrappedKey" to "forbidden"),
    ).forEach { command ->
      assertEquals("ERR_CREWROLL_NATIVE_PROTOCOL", assertThrows(NativeKeyException::class.java) {
        NativeCommandDecoder.require(command, NativeCommandKind.ACTIVATE_TRIP)
        NativeCommandDecoder.activation(command)
      }.code)
    }

    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.store.putTrip(scope, tripA, TripKeyRecord(ByteArray(32) { 0x41 }, KeyState.INSTALLED))
    listOf("envelope", "wrappedKey").forEach { extra ->
      assertThrows(NativeKeyException::class.java) {
        NativeCommandDecoder.require(
          base + (extra to "forbidden"),
          NativeCommandKind.ACTIVATE_TRIP,
        )
      }
      assertNull(fixture.store.activeMetadata(scope))
    }
    fixture.subject.activateTrip(NativeCommandDecoder.activation(base))
    assertEquals(NativeCommandDecoder.activation(base), fixture.store.activeMetadata(scope))
    val malformed = fixture.metadata(tripA).copy(membershipId = "not-a-uuid")
    assertEquals("ERR_CREWROLL_NATIVE_PROTOCOL", assertThrows(NativeKeyException::class.java) {
      fixture.subject.activateTrip(malformed)
    }.code)
    assertEquals(NativeCommandDecoder.activation(base), fixture.store.activeMetadata(scope))
    assertDoesNotThrow {
      fixture.subject.activateTrip(NativeCommandDecoder.activation(base))
    }
    assertEquals(NativeCommandDecoder.activation(base), fixture.store.activeMetadata(scope))
  }

  @Test fun `all native commands have closed key sets and trip ids are lowercase uuidv7`() {
    val v4DeviceId = "550e8400-e29b-41d4-a716-446655440000"
    val commands = listOf(
      Triple(
        NativeCommandKind.ENSURE_DEVICE_IDENTITY,
        mapOf("protocolVersion" to 1, "accountId" to accountA),
        "accountId",
      ),
      Triple(NativeCommandKind.INSTALL_DEVICE_SESSION, mapOf(
        "protocolVersion" to 1,
        "accountId" to accountA,
        "installationId" to "install_A-123456",
        "deviceId" to v4DeviceId,
        "backgroundBearer" to "crb_fixture_write_only",
        "backgroundBearerExpiresAt" to "2026-09-01T12:00:00Z",
        "apiBaseUrl" to "https://api.crewroll.app",
      ), "deviceId"),
      Triple(
        NativeCommandKind.CREATE_TRIP_KEY,
        mapOf("protocolVersion" to 1, "tripId" to tripA, "keyEpoch" to 1),
        "tripId",
      ),
      Triple(
        NativeCommandKind.DISCARD_PROVISIONAL_TRIP_KEY,
        mapOf("protocolVersion" to 1, "tripId" to tripA, "keyEpoch" to 1),
        "keyEpoch",
      ),
      Triple(NativeCommandKind.WRAP_TRIP_KEY, mapOf(
        "protocolVersion" to 1,
        "tripId" to tripA,
        "keyEpoch" to 1,
        "recipientDeviceId" to deviceA,
        "recipientE2eePublicKey" to "fixture",
        "recipientE2eeKeyVersion" to 1,
      ), "recipientE2eePublicKey"),
      Triple(NativeCommandKind.IMPORT_TRIP_KEY, mapOf(
        "protocolVersion" to 1,
        "tripId" to tripA,
        "keyEpoch" to 1,
        "algorithmVersion" to 1,
        "expectedSenderDeviceId" to deviceA,
        "recipientDeviceId" to deviceA,
        "recipientE2eeKeyVersion" to 1,
        "wrappedKey" to "fixture",
      ), "wrappedKey"),
      Triple(NativeCommandKind.ACTIVATE_TRIP, mapOf(
        "protocolVersion" to 1,
        "tripId" to tripA,
        "membershipId" to "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
        "startsAt" to "2026-08-29T12:00:00Z",
        "endsAt" to "2026-09-02T12:00:00Z",
        "releaseAt" to null,
        "keyEpoch" to 1,
      ), "releaseAt"),
      Triple(
        NativeCommandKind.DEACTIVATE_TRIP,
        mapOf("protocolVersion" to 1, "tripId" to tripA),
        "tripId",
      ),
    )
    commands.forEach { (kind, command, missingKey) ->
      assertDoesNotThrow { NativeCommandDecoder.require(command, kind) }
      assertThrows(NativeKeyException::class.java) {
        NativeCommandDecoder.require(command + ("unexpected" to true), kind)
      }
      assertThrows(NativeKeyException::class.java) {
        NativeCommandDecoder.require(command - missingKey, kind)
      }
    }

    listOf(
      tripA.uppercase(),
      "550e8400-e29b-41d4-a716-446655440000",
      "1ee7c0a0-1234-6abc-8def-1234567890ab",
      "018f0d98-76fa-8d1a-b4b4-1f742c2e3130",
      "018f0d98-76fa-7d1a-74b4-1f742c2e3130",
    ).forEach { invalidTripId ->
      val error = assertThrows(NativeKeyException::class.java) {
        NativeCommandDecoder.require(
          mapOf("protocolVersion" to 1, "tripId" to invalidTripId, "keyEpoch" to 1),
          NativeCommandKind.CREATE_TRIP_KEY,
        )
      }
      assertEquals("ERR_CREWROLL_NATIVE_PROTOCOL", error.code)
    }
  }

  @Test fun `secret buffers are zeroed on successful and failed envelope work`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.store.putTrip(scope, tripA, TripKeyRecord(ByteArray(32) { 0x41 }, KeyState.INSTALLED))
    val wrapped = fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1)
    assertTrue(fixture.crypto.zeroizedSizes.contains(32))
    assertTrue(fixture.crypto.zeroizedSizes.contains(100))
    fixture.crypto.rejectOpen = true
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.importTripKey(tripB, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey)
    }
    assertTrue(fixture.crypto.zeroizedSizes.contains(148))
    assertTrue(fixture.crypto.zeroizedSizes.count { it == 32 } >= 2)
  }

  @Test fun `original and loaded secret owners are zeroed after use`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    assertTrue(fixture.crypto.returnedRandomBuffers.first().all { it == 0.toByte() })
    assertTrue(fixture.crypto.returnedPairPrivate!!.all { it == 0.toByte() })
    assertTrue(fixture.store.lastLoadedPrivate!!.all { it == 0.toByte() })
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.installDeviceSession(
        accountA,
        "wrong_install_123",
        deviceA,
        "crb_fixture_write_only",
        Instant.ofEpochSecond(900),
        "https://api.crewroll.app",
      )
    }
    assertTrue(fixture.store.lastLoadedPrivate!!.all { it == 0.toByte() })

    fixture.store.putTrip(scope, tripB, TripKeyRecord(ByteArray(32) { 0x7e }, KeyState.RETAINED))
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.wrapTripKey(tripB, 1, deviceA, fixture.identityPublicKey(scope), 1)
    }
    assertTrue(fixture.store.lastLoadedTripKey!!.all { it == 0.toByte() })

    fixture.subject.createTripKey(tripA, 1)
    val wrapped = fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1)
    assertTrue(fixture.crypto.returnedRandomBuffers.last().all { it == 0.toByte() })
    assertTrue(fixture.store.lastLoadedBearer!!.all { it == 0.toByte() })
    assertTrue(fixture.store.lastLoadedTripKey!!.all { it == 0.toByte() })
    fixture.subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey)
    assertTrue(fixture.crypto.returnedOpenPlaintext!!.all { it == 0.toByte() })
    assertTrue(fixture.store.lastLoadedPrivate!!.all { it == 0.toByte() })

    fixture.store.corruptSelectedInstallationId("corrupt_install_123")
    assertThrows(NativeKeyException::class.java) { fixture.subject.createTripKey(tripB, 1) }
    assertTrue(fixture.store.lastLoadedPrivate!!.all { it == 0.toByte() })
  }

  @Test fun `provisional lifecycle and envelope context stay strict across restart`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    val randomBeforeCreate = fixture.crypto.randomCounter
    fixture.subject.createTripKey(tripA, 1)
    val first = fixture.store.trip(scope, tripA)!!
    val randomAfterCreate = fixture.crypto.randomCounter
    fixture.subject.createTripKey(tripA, 1)
    assertEquals(randomAfterCreate, fixture.crypto.randomCounter)
    assertEquals(first, fixture.store.trip(scope, tripA))
    assertEquals(randomBeforeCreate + 1, randomAfterCreate)
    assertEquals(KeyState.PROVISIONAL, first.state)
    assertEquals(86_400, first.provisionalExpiresAt!!.epochSecond - first.createdAt!!.epochSecond)

    val wrapped = fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1)
    assertEquals(1, wrapped.protocolVersion)
    assertEquals(tripA, wrapped.tripId)
    assertEquals(1, wrapped.keyEpoch)
    assertEquals(1, wrapped.algorithmVersion)
    assertEquals(deviceA, wrapped.senderDeviceId)
    assertEquals(deviceA, wrapped.recipientDeviceId)
    assertEquals(1, wrapped.recipientE2eeKeyVersion)
    assertEquals(148, java.util.Base64.getDecoder().decode(wrapped.wrappedKey).size)

    listOf(
      arrayOf(tripB, deviceA, deviceA, wrapped.wrappedKey),
      arrayOf(tripA, deviceB, deviceA, wrapped.wrappedKey),
      arrayOf(tripA, deviceA, deviceB, wrapped.wrappedKey),
      arrayOf(tripA, deviceA, deviceA, wrapped.wrappedKey + "="),
    ).forEach { mutation ->
      assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
        fixture.subject.importTripKey(mutation[0], 1, 1, mutation[1], mutation[2], 1, mutation[3])
      }.code)
    }

    val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
    restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey)
    assertEquals(KeyState.INSTALLED, fixture.store.trip(scope, tripA)?.state)
    assertThrows(NativeKeyException::class.java) { restarted.discardProvisionalTripKey(tripA, 1) }
    assertDoesNotThrow { restarted.discardProvisionalTripKey(tripB, 1) }

    fixture.store.putTrip(scope, tripA, TripKeyRecord(ByteArray(32) { 0x7a }, KeyState.INSTALLED))
    assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
      restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey)
    }.code)
    assertArrayEquals(ByteArray(32) { 0x7a }, fixture.store.trip(scope, tripA)?.key)

    restarted.createTripKey(tripB, 1)
    restarted.discardProvisionalTripKey(tripB, 1)
    assertNull(fixture.store.trip(scope, tripB))
    assertTrue(fixture.store.hasTombstone(scope, tripB))
  }
}

private class ScopedFixture(
  hashes: Map<String, String>,
  initial: Instant = Instant.ofEpochSecond(100),
) {
  val clock = ScopedClock(initial)
  val store = ScopedStore()
  val crypto = ScopedCrypto()
  val p256 = ScopedP256()
  val hasher = AccountNamespaceHasher { accountId -> hashes[accountId] ?: throw NativeKeyException.invalidCommand() }
  val subject = NativeKeyLifecycle(clock, store, crypto, p256, hasher)

  fun ensureAndInstall(accountId: String, deviceId: String): NativeKeyScope {
    val identity = subject.ensureDeviceIdentity(accountId)
    subject.installDeviceSession(
      accountId,
      identity.installationId,
      deviceId,
      "crb_fixture_write_only",
      Instant.ofEpochSecond(900),
      "https://api.crewroll.app",
    )
    return store.activeSession()!!.scope
  }
  fun identityPublicKey(scope: NativeKeyScope) = CanonicalBase64.encode(store.identity(scope.accountHash)!!.e2eePublicKey)
  fun metadata(tripId: String) = ActiveTripMetadata(
    tripId,
    "018f0d98-76fa-7d1a-b4b4-1f742c2e3180",
    "2026-08-29T12:00:00Z",
    "2026-09-02T12:00:00.123Z",
    null,
    1,
  )
}

private class ScopedP256 : P256IdentityProvider {
  private val keys = mutableMapOf<NativeKeyScope, ByteArray>()
  var failAfterCreateOnce = false
  val scopes = mutableListOf<NativeKeyScope>()
  override fun createPublicKey(scope: NativeKeyScope): ByteArray {
    if (keys.containsKey(scope)) throw NativeKeyException.materialLost()
    val key = byteArrayOf(4) + ByteArray(64) {
      if (scope.accountHash.startsWith("a")) 0x31 else 0x32
    }
    keys[scope] = key
    scopes += scope
    if (failAfterCreateOnce) {
      failAfterCreateOnce = false
      throw NativeKeyException.materialLost()
    }
    return key.copyOf()
  }
  override fun loadPublicKey(scope: NativeKeyScope): ByteArray? = keys[scope]?.copyOf()
  fun remove(scope: NativeKeyScope) { keys.remove(scope)?.fill(0) }
  fun replace(scope: NativeKeyScope, key: ByteArray) { keys[scope] = key.copyOf() }
}

private class ScopedClock(var now: Instant) : NativeKeyClock { override fun now() = now }

private class ScopedCleanupScheduler : NativeKeyCleanupScheduling {
  var scheduledAt: Instant? = null
    private set
  var maxPendingCount = 0
    private set
  var isClosed = false
    private set
  private var action: (() -> Unit)? = null

  override fun schedule(at: Instant, action: () -> Unit) {
    if (isClosed) return
    scheduledAt = at
    this.action = action
    maxPendingCount = maxOf(maxPendingCount, 1)
  }

  override fun cancel() {
    scheduledAt = null
    action = null
  }

  override fun close() {
    isClosed = true
    cancel()
  }

  fun fire() {
    val pending = action
    scheduledAt = null
    action = null
    pending?.invoke()
  }
}

private class ScopedCrypto : NativeKeyCrypto {
  var pairCounter = 0
  var randomCounter = 0
  var rejectOpen = false
  var failNextPair = false
  val zeroizedSizes = mutableListOf<Int>()
  val returnedRandomBuffers = mutableListOf<ByteArray>()
  var returnedPairPrivate: ByteArray? = null
  var returnedOpenPlaintext: ByteArray? = null
  override fun randomBytes(count: Int): ByteArray {
    randomCounter++
    return ByteArray(count) { randomCounter.toByte() }.also(returnedRandomBuffers::add)
  }
  override fun makeX25519KeyPair(): X25519KeyPair {
    if (failNextPair) {
      failNextPair = false
      throw NativeKeyException.materialLost()
    }
    pairCounter++
    val privateKey = ByteArray(32) { (0x21 + pairCounter).toByte() }
    returnedPairPrivate = privateKey
    return X25519KeyPair(ByteArray(32) { (0x20 + pairCounter).toByte() }, privateKey)
  }
  override fun deriveX25519PublicKey(privateKey: ByteArray): ByteArray {
    if (privateKey.isEmpty() || !privateKey.all { it == privateKey[0] }) throw NativeKeyException.materialLost()
    return ByteArray(32) { (privateKey[0] - 1).toByte() }
  }
  override fun constantTimeEquals(lhs: ByteArray, rhs: ByteArray) = lhs.contentEquals(rhs)
  override fun zeroize(value: ByteArray) { zeroizedSizes += value.size; value.fill(0) }
  override fun seal(plaintext: ByteArray, recipientPublicKey: ByteArray) = recipientPublicKey + ByteArray(16) { 1 } + plaintext
  override fun open(ciphertext: ByteArray, publicKey: ByteArray, privateKey: ByteArray): ByteArray {
    if (rejectOpen || ciphertext.size != 148 || !ciphertext.copyOfRange(0, 32).contentEquals(publicKey)) throw NativeKeyException.invalidEnvelope()
    return ciphertext.copyOfRange(48, 148).also { returnedOpenPlaintext = it }
  }
}

private class ScopedStore : NativeKeyStore {
  data class ScopeState(
    var session: DeviceSessionRecord? = null,
    val trips: MutableMap<String, TripKeyRecord> = mutableMapOf(),
    val tombstones: MutableSet<String> = mutableSetOf(),
    var activeMetadata: ActiveTripMetadata? = null,
    val frozen: MutableMap<String, ActiveTripMetadata> = mutableMapOf(),
  )

  private var identities = mutableMapOf<String, DeviceIdentityMaterial>()
  private var pendingIdentities = mutableMapOf<String, String>()
  private var scopes = mutableMapOf<NativeKeyScope, ScopeState>()
  private var selectedScope: NativeKeyScope? = null
  val persistedAliases = mutableListOf<String>()
  var failNextCommit = false
  var failNextReservationCommit = false
  var failNextFinalizeCommit = false
  var failNextGcWithAccessLocked = false
  var gcCommitCount = 0
  var gcFirstEntered: CountDownLatch? = null
  var gcSecondEntered: CountDownLatch? = null
  var gcRelease: CountDownLatch? = null
  var maxConcurrentGc = 0
    private set
  private var concurrentGc = 0
  var lastLoadedPrivate: ByteArray? = null
  var lastLoadedBearer: ByteArray? = null
  var lastLoadedTripKey: ByteArray? = null
  var lastCreatedTransientKey: ByteArray? = null
  var promoteDuringNextGc: Pair<NativeKeyScope, String>? = null

  override fun loadIdentity(accountHash: String) = identities[accountHash]?.deepCopy()?.also {
    lastLoadedPrivate = it.e2eePrivateKey
  }
  override fun reservePendingIdentity(accountHash: String, makeInstallationId: () -> String): NativeKeyScope = transaction {
    pendingIdentities[accountHash]?.let { return@transaction NativeKeyScope(accountHash, it) }
    if (identities.containsKey(accountHash) || scopes.keys.any { it.accountHash == accountHash }) {
      throw NativeKeyException.materialLost()
    }
    val installationId = makeInstallationId()
    pendingIdentities[accountHash] = installationId
    if (failNextReservationCommit) {
      failNextReservationCommit = false
      throw NativeKeyException.materialLost()
    }
    NativeKeyScope(accountHash, installationId)
  }
  override fun finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial) = transaction {
    if (pendingIdentities[scope.accountHash] != scope.installationId ||
      value.installationId != scope.installationId || identities.containsKey(scope.accountHash)
    ) throw NativeKeyException.materialLost()
    identities[scope.accountHash] = value.deepCopy()
    scopes.getOrPut(scope, ::ScopeState)
    pendingIdentities.remove(scope.accountHash)
    persistedAliases += "identity.${scope.accountHash}.${scope.installationId}"
    if (failNextFinalizeCommit) {
      failNextFinalizeCommit = false
      throw NativeKeyException.materialLost()
    }
  }
  override fun hasScopedMaterial(accountHash: String) = scopes.any { (scope, state) ->
    scope.accountHash == accountHash &&
      (state.session != null || state.trips.isNotEmpty() || state.tombstones.isNotEmpty() || state.activeMetadata != null)
  }
  override fun activeSession(): ScopedDeviceSession? {
    val scope = selectedScope ?: return null
    return scopes[scope]?.session?.let {
      val session = it.copy(backgroundBearer = it.backgroundBearer.copyOf())
      lastLoadedBearer = session.backgroundBearer
      ScopedDeviceSession(scope, session)
    }
  }
  override fun clearSession() = transaction {
    selectedScope?.let { scope ->
      scopes[scope]?.let { state ->
        state.session?.backgroundBearer?.fill(0)
        state.session = null
        state.activeMetadata?.tripId?.let { id -> state.trips[id]?.let { state.trips[id] = it.copy(state = KeyState.INSTALLED) } }
        state.activeMetadata = null
      }
    }
    selectedScope = null
  }
  override fun installSession(scope: NativeKeyScope, value: DeviceSessionRecord) = transaction {
    selectedScope?.takeIf { it != scope }?.let { prior ->
      scopes[prior]?.activeMetadata?.tripId?.let { active ->
        scopes[prior]?.trips?.get(active)?.let { scopes[prior]?.trips?.set(active, it.copy(state = KeyState.INSTALLED)) }
      }
      scopes[prior]?.session = null
      scopes[prior]?.activeMetadata = null
    }
    scopes.getOrPut(scope, ::ScopeState).session = value.copy(backgroundBearer = value.backgroundBearer.copyOf())
    selectedScope = scope
    persistedAliases += "session.${scope.accountHash}.${scope.installationId}"
  }
  override fun createTrip(
    scope: NativeKeyScope,
    tripId: String,
    makeValue: () -> TripKeyRecord,
  ): TripCreateOutcome = transaction {
    if (scopes[scope]?.tombstones?.contains(tripId) == true) return@transaction TripCreateOutcome.TOMBSTONED
    if (scopes[scope]?.trips?.containsKey(tripId) == true) return@transaction TripCreateOutcome.EXISTING
    val value = makeValue()
    lastCreatedTransientKey = value.key
    try {
      scopes.getOrPut(scope, ::ScopeState).trips[tripId] = value.copy(key = value.key.copyOf())
    } finally { value.key.fill(0) }
    persistedAliases += "trip.${scope.accountHash}.${scope.installationId}.$tripId"
    TripCreateOutcome.CREATED
  }
  override fun loadTrip(scope: NativeKeyScope, tripId: String) = scopes[scope]?.trips?.get(tripId)?.let {
    it.copy(key = it.key.copyOf()).also { copy -> lastLoadedTripKey = copy.key }
  }
  override fun discardProvisional(scope: NativeKeyScope, tripId: String): ProvisionalDiscardOutcome = transaction {
    val record = scopes[scope]?.trips?.get(tripId) ?: return@transaction ProvisionalDiscardOutcome.ABSENT
    if (record.state != KeyState.PROVISIONAL) return@transaction ProvisionalDiscardOutcome.PROTECTED
    scopes[scope]?.trips?.remove(tripId)
    scopes[scope]?.tombstones?.add(tripId)
    ProvisionalDiscardOutcome.DISCARDED
  }
  override fun collectExpiredProvisional(now: Instant) = run {
    val ordinal = synchronized(this) {
      concurrentGc += 1
      maxConcurrentGc = maxOf(maxConcurrentGc, concurrentGc)
      concurrentGc
    }
    if (ordinal == 1) gcFirstEntered?.countDown() else gcSecondEntered?.countDown()
    gcRelease?.await()
    try {
      transaction {
        if (failNextGcWithAccessLocked) {
          failNextGcWithAccessLocked = false
          throw NativeKeyException.accessLocked()
        }
        promoteDuringNextGc?.let { (scope, tripId) ->
          scopes[scope]?.trips?.get(tripId)?.let {
            scopes[scope]?.trips?.set(tripId, it.copy(state = KeyState.INSTALLED))
          }
          promoteDuringNextGc = null
        }
        scopes.forEach { (_, state) ->
          state.trips.toMap().forEach { (tripId, record) ->
            if (record.state == KeyState.PROVISIONAL &&
              !(record.provisionalExpiresAt ?: Instant.MIN).isAfter(now) &&
              state.trips[tripId]?.state == KeyState.PROVISIONAL
            ) {
              state.trips.remove(tripId)
              state.tombstones.add(tripId)
            }
          }
        }
        gcCommitCount++
        scopes.values.asSequence()
          .flatMap { it.trips.values.asSequence() }
          .filter { it.state == KeyState.PROVISIONAL }
          .map {
            it.provisionalExpiresAt ?: throw NativeKeyException.materialLost()
          }
          .minOrNull()
      }
    } finally {
      synchronized(this) { concurrentGc -= 1 }
    }
  }
  override fun importTrip(scope: NativeKeyScope, tripId: String, key: ByteArray): TripImportOutcome = transaction {
    val state = scopes.getOrPut(scope, ::ScopeState)
    val existing = state.trips[tripId]
    if (existing != null) {
      if (!existing.key.contentEquals(key)) return@transaction TripImportOutcome.CONFLICT
      if (existing.state == KeyState.PROVISIONAL) state.trips[tripId] = existing.copy(state = KeyState.INSTALLED)
      state.tombstones.remove(tripId)
      return@transaction TripImportOutcome.EXISTING
    }
    state.trips[tripId] = TripKeyRecord(key.copyOf(), KeyState.INSTALLED)
    state.tombstones.remove(tripId)
    TripImportOutcome.INSTALLED
  }
  override fun activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) = transaction {
    val state = scopes[scope] ?: throw NativeKeyException.materialLost()
    val target = state.trips[metadata.tripId] ?: throw NativeKeyException.materialLost()
    if (target.state != KeyState.INSTALLED && target.state != KeyState.ACTIVE) throw NativeKeyException.materialLost()
    state.frozen[metadata.tripId]?.takeIf { it != metadata }?.let { throw NativeKeyException.invalidState() }
    state.activeMetadata?.tripId?.takeIf { it != metadata.tripId }?.let { prior ->
      state.trips[prior]?.let { state.trips[prior] = it.copy(state = KeyState.INSTALLED) }
    }
    state.trips[metadata.tripId] = target.copy(state = KeyState.ACTIVE)
    state.frozen[metadata.tripId] = metadata
    state.activeMetadata = metadata
  }
  override fun deactivate(scope: NativeKeyScope, tripId: String) = transaction {
    val state = scopes[scope] ?: return@transaction
    if (state.activeMetadata?.tripId != tripId) return@transaction
    state.trips[tripId]?.let { state.trips[tripId] = it.copy(state = KeyState.INSTALLED) }
    state.activeMetadata = null
  }

  fun identity(accountHash: String) = identities[accountHash]
  fun pendingScope(accountHash: String) = pendingIdentities[accountHash]?.let { NativeKeyScope(accountHash, it) }
  fun scope(accountHash: String): NativeKeyScope {
    val identity = identities[accountHash] ?: throw NativeKeyException.materialLost()
    return NativeKeyScope(accountHash, identity.installationId)
  }
  fun session(scope: NativeKeyScope) = scopes[scope]?.session
  fun trip(scope: NativeKeyScope, tripId: String) = scopes[scope]?.trips?.get(tripId)
  fun hasTombstone(scope: NativeKeyScope, tripId: String) = scopes[scope]?.tombstones?.contains(tripId) == true
  fun activeMetadata(scope: NativeKeyScope) = scopes[scope]?.activeMetadata
  fun putTrip(scope: NativeKeyScope, tripId: String, record: TripKeyRecord) { scopes.getOrPut(scope, ::ScopeState).trips[tripId] = record }
  fun addTombstone(accountHash: String, installationId: String, tripId: String) {
    scopes.getOrPut(NativeKeyScope(accountHash, installationId), ::ScopeState).tombstones.add(tripId)
  }
  fun corruptPrivateKey(scope: NativeKeyScope) {
    val identity = identities[scope.accountHash] ?: return
    identities[scope.accountHash] = identity.copy(e2eePrivateKey = ByteArray(32) { 0x7f })
  }
  fun corruptSelectedInstallationId(installationId: String) {
    val selected = selectedScope ?: return
    val state = scopes.remove(selected) ?: return
    val corrupted = NativeKeyScope(selected.accountHash, installationId)
    scopes[corrupted] = state
    selectedScope = corrupted
  }

  private fun <T> transaction(block: () -> T): T {
    val identitiesBefore = identities.toMutableMap()
    val pendingBefore = pendingIdentities.toMutableMap()
    val scopesBefore = scopes.mapValuesTo(mutableMapOf()) { (_, state) -> state.deepCopy() }
    val selectedBefore = selectedScope
    val aliasesBefore = persistedAliases.toList()
    return try {
      val result = block()
      if (failNextCommit) { failNextCommit = false; throw NativeKeyException.materialLost() }
      result
    } catch (error: Throwable) {
      identities = identitiesBefore
      pendingIdentities = pendingBefore
      scopes = scopesBefore
      selectedScope = selectedBefore
      persistedAliases.clear(); persistedAliases.addAll(aliasesBefore)
      throw error
    }
  }
  private fun ScopeState.deepCopy() = ScopeState(
    session,
    trips.mapValuesTo(mutableMapOf()) { (_, record) -> record.copy(key = record.key.copyOf()) },
    tombstones.toMutableSet(),
    activeMetadata,
    frozen.toMutableMap(),
  )
  private fun DeviceIdentityMaterial.deepCopy() = copy(
    authenticationPublicKey = authenticationPublicKey.copyOf(),
    e2eePublicKey = e2eePublicKey.copyOf(),
    e2eePrivateKey = e2eePrivateKey.copyOf(),
  )
}
