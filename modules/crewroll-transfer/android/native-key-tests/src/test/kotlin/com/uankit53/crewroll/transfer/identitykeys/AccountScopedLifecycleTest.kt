package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import com.uankit53.crewroll.crypto.VerifiedSodiumProvider
import com.uankit53.crewroll.transfer.media.*
import java.io.File
import java.nio.file.Files
import org.json.JSONObject

class AccountScopedLifecycleTest {
  private val accountA = "user_A-1"
  private val accountB = "user_B-2"
  private val hashA = "a".repeat(64)
  private val hashB = "b".repeat(64)
  private val tripA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
  private val tripB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
  private val deviceA = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
  private val deviceB = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160"

  @Test fun `composite cold startup includes the first engine wake in three reads or two without a trip`() {
    listOf(false, true).forEach { active ->
      val fixture = ScopedFixture(mapOf(accountA to hashA), Instant.parse("2030-01-01T00:00:00Z"))
      val metadata = fixture.metadata(tripA).copy(startsAt = "2030-01-01T00:00:00Z", endsAt = "2030-01-02T00:00:00Z")
      val disk = StartupCountingPersistence()
      val original = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256,
        fixture.hasher, ScopedCleanupScheduler())
      val identity = original.ensureDeviceIdentity(accountA)
      original.installDeviceSession(accountA, identity.installationId, deviceA, "crb_fixture_write_only",
        fixture.clock.now.plusSeconds(8 * 86_400), "https://api.crewroll.app")
      val command = if (active) {
        original.createTripKey(tripA, 1)
        val wrapped = original.wrapTripKey(tripA, 1, deviceA, identity.e2eePublicKey, 1).wrappedKey
        original.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, metadata.endsAt)
        original.activateTrip(metadata)
        startupComposite(wrapped, metadata)
      } else null
      val subject = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256,
        fixture.hasher, ScopedCleanupScheduler())
      val media = NativeMediaSession({ subject.mediaContext() }, { fixture.clock.now })
      val fence = NativeTransferCommandFence()
      disk.reads = 0; disk.writes = 0; disk.loaded.clear()
      repeat(2) { subject.runScheduledCleanup(); subject.expiredTrips(); subject.nextTripRetentionDeadline() }
      val bootstrapEpoch = fence.advance()
      val prepared = fence.runIfCurrent(bootstrapEpoch) {
        media.prepareDevice { subject.prepareDeviceSession(accountA, "https://api.crewroll.app") }
      }
      assertEquals(identity, prepared.identity)
      assertEquals(deviceA, prepared.restoredDeviceId)
      assertEquals(if (active) tripA else null, prepared.activeTripId)

      if (command != null) {
        val epoch = fence.advance()
        fence.runIfCurrent(epoch) { media.changeAndPrime({ subject.importAndActivateTrip(command) }, { it }) }
      }
      StartupEngineProbe(media, subject).use { probe ->
        probe.engine.activate().get(3, TimeUnit.SECONDS)
        assertTrue(probe.firstContext.await(3, TimeUnit.SECONDS), "exercise a real engine wake after priming")
        val snapshot = probe.engine.snapshot().get(3, TimeUnit.SECONDS)
        assertEquals(if (active) tripA else null, snapshot["activeTripId"])
        assertEquals(if (active) 3 else 2, disk.reads,
          "first engine wake and journal projection must reuse the validated lease")
        assertEquals(0, disk.writes)
      }
      disk.loaded.forEach(::assertDatabaseSecretsErased)
    }
  }


  @Test fun `album registration runs only after authenticated import and before trip activation without extra protected reads`() {
    val f = compositeCase(false)
    val expected = NativeKeyScope(hashA, f.identity.installationId)
    val events = mutableListOf<String>()
    f.disk.reads = 0
    val context = f.subject.importAndActivateTrip(f.command) { scope, metadata ->
      assertEquals(expected, scope)
      assertEquals(f.metadata, metadata)
      assertNotNull(f.store.loadTrip(scope, tripA)?.also { it.key.fill(0) })
      assertNull(f.store.activeSelection(), "album registration precedes selected trip exposure")
      events.add("album")
    }
    context.erase()
    assertEquals(listOf("album"), events)
    assertEquals(1, f.disk.reads)
    assertEquals(tripA, f.subject.mediaContext()!!.let { try { it.metadata.tripId } finally { it.erase() } })

    val invalid = compositeCase(false)
    var registered = false
    val envelope = NativeCommandDecoder.objectValue(invalid.command, "envelope") + ("wrappedKey" to "A".repeat(200))
    assertThrows(NativeKeyException::class.java) {
      invalid.subject.importAndActivateTrip(invalid.command + ("envelope" to envelope)) { _, _ -> registered = true }
    }
    assertFalse(registered)
    assertNull(invalid.store.activeSelection())
  }

  @Test fun `album command validates closed nested metadata and retains original crypto tuple validation`() {
    val f = compositeCase(false)
    val valid = f.command + ("album" to mapOf("tripName" to "🧡".repeat(80)))
    NativeCommandDecoder.require(valid, NativeCommandKind.IMPORT_AND_ACTIVATE_TRIP_WITH_ALBUM)
    for (album in listOf(mapOf("tripName" to "x", "path" to "DCIM/Camera"), mapOf("tripName" to "x".repeat(81)), mapOf("tripName" to "\uD800"))) {
      assertThrows(NativeKeyException::class.java) { NativeCommandDecoder.require(f.command + ("album" to album), NativeCommandKind.IMPORT_AND_ACTIVATE_TRIP_WITH_ALBUM) }
    }
    val mismatched = NativeCommandDecoder.objectValue(f.command, "activation") + ("tripId" to tripB)
    assertThrows(NativeKeyException::class.java) { NativeCommandDecoder.require(valid + ("activation" to mismatched), NativeCommandKind.IMPORT_AND_ACTIVATE_TRIP_WITH_ALBUM) }
    assertThrows(NativeKeyException::class.java) { NativeCommandDecoder.require(valid + ("extra" to true), NativeCommandKind.IMPORT_AND_ACTIVATE_TRIP_WITH_ALBUM) }
  }
  private fun startupComposite(wrapped: String, metadata: ActiveTripMetadata): Map<String, Any?> = mapOf(
    "protocolVersion" to 1,
    "envelope" to mapOf("protocolVersion" to 1, "tripId" to metadata.tripId, "keyEpoch" to metadata.keyEpoch,
      "algorithmVersion" to 1, "expectedSenderDeviceId" to deviceA, "recipientDeviceId" to deviceA,
      "recipientE2eeKeyVersion" to 1, "wrappedKey" to wrapped, "endsAt" to metadata.endsAt),
    "activation" to mapOf("protocolVersion" to 1, "tripId" to metadata.tripId, "membershipId" to metadata.membershipId,
      "startsAt" to metadata.startsAt, "endsAt" to metadata.endsAt, "releaseAt" to metadata.releaseAt, "keyEpoch" to metadata.keyEpoch))

  private data class CompositeCase(val fixture: ScopedFixture, val disk: StartupCountingPersistence,
    val store: AccountScopedKeyStore, val subject: NativeKeyLifecycle, val identity: NativeDeviceIdentity,
    val metadata: ActiveTripMetadata, val command: Map<String, Any?>)
  private fun compositeCase(activate: Boolean): CompositeCase {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB), Instant.parse("2030-01-01T00:00:00Z"))
    val disk = StartupCountingPersistence()
    val store = AccountScopedKeyStore(disk)
    val subject = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher, ScopedCleanupScheduler())
    val identity = subject.ensureDeviceIdentity(accountA)
    subject.installDeviceSession(accountA, identity.installationId, deviceA, "crb_fixture_write_only",
      fixture.clock.now.plusSeconds(8 * 86_400), "https://api.crewroll.app")
    val metadata = fixture.metadata(tripA).copy(startsAt = "2030-01-01T00:00:00Z", endsAt = "2030-01-02T00:00:00Z")
    subject.createTripKey(tripA, 1)
    val wrapped = subject.wrapTripKey(tripA, 1, deviceA, identity.e2eePublicKey, 1).wrappedKey
    if (activate) {
      subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, metadata.endsAt)
      subject.activateTrip(metadata)
    }
    return CompositeCase(fixture, disk, store, subject, identity, metadata, startupComposite(wrapped, metadata))
  }

  @Test fun `prepared bootstrap never exposes a selected trip across accounts endpoints or credential renewal`() {
    val f = compositeCase(true)
    val writes = f.disk.writes
    f.disk.reads = 0
    listOf("http://api.crewroll.app", "https://", "https:///missing-host", "https://user:password@api.crewroll.app", "https://api.crewroll.app/#fragment").forEach { invalid ->
      assertThrows(NativeKeyException::class.java) { f.subject.prepareDeviceSession(accountA, invalid) }
    }
    assertEquals(writes, f.disk.writes)
    assertEquals(0, f.disk.reads)
    listOf(accountB to "https://api.crewroll.app", accountA to "https://other.crewroll.app").forEach { (account, api) ->
      val media = NativeMediaSession({ f.subject.mediaContext() }, { f.fixture.clock.now })
      val result = media.prepareDevice { f.subject.prepareDeviceSession(account, api) }
      assertNull(result.restoredDeviceId)
      assertNull(result.activeTripId)
      assertNull(media.read(), "the old account's selected context cannot leak through a primed null result")
      media.close()
    }
    f.fixture.clock.now = f.fixture.clock.now.plusSeconds(86_400)
    val renewing = f.subject.prepareDeviceSession(accountA, "https://api.crewroll.app")
    assertEquals(f.identity, renewing.identity)
    assertNull(renewing.restoredDeviceId)
    assertNull(renewing.activeTripId)
    assertNull(renewing.activeTripId)
    f.fixture.p256.remove(NativeKeyScope(hashA, f.identity.installationId))
    assertEquals("KEY_MATERIAL_LOST", assertThrows(NativeKeyException::class.java) {
      f.subject.prepareDeviceSession(accountA, "https://api.crewroll.app")
    }.code, "corrupt identity is a visible error, not a no-trip fallback")
    f.disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `bootstrap rechecks renewal after metadata selection without opening a trip key`() {
    val f = compositeCase(true)
    val store = object : NativeKeyStore by f.store {
      override fun activeSelection(): NativeSelectedTrip? = f.store.activeSelection().also {
        f.fixture.clock.now = f.fixture.clock.now.plusSeconds(86_400)
      }
    }
    var validations = 0
    f.fixture.p256.onLoad = { validations++ }
    val subject = NativeKeyLifecycle(f.fixture.clock, store, f.fixture.crypto, f.fixture.p256,
      f.fixture.hasher, ScopedCleanupScheduler())
    val prepared = subject.prepareDeviceSession(accountA, "https://api.crewroll.app")
    assertEquals(1, validations, "the hardware public anchor is shared only inside this command")
    assertEquals(f.identity, prepared.identity)
    assertNull(prepared.restoredDeviceId)
    assertNull(prepared.activeTripId)
    f.disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `device preparation and retry selection do not request corrupt trip material`() {
    val f = compositeCase(true)
    val selectionOnly = object : NativeKeyStore by f.store {
      override fun mediaContext(): NativeMediaContext? = throw NativeKeyException.materialLost()
      override fun loadTrip(scope: NativeKeyScope, tripId: String): TripKeyRecord? = throw NativeKeyException.materialLost()
    }
    var publicLookups = 0
    f.fixture.p256.onLoad = { publicLookups++ }
    val subject = NativeKeyLifecycle(f.fixture.clock, selectionOnly, f.fixture.crypto, f.fixture.p256,
      f.fixture.hasher, ScopedCleanupScheduler(), deferMaintenance = true)
    val prepared = subject.prepareDeviceSession(accountA, "https://api.crewroll.app")
    assertEquals(deviceA, prepared.restoredDeviceId)
    assertEquals(tripA, prepared.activeTripId)
    assertEquals(1, publicLookups)
    f.disk.protectedOpens = 0
    publicLookups = 0
    assertEquals(tripA, subject.getActiveTripSelection(accountA, f.identity.installationId))
    assertNull(subject.getActiveTripSelection(accountB, f.identity.installationId))
    assertNull(subject.getActiveTripSelection(accountA, "another_installation"))
    assertEquals(0, publicLookups)
    assertEquals(0, f.disk.protectedOpens, "retry selection must not open any identity, bearer or trip secret")
    assertEquals(tripA, f.store.activeSelection()!!.metadata.tripId, "a read cannot mutate selection")
    val command = mapOf("protocolVersion" to 1, "accountId" to accountA, "installationId" to f.identity.installationId)
    assertDoesNotThrow { NativeCommandDecoder.require(command, NativeCommandKind.GET_ACTIVE_TRIP_SELECTION) }
    listOf(command + ("unexpected" to true), command - "accountId", command + ("protocolVersion" to 2)).forEach {
      assertThrows(NativeKeyException::class.java) { NativeCommandDecoder.require(it, NativeCommandKind.GET_ACTIVE_TRIP_SELECTION) }
    }
    f.disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `deferred maintenance rejects expired credentials before creating trip material`() {
    val f = compositeCase(false)
    val pending = mutableListOf<() -> Unit>()
    val scheduler = object : NativeKeyCleanupScheduling {
      override fun schedule(at: Instant, action: () -> Unit) { pending += action }
      override fun cancel() { }
      override fun close() { }
    }
    val subject = NativeKeyLifecycle(f.fixture.clock, f.store, f.fixture.crypto, f.fixture.p256,
      f.fixture.hasher, scheduler, deferMaintenance = true)
    f.fixture.clock.now = f.fixture.clock.now.plusSeconds(8 * 86_400)
    val writes = f.disk.writes
    assertThrows(NativeKeyException::class.java) { subject.createTripKey(tripB, 1) }
    assertThrows(NativeKeyException::class.java) {
      subject.installDeviceSession(accountA, f.identity.installationId, deviceA, "crb_fixture_write_only",
        f.fixture.clock.now, "https://api.crewroll.app")
    }
    assertEquals(writes, f.disk.writes)
    assertNull(f.store.tripMetadata(NativeKeyScope(hashA, f.identity.installationId), tripB))
    assertTrue(pending.isEmpty(), "an interactive command must not schedule or join global retention")
  }

  @Test fun `credential installation and trip use recheck deadlines after slow protected operations`() {
    run {
      val f = compositeCase(true)
      val writes = f.disk.writes
      val deadline = f.fixture.clock.now.plusSeconds(1)
      f.fixture.p256.onLoad = { f.fixture.clock.now = deadline }
      assertThrows(NativeKeyException::class.java) {
        f.subject.installDeviceSession(accountA, f.identity.installationId, deviceA,
          "crb_replacement_write_only", deadline, "https://api.crewroll.app")
      }
      assertEquals(writes, f.disk.writes, "expired during hardware identity validation must not install")
    }
    for (wrap in listOf(false, true)) {
      val f = compositeCase(true)
      val deadline = NativeTripRetention.deadline(f.metadata)
      val delayed = object : NativeKeyStore by f.store {
        override fun loadTrip(scope: NativeKeyScope, tripId: String): TripKeyRecord? = f.store.loadTrip(scope, tripId).also {
          f.fixture.clock.now = deadline
        }
      }
      val subject = NativeKeyLifecycle(f.fixture.clock, delayed, f.fixture.crypto, f.fixture.p256,
        f.fixture.hasher, ScopedCleanupScheduler(), deferMaintenance = true)
      val writes = f.disk.writes
      assertThrows(NativeKeyException::class.java) {
        if (wrap) subject.wrapTripKey(tripA, 1, deviceA, f.identity.e2eePublicKey, 1)
        else subject.activateTrip(f.metadata)
      }
      assertEquals(writes, f.disk.writes, "expired during selected key open must not authorize activation/wrapping")
    }
  }

  @Test fun `deferred authenticated import purges only an expired provisional before its separate durable import`() {
    for (failImportSave in listOf(false, true)) {
      val f = compositeCase(false)
      val scope = NativeKeyScope(hashA, f.identity.installationId)
      val freshKey = ByteArray(32) { 99 }
      val plain = TripKeyEnvelopeV1.encode(tripA, deviceA, deviceA, 1, freshKey)
      val wrapped = CanonicalBase64.encode(f.fixture.crypto.seal(plain, CanonicalBase64.decode(f.identity.e2eePublicKey, 32)))
      plain.fill(0)
      f.fixture.clock.now = f.fixture.clock.now.plusSeconds(86_401)
      val subject = NativeKeyLifecycle(f.fixture.clock, f.store, f.fixture.crypto, f.fixture.p256,
        f.fixture.hasher, ScopedCleanupScheduler(), deferMaintenance = true)
      f.disk.protectedAads.clear()
      assertThrows(NativeKeyException::class.java) {
        subject.wrapTripKey(tripA, 1, deviceA, f.identity.e2eePublicKey, 1)
      }
      assertTrue(f.disk.protectedAads.none { it.contentEquals(AndroidScopedDatabaseCodec.tripAad(scope, tripA)) },
        "an expired provisional is rejected using metadata without opening its key")
      val writes = f.disk.writes
      f.fixture.crypto.rejectOpen = true
      assertThrows(NativeKeyException::class.java) {
        subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, f.metadata.endsAt)
      }
      assertEquals(writes, f.disk.writes, "a rejected envelope cannot trigger targeted recovery")
      f.fixture.crypto.rejectOpen = false
      if (failImportSave) f.disk.failWriteAttempt = f.disk.writeAttempts + 2
      if (failImportSave) {
        assertThrows(NativeKeyException::class.java) {
          subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, f.metadata.endsAt)
        }
        assertEquals(writes + 1, f.disk.writes, "the expiry removal remains its own durable save")
        assertNull(f.store.tripMetadata(scope, tripA))
        f.disk.failWriteAttempt = null
      }
      subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, f.metadata.endsAt)
      val saved = f.store.loadTrip(scope, tripA)!!
      assertEquals(KeyState.INSTALLED, saved.state)
      assertArrayEquals(freshKey, saved.key)
      saved.key.fill(0); freshKey.fill(0)
      assertEquals(writes + 2, f.disk.writes)
      f.disk.loaded.forEach(::assertDatabaseSecretsErased)
    }
  }

  @Test fun `composite command rejects mismatched or open nested input before import writes`() {
    val f = compositeCase(false)
    val activation = NativeCommandDecoder.objectValue(f.command, "activation")
    val envelope = NativeCommandDecoder.objectValue(f.command, "envelope")
    val writes = f.disk.writes
    f.disk.reads = 0
    listOf(
      f.command + ("unexpected" to true),
      f.command + ("envelope" to (envelope + ("unexpected" to true))),
      f.command + ("activation" to (activation + ("unexpected" to true))),
      f.command + ("activation" to (activation + ("tripId" to tripB))),
      f.command + ("activation" to (activation + ("keyEpoch" to 2))),
      f.command + ("activation" to (activation + ("endsAt" to "2030-01-03T00:00:00Z"))),
      f.command + ("activation" to (activation - "membershipId")),
    ).forEach { invalid -> assertThrows(NativeKeyException::class.java) { f.subject.importAndActivateTrip(invalid) } }
    assertEquals(writes, f.disk.writes)
    assertEquals(0, f.disk.reads)
    f.fixture.crypto.rejectOpen = true
    assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
      f.subject.importAndActivateTrip(f.command)
    }.code)
    assertEquals(writes, f.disk.writes)
    assertEquals(KeyState.PROVISIONAL, f.store.loadTrip(NativeKeyScope(hashA, f.identity.installationId), tripA)!!.state)
  }

  @Test fun `composite activation failure keeps durable imported key and retry completes without repeating its write`() {
    val f = compositeCase(false)
    val writes = f.disk.writes
    f.disk.failWriteAttempt = f.disk.writeAttempts + 2 // import succeeds; activation fails
    val media = NativeMediaSession({ f.subject.mediaContext() }, { f.fixture.clock.now })
    assertEquals("ERR_CREWROLL_TRIP_ACTIVATION", assertThrows(NativeKeyException::class.java) {
      media.changeAndPrime<NativeMediaContext>({ f.subject.importAndActivateTrip(f.command) }, { it })
    }.code)
    assertEquals(writes + 1, f.disk.writes, "import is durable even though activation did not commit")
    assertNull(media.read(), "failed activation must not retain a usable selected lease")
    val state = AccountScopedKeyStore(f.disk).loadTrip(NativeKeyScope(hashA, f.identity.installationId), tripA)!!
    assertEquals(KeyState.INSTALLED, state.state)
    state.key.fill(0)
    f.disk.failWriteAttempt = null
    media.changeAndPrime<NativeMediaContext>({ f.subject.importAndActivateTrip(f.command) }, { it })
    assertEquals(writes + 2, f.disk.writes, "retry writes activation only, not the unchanged imported key")
    val active = media.read()!!
    assertEquals(f.metadata, active.metadata)
    active.erase(); media.close()
    f.disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `cold startup and first foreground share retention metadata without retaining decrypted secrets`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val disk = StartupCountingPersistence()
    val seeded = AccountScopedKeyStore(disk)
    seeded.importTrip(NativeKeyScope(hashA, "installation_startup"), tripA, ByteArray(32) { 7 },
      fixture.metadata(tripA).endsAt, fixture.clock.now)
    val store = AccountScopedKeyStore(disk)
    val subject = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher, ScopedCleanupScheduler())
    val deadline = NativeTripRetention.deadline(fixture.metadata(tripA))
    disk.reads = 0

    // These are the actual module cleanup and engine-retention calls on create
    // followed immediately by the foreground callback.
    repeat(2) {
      subject.runScheduledCleanup()
      assertTrue(subject.expiredTrips().isEmpty())
      assertEquals(deadline, subject.nextTripRetentionDeadline())
    }
    assertEquals(1, disk.reads, "one protected load must cover the duplicated lifecycle wake")
    assertTrue(disk.loaded.all { database -> database.scopes.values.all { state ->
      state.trips.values.all { trip -> trip.secret.isErased }
    } }, "the retention index must not own the loaded key database")

    fixture.clock.now = deadline
    val expired = subject.expiredTrips().single()
    assertEquals(deadline, expired.deadline)
    assertEquals(1, disk.reads)
    var filesPurged = false
    assertTrue(subject.purgeExpiredTrip(expired) { filesPurged = true })
    assertTrue(filesPurged)
    assertEquals(2, disk.reads, "destructive purge must reload and validate current durable state")
    assertTrue(subject.expiredTrips().isEmpty())
    assertNull(subject.nextTripRetentionDeadline())
    assertEquals(2, disk.reads)
  }

  @Test fun `restore and media context each validate one scoped read and erase its database before returning`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val disk = StartupCountingPersistence()
    val store = AccountScopedKeyStore(disk)
    val subject = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher, ScopedCleanupScheduler())
    val identity = subject.ensureDeviceIdentity(accountA)
    val scope = NativeKeyScope(hashA, identity.installationId)
    subject.installDeviceSession(accountA, scope.installationId, deviceA, "crb_fixture_write_only",
      fixture.clock.now.plusSeconds(8 * 86_400), "https://api.crewroll.app")
    store.importTrip(scope, tripA, ByteArray(32) { 7 }, fixture.metadata(tripA).endsAt, fixture.clock.now)
    subject.activateTrip(fixture.metadata(tripA))
    disk.reads = 0
    disk.loaded.clear()

    assertEquals(deviceA, subject.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    assertEquals(1, disk.reads, "session and identity must come from one protected read")
    val context = subject.mediaContext()!!
    assertEquals(2, disk.reads, "media context and identity must come from one protected read")
    assertEquals(7.toByte(), context.tripKey[0], "returned buffers must survive snapshot zeroization")
    assertArrayEquals("crb_fixture_write_only".toByteArray(), context.session.backgroundBearer)
    disk.loaded.forEach(::assertDatabaseSecretsErased)
    context.erase()

    fixture.p256.remove(scope)
    assertThrows(NativeKeyException::class.java) { subject.mediaContext() }
    disk.loaded.forEach(::assertDatabaseSecretsErased)
    assertThrows(NativeKeyException::class.java) {
      subject.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app")
    }
    disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `cold recovery validates existing envelope and activation with one load per command and no redundant writes`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val disk = StartupCountingPersistence()
    val store = AccountScopedKeyStore(disk)
    val original = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher, ScopedCleanupScheduler())
    val identity = original.ensureDeviceIdentity(accountA)
    val scope = NativeKeyScope(hashA, identity.installationId)
    original.installDeviceSession(accountA, scope.installationId, deviceA, "crb_fixture_write_only",
      fixture.clock.now.plusSeconds(8 * 86_400), "https://api.crewroll.app")
    original.createTripKey(tripA, 1)
    val wrapped = original.wrapTripKey(tripA, 1, deviceA, identity.e2eePublicKey, 1).wrappedKey
    original.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, fixture.metadata(tripA).endsAt)
    original.activateTrip(fixture.metadata(tripA))
    val restarted = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256,
      fixture.hasher, ScopedCleanupScheduler())
    disk.reads = 0; disk.writes = 0; disk.loaded.clear()
    // The legacy separate-command path remains compatible. Cipher operation
    // counts are measured separately; old whole-load timing is not a valid
    // latency model after selective record materialization.
    repeat(2) { restarted.runScheduledCleanup(); restarted.expiredTrips(); restarted.nextTripRetentionDeadline() }
    assertEquals(identity, restarted.ensureDeviceIdentity(accountA))
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    restarted.mediaContext()!!.erase()
    restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, fixture.metadata(tripA).endsAt)
    restarted.activateTrip(fixture.metadata(tripA))
    assertEquals(6, disk.reads, "cleanup, identity, restore, snapshot, import and activation each load once")
    assertEquals(0, disk.writes, "an already identical imported/active trip needs no encrypted rewrite")
    disk.loaded.forEach(::assertDatabaseSecretsErased)

    fixture.crypto.rejectOpen = true
    assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
      restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped, fixture.metadata(tripA).endsAt)
    }.code, "an installed key must never bypass authenticated envelope validation")
    assertEquals(0, disk.writes)
    disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `command scope preserves pending identity reservation across failed final save without caching partial state`() {
    listOf(1, 2).forEach { failedSave ->
      val fixture = ScopedFixture(mapOf(accountA to hashA))
      val disk = StartupCountingPersistence().apply { failWriteAttempt = failedSave }
      val subject = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256,
        fixture.hasher, ScopedCleanupScheduler())
      assertThrows(IllegalStateException::class.java) { subject.ensureDeviceIdentity(accountA) }
      assertEquals(failedSave - 1, disk.writes)
      disk.loaded.forEach(::assertDatabaseSecretsErased)
      val durable = disk.load()
      assertTrue(durable.identities.isEmpty())
      val reserved = durable.pendingIdentities[hashA]
      if (failedSave == 1) {
        assertNull(reserved)
        assertTrue(fixture.p256.scopes.isEmpty(), "P256 creation must follow the durable reservation")
      } else {
        assertNotNull(reserved)
        assertEquals(reserved, fixture.p256.scopes.single().installationId)
      }
      durable.zeroize()
      disk.failWriteAttempt = null
      val restarted = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256,
        fixture.hasher, ScopedCleanupScheduler())
      val identity = restarted.ensureDeviceIdentity(accountA)
      if (reserved != null) assertEquals(reserved, identity.installationId)
      assertEquals(1, fixture.p256.scopes.size, "retry must reuse a previously reserved hardware identity")
      assertEquals(identity, restarted.ensureDeviceIdentity(accountA))
      disk.loaded.forEach(::assertDatabaseSecretsErased)
    }
  }

  @Test fun `restore renewal and activation deadlines are rechecked after slow identity validation`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA), Instant.parse("2026-09-08T23:59:59Z"))
    val disk = StartupCountingPersistence()
    val store = AccountScopedKeyStore(disk)
    val subject = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher, ScopedCleanupScheduler())
    val identity = subject.ensureDeviceIdentity(accountA)
    val scope = NativeKeyScope(hashA, identity.installationId)
    subject.installDeviceSession(accountA, scope.installationId, deviceA, "crb_fixture_write_only",
      fixture.clock.now.plusSeconds(7 * 86_400 + 1), "https://api.crewroll.app")
    val before = fixture.clock.now
    fixture.p256.onLoad = { fixture.clock.now = before.plusSeconds(2) }
    assertNull(subject.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"),
      "a slow protected read must not return a lease that has crossed the renewal boundary")

    fixture.p256.onLoad = null
    fixture.clock.now = before
    store.importTrip(scope, tripA, ByteArray(32) { 7 }, fixture.metadata(tripA).endsAt, fixture.clock.now)
    val writes = disk.writes
    fixture.p256.onLoad = { fixture.clock.now = NativeTripRetention.deadline(fixture.metadata(tripA)) }
    assertThrows(NativeKeyException::class.java) { subject.activateTrip(fixture.metadata(tripA)) }
    assertEquals(writes, disk.writes)
    assertNull(store.mediaContext())
    disk.loaded.forEach(::assertDatabaseSecretsErased)
  }

  @Test fun `restart restores only valid credentials for the same account installation and server`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
    val scope = fixture.ensureAndInstall(accountA, deviceA, fixture.clock.now.plusSeconds(8 * 86_400))
    val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountB, scope.installationId, "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountA, "another_installation", "https://api.crewroll.app"))
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://other.crewroll.app"))
    fixture.clock.now = Instant.ofEpochSecond(100 + 8 * 86_400 - 300)
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
    fixture.clock.now = Instant.ofEpochSecond(100)
    restarted.clearDeviceSession()
    assertNull(restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
  }

  @Test fun `restore fails closed if persisted private keys are damaged`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA, fixture.clock.now.plusSeconds(8 * 86_400))
    fixture.store.corruptPrivateKey(scope)
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app")
    }
  }

  @Test fun `restart requests renewal within server window without replacing identity or trip key`() {
    listOf(8 * 86_400L, 7 * 86_400L + 1, 7 * 86_400L, 6 * 86_400L, 0L, -1L).forEach { remainingSeconds ->
      val fixture = ScopedFixture(mapOf(accountA to hashA))
      val expiry = fixture.clock.now.plusSeconds(remainingSeconds)
      val scope = fixture.ensureAndInstall(accountA, deviceA, fixture.clock.now.plusSeconds(30 * 86_400))
      val identity = fixture.subject.ensureDeviceIdentity(accountA)
      fixture.subject.createTripKey(tripA, 1)
      val prior = fixture.store.activeSession()!!
      fixture.store.installSession(scope, prior.session.copy(expiresAt = expiry))
      prior.session.backgroundBearer.fill(0)
      val originalKey = fixture.store.trip(scope, tripA)!!.key.copyOf()
      val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)

      assertEquals(if (remainingSeconds > 7 * 86_400L) deviceA else null,
        restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"),
        "remainingSeconds=$remainingSeconds")
      assertEquals(identity, restarted.ensureDeviceIdentity(accountA))
      val unchangedSession = fixture.store.activeSession()!!
      assertEquals(scope, unchangedSession.scope)
      assertEquals(deviceA, unchangedSession.session.deviceId)
      assertEquals(expiry, unchangedSession.session.expiresAt)
      assertArrayEquals(originalKey, fixture.store.trip(scope, tripA)!!.key)

      // A thirty-day renewal installs the same device and retains queued keys.
      restarted.installDeviceSession(accountA, scope.installationId, deviceA,
        "crb_renewed_fixture_bearer", fixture.clock.now.plusSeconds(30 * 86_400), "https://api.crewroll.app")
      val reopened = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
      assertEquals(deviceA, reopened.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
      assertEquals(identity, reopened.ensureDeviceIdentity(accountA))
      assertArrayEquals(originalKey, fixture.store.trip(scope, tripA)!!.key)
    }
  }

  @Test fun `same selection refresh preserves active trip and already owned transfer context`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val cipher = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 1 }, "AES"))
    var bytes: ByteArray? = null
    val disk = object : ScopedDatabasePersistence {
      override fun load() = bytes?.let { AndroidScopedDatabaseCodec.decode(it, cipher) } ?: AndroidScopedDatabase()
      override fun save(database: AndroidScopedDatabase) { bytes = AndroidScopedDatabaseCodec.encode(database, cipher) }
    }
    val store = AccountScopedKeyStore(disk)
    val subject = NativeKeyLifecycle(fixture.clock, store, fixture.crypto, fixture.p256, fixture.hasher)
    val identity = subject.ensureDeviceIdentity(accountA)
    val scope = NativeKeyScope(hashA, identity.installationId)
    subject.installDeviceSession(accountA, scope.installationId, deviceA, "crb_fixture_write_only",
      fixture.clock.now.plusSeconds(6 * 86_400), "https://api.crewroll.app")
    subject.createTripKey(tripA, 1)
    val key = store.loadTrip(scope, tripA)!!.key
    val metadata = fixture.metadata(tripA)
    store.importTrip(scope, tripA, key, metadata.endsAt, fixture.clock.now)
    subject.activateTrip(metadata)
    val owned = subject.mediaContext()!!
    val fence = NativeTransferCommandFence()
    val epoch = fence.current()
    val changed = fence.runIfCurrent(epoch) {
      subject.refreshDeviceSession(accountA, scope.installationId, deviceA,
        "crb_refreshed_same_selection", fixture.clock.now.plusSeconds(30 * 86_400), "https://api.crewroll.app")
    }
    assertTrue(changed)
    assertFalse(subject.refreshDeviceSession(accountA, scope.installationId, deviceA,
      "crb_refreshed_same_selection", fixture.clock.now.plusSeconds(30 * 86_400), "https://api.crewroll.app"),
      "unchanged credentials must not clear a genuine current-credential rejection")
    assertTrue(fence.matches(epoch), "refresh must not supersede an in-flight command")
    val refreshed = subject.mediaContext()!!
    assertEquals(scope, refreshed.scope)
    assertEquals(metadata, refreshed.metadata)
    assertArrayEquals(key, refreshed.tripKey)
    assertArrayEquals("crb_refreshed_same_selection".toByteArray(), refreshed.session.backgroundBearer)
    assertArrayEquals("crb_fixture_write_only".toByteArray(), owned.session.backgroundBearer)
    assertArrayEquals(key, owned.tripKey, "a refresh must not erase an existing transfer's owned buffers")
    assertEquals(identity, subject.ensureDeviceIdentity(accountA))
    val restarted = NativeKeyLifecycle(fixture.clock, AccountScopedKeyStore(disk), fixture.crypto, fixture.p256, fixture.hasher)
    assertEquals(metadata, restarted.mediaContext()!!.metadata)
    assertEquals(deviceA, restarted.restoreDeviceSession(accountA, scope.installationId, "https://api.crewroll.app"))
  }

  @Test fun `refresh rejects mismatched selection and expired or regressing lease without mutation`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
    val expiry = fixture.clock.now.plusSeconds(8 * 86_400)
    val scope = fixture.ensureAndInstall(accountA, deviceA, expiry)
    fixture.subject.createTripKey(tripA, 1)
    val key = fixture.store.trip(scope, tripA)!!.key.copyOf()
    val later = fixture.clock.now.plusSeconds(30 * 86_400)
    data class Attempt(val account: String = accountA, val installation: String = scope.installationId,
      val device: String = deviceA, val api: String = "https://api.crewroll.app", val date: Instant = later,
      val bearer: String = "crb_refreshed_same_selection")
    listOf(Attempt(account = accountB), Attempt(installation = "another_installation"), Attempt(device = deviceB),
      Attempt(api = "https://other.crewroll.app"), Attempt(date = expiry.minusSeconds(1)),
      Attempt(date = fixture.clock.now), Attempt(bearer = "invalid_bearer")).forEach { attempt ->
      assertThrows(NativeKeyException::class.java) {
        fixture.subject.refreshDeviceSession(attempt.account, attempt.installation, attempt.device,
          attempt.bearer, attempt.date, attempt.api)
      }
      val unchanged = fixture.store.activeSession()!!
      assertEquals(scope, unchanged.scope)
      assertEquals(deviceA, unchanged.session.deviceId)
      assertEquals(expiry, unchanged.session.expiresAt)
      assertArrayEquals("crb_fixture_write_only".toByteArray(), unchanged.session.backgroundBearer)
      assertArrayEquals(key, fixture.store.trip(scope, tripA)!!.key)
    }
  }

  @Test fun `late refresh cannot select an account after signout or replacement`() {
    listOf(false, true).forEach { replaceAccount ->
      val fixture = ScopedFixture(mapOf(accountA to hashA, accountB to hashB))
      val scope = fixture.ensureAndInstall(accountA, deviceA)
      val fence = NativeTransferCommandFence()
      val requestEpoch = fence.current()
      val nextEpoch = fence.advance()
      fence.runIfCurrent(nextEpoch) {
        if (replaceAccount) fixture.ensureAndInstall(accountB, deviceB) else fixture.subject.clearDeviceSession()
      }
      fun refresh() = fixture.subject.refreshDeviceSession(accountA, scope.installationId, deviceA,
        "crb_late_old_account_response", fixture.clock.now.plusSeconds(30 * 86_400), "https://api.crewroll.app")
      assertThrows(NativeKeyException::class.java) { fence.runIfCurrent(requestEpoch) { refresh() } }
      assertThrows(NativeKeyException::class.java) { refresh() }
      val selected = fixture.store.activeSession()
      if (replaceAccount) assertEquals(deviceB, selected!!.session.deviceId) else assertNull(selected)
    }
  }

  @Test fun `undated installed keys cannot wrap until authenticated import backfills expiry`() {
    val fixture = ScopedFixture(mapOf(accountA to hashA))
    val scope = fixture.ensureAndInstall(accountA, deviceA)
    fixture.subject.createTripKey(tripA, 1)
    val wrapped = fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1)
    val record = fixture.store.trip(scope, tripA)!!
    fixture.store.putTrip(scope, tripA, record.copy(state = KeyState.INSTALLED), endsAt = null)
    assertThrows(NativeKeyException::class.java) { fixture.subject.createTripKey(tripA, 1) }
    assertThrows(NativeKeyException::class.java) {
      fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1)
    }
    fixture.subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey, fixture.metadata(tripA).endsAt)
    assertDoesNotThrow { fixture.subject.wrapTripKey(tripA, 1, deviceA, fixture.identityPublicKey(scope), 1) }
    assertNull(fixture.store.mediaContext())
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
      fixture.subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrappedForA.wrappedKey, "2026-09-02T12:00:00.123Z")
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
    fixture.ensureAndInstall(accountA, deviceA, fixture.clock.now.plusSeconds(30 * 86_400))
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
    val scope = fixture.ensureAndInstall(accountA, deviceA, fixture.clock.now.plusSeconds(30 * 86_400))
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
      Triple(NativeCommandKind.REFRESH_DEVICE_SESSION, mapOf(
        "protocolVersion" to 1, "accountId" to accountA, "installationId" to "install_A-123456",
        "deviceId" to v4DeviceId, "backgroundBearer" to "crb_fixture_write_only",
        "backgroundBearerExpiresAt" to "2026-09-01T12:00:00Z", "apiBaseUrl" to "https://api.crewroll.app",
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
        "endsAt" to "2026-09-02T12:00:00.123Z",
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
      fixture.subject.importTripKey(tripB, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey, "2026-09-02T12:00:00.123Z")
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
    fixture.subject.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey, "2026-09-02T12:00:00.123Z")
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
        fixture.subject.importTripKey(mutation[0], 1, 1, mutation[1], mutation[2], 1, mutation[3], "2026-09-02T12:00:00.123Z")
      }.code)
    }

    val restarted = NativeKeyLifecycle(fixture.clock, fixture.store, fixture.crypto, fixture.p256, fixture.hasher)
    restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey, "2026-09-02T12:00:00.123Z")
    assertEquals(KeyState.INSTALLED, fixture.store.trip(scope, tripA)?.state)
    assertThrows(NativeKeyException::class.java) { restarted.discardProvisionalTripKey(tripA, 1) }
    assertDoesNotThrow { restarted.discardProvisionalTripKey(tripB, 1) }

    fixture.store.putTrip(scope, tripA, TripKeyRecord(ByteArray(32) { 0x7a }, KeyState.INSTALLED))
    assertEquals("KEY_ENVELOPE_INVALID", assertThrows(NativeKeyException::class.java) {
      restarted.importTripKey(tripA, 1, 1, deviceA, deviceA, 1, wrapped.wrappedKey, "2026-09-02T12:00:00.123Z")
    }.code)
    assertArrayEquals(ByteArray(32) { 0x7a }, fixture.store.trip(scope, tripA)?.key)

    restarted.createTripKey(tripB, 1)
    restarted.discardProvisionalTripKey(tripB, 1)
    assertNull(fixture.store.trip(scope, tripB))
    assertTrue(fixture.store.hasTombstone(scope, tripB))
  }
}

private class StartupEngineProbe(private val media: NativeMediaSession, lifecycle: NativeKeyLifecycle) : AutoCloseable {
  private val provider = VerifiedSodiumProvider.open()
  private val root = Files.createTempDirectory("crewroll-startup-engine-").toFile()
  val firstContext = CountDownLatch(1)
  private val photos = object : NativePhotoLibraryPort {
    override fun observe(changed: (() -> Unit)?) { }
    override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int) = emptyList<DiscoveredPhoto>()
    override fun exportOriginal(localId: String, destination: File): PhotoMetadata = error("no synthetic capture")
    override fun preview(source: File, destination: File): PhotoMetadata = error("no synthetic preview")
    override fun findSaved(assetId: String): String? = null
    override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, relativePath: String, allocated: (String) -> Unit): String = error("no synthetic save")
    override fun verify(localId: String, bytes: Long, checksum: ByteArray) { error("no synthetic verify") }
  }
  private val network = object : NativePhotoTransportPort {
    override fun cancel() { }
    override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject {
      throw java.io.IOException("offline fixture")
    }
    override fun upload(url: String, headers: Map<String, String>, source: File): String = error("no upload")
    override fun download(url: String, destination: File, expectedBytes: Long) { error("no download") }
  }
  val engine = NativePhotoTransferEngine(root, {
    val value = media.read()
    firstContext.countDown()
    value
  }, photos, NativePhotoCrypto(provider.sodium), { network }, {},
    expiredTrips = lifecycle::expiredTrips, nextRetentionDeadline = lifecycle::nextTripRetentionDeadline)
  override fun close() {
    engine.stop().get(3, TimeUnit.SECONDS)
    engine.close()
    media.close()
    provider.close()
    root.deleteRecursively()
  }
}

private fun assertDatabaseSecretsErased(database: AndroidScopedDatabase) {
  assertTrue(database.identities.values.all { it.privateKey.isErased })
  database.scopes.values.forEach { state ->
    assertTrue(state.session?.bearer?.isErased != false)
    assertTrue(state.trips.values.all { it.secret.isErased })
  }
}

private class StartupCountingPersistence : ScopedDatabasePersistence {
  private val actualCipher = AesGcmScopedSecretCipher(SecretKeySpec(ByteArray(32) { 1 }, "AES"))
  var protectedOpens = 0
  var protectedSeals = 0
  val protectedAads = mutableListOf<ByteArray>()
  private val cipher = object : AndroidScopedSecretCipher {
    override fun seal(plaintext: ByteArray, aad: ByteArray): ByteArray {
      protectedSeals++; return actualCipher.seal(plaintext, aad)
    }
    override fun open(record: ByteArray, aad: ByteArray): ByteArray {
      protectedOpens++; protectedAads += aad.copyOf(); return actualCipher.open(record, aad)
    }
  }
  private var bytes: ByteArray? = null
  var reads = 0
  var writes = 0
  var writeAttempts = 0
  var failWriteAttempt: Int? = null
  var onProtectedIo: (() -> Unit)? = null
  val loaded = mutableListOf<AndroidScopedDatabase>()
  override fun load(): AndroidScopedDatabase {
    reads++
    onProtectedIo?.invoke()
    return (bytes?.let { AndroidScopedDatabaseCodec.decode(it, cipher) } ?: AndroidScopedDatabase()).also(loaded::add)
  }
  override fun save(database: AndroidScopedDatabase) {
    writeAttempts++
    onProtectedIo?.invoke()
    if (writeAttempts == failWriteAttempt) error("disk unavailable")
    bytes = AndroidScopedDatabaseCodec.encode(database, cipher)
    writes++
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

  fun ensureAndInstall(accountId: String, deviceId: String, expiresAt: Instant = Instant.ofEpochSecond(900)): NativeKeyScope {
    val identity = subject.ensureDeviceIdentity(accountId)
    subject.installDeviceSession(
      accountId,
      identity.installationId,
      deviceId,
      "crb_fixture_write_only",
      expiresAt,
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
  var onLoad: (() -> Unit)? = null
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
  override fun loadPublicKey(scope: NativeKeyScope): ByteArray? { onLoad?.invoke(); return keys[scope]?.copyOf() }
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
    val tripEndsAt: MutableMap<String, String> = mutableMapOf(),
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
  override fun tripRetentionDeadline(scope: NativeKeyScope, tripId: String): Instant? =
    scopes[scope]?.tripEndsAt?.get(tripId)?.let(NativeTripRetention::deadline)
      ?: scopes[scope]?.frozen?.get(tripId)?.let(NativeTripRetention::deadline)
  override fun importTrip(scope: NativeKeyScope, tripId: String, key: ByteArray, endsAt: String, now: Instant): TripImportOutcome = transaction {
    if (NativeTripRetention.deadline(endsAt) <= now) throw NativeKeyException.materialLost()
    tripRetentionDeadline(scope, tripId)?.let { if (it != NativeTripRetention.deadline(endsAt)) return@transaction TripImportOutcome.CONFLICT }
    val state = scopes.getOrPut(scope, ::ScopeState)
    val existing = state.trips[tripId]
    if (existing != null) {
      if (!existing.key.contentEquals(key)) return@transaction TripImportOutcome.CONFLICT
      if (existing.state == KeyState.PROVISIONAL) state.trips[tripId] = existing.copy(state = KeyState.INSTALLED)
      state.tripEndsAt[tripId] = endsAt
    state.tombstones.remove(tripId)
      return@transaction TripImportOutcome.EXISTING
    }
    state.trips[tripId] = TripKeyRecord(key.copyOf(), KeyState.INSTALLED)
    state.tripEndsAt[tripId] = endsAt
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
  fun putTrip(scope: NativeKeyScope, tripId: String, record: TripKeyRecord, endsAt: String? = "2026-09-02T12:00:00.123Z") {
    val state = scopes.getOrPut(scope, ::ScopeState)
    state.trips[tripId] = record
    if (record.state != KeyState.PROVISIONAL) {
      if (endsAt == null) state.tripEndsAt.remove(tripId) else state.tripEndsAt[tripId] = endsAt
    }
  }
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
    tripEndsAt.toMutableMap(),
  )
  private fun DeviceIdentityMaterial.deepCopy() = copy(
    authenticationPublicKey = authenticationPublicKey.copyOf(),
    e2eePublicKey = e2eePublicKey.copyOf(),
    e2eePrivateKey = e2eePrivateKey.copyOf(),
  )
}
