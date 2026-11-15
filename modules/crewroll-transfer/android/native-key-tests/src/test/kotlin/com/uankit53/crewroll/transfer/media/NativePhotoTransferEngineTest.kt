package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.crypto.VerifiedSodiumProvider
import com.uankit53.crewroll.transfer.identitykeys.*
import java.io.File
import java.io.IOException
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePhotoTransferEngineTest {
    @Test fun `legacy pending pages retain current trip deliveries without a discovery cursor`() {
        Fixture().use { f ->
            val foreign = "01990000-0000-4000-8001-000000000099"
            f.pendingPage = {
                JSONObject().put("items", JSONArray().apply {
                    put(JSONObject().put("deliveryId", foreign).put("assetId", foreign)
                        .put("tripId", "01990000-0000-7000-8000-000000000099").put("committedAt", "2026-09-09T12:00:00Z"))
                    if (!f.acknowledged) put(JSONObject().put("deliveryId", f.delivery).put("assetId", f.asset)
                        .put("tripId", f.trip).put("committedAt", "2026-09-09T12:00:01Z"))
                })
            }
            val engine = f.engine()
            f.start(engine)
            val journal = NativeTransferJournal(File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}"))
            assertEquals(1, f.receipts)
            assertEquals(1, f.saves)
            assertNull(journal.pendingDeliveryCursor(f.trip))
            assertNull(journal.record(foreign))
            assertTrue(journal.record(f.delivery)!!.getBoolean("complete"))
        }
    }

    @Test fun `pending discovery resumes after restart and wraps to its head`() {
        Fixture().use { f ->
            val directory = File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            val id = "01990000-0000-4000-8001-000000000001"
            val blocked = JSONObject().put("deliveryId", id).put("assetId", id).put("tripId", f.trip)
                .put("committedAt", "2026-09-09T12:00:00Z")
            NativeTransferJournal(directory).put(JSONObject(blocked.toString()).put("workId", id).put("complete", false)
                .put("capturedAt", blocked.getString("committedAt")).put("blocker", "INTEGRITY_FAILURE"))
            f.pendingPage = { path ->
                if (path.contains("&after=") || f.acknowledged) {
                    JSONObject().put("items", JSONArray().apply {
                        if (!f.acknowledged) put(JSONObject().put("deliveryId", f.delivery).put("assetId", f.asset)
                            .put("tripId", f.trip).put("committedAt", "2026-09-09T12:00:01Z"))
                    }).put("nextCursor", JSONObject.NULL).put("hasMore", false)
                } else JSONObject().put("items", JSONArray().put(blocked)).put("nextCursor", "cGFnZTI").put("hasMore", true)
            }
            val first = f.engine()
            first.activate().get(5, TimeUnit.SECONDS)
            f.await {
                File(directory, "journal.json").let { file ->
                    file.exists() && JSONObject(file.readText()).optJSONObject("pendingDeliveryCursors")?.optString(f.trip) == "cGFnZTI"
                }
            }
            f.stop(first)
            assertEquals(0, f.receipts)
            f.pendingPaths.clear()
            val restarted = f.engine()
            restarted.activate().get(5, TimeUnit.SECONDS)
            // Receipt transport completion precedes the journal checkpoint and a
            // concurrent discovery may still hold the previous continuation.
            // Stop only after both durable outcomes have actually settled.
            f.await {
                val persisted = JSONObject(File(directory, "journal.json").readText())
                f.receipts == 1 &&
                    persisted.getJSONObject("works").optJSONObject(f.delivery)?.optBoolean("complete") == true &&
                    persisted.optJSONObject("pendingDeliveryCursors")?.has(f.trip) != true
            }
            f.stop(restarted)
            assertEquals("/v1/deliveries/pending?tripId=${f.trip}&after=cGFnZTI", f.pendingPaths.first())
            assertNull(NativeTransferJournal(directory).pendingDeliveryCursor(f.trip))
            assertEquals(1, f.saves)
            assertEquals("INTEGRITY_FAILURE", NativeTransferJournal(directory).record(id)!!.getString("blocker"))
        }
    }

    @Test fun `malformed continuation or foreign trip rejects the complete page without cursor advancement`() {
        listOf("foreign-trip", "missing-field", "same-cursor", "cursor-at-end", "empty-continuation", "invalid-cursor").forEach { invalid ->
            Fixture().use { f ->
                val directory = File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
                NativeTransferJournal(directory).admitPendingDeliveries(emptyList(), f.trip, "cHJldg")
                val items = JSONArray().put(JSONObject().put("deliveryId", f.delivery).put("assetId", f.asset)
                    .put("tripId", f.trip).put("committedAt", "2026-09-09T12:00:00Z"))
                val response = JSONObject().put("items", items).put("nextCursor", "cGFnZTI").put("hasMore", true)
                when (invalid) {
                    "foreign-trip" -> items.put(JSONObject(items.getJSONObject(0).toString()).put("tripId", "01990000-0000-7000-8000-000000000099"))
                    "missing-field" -> response.remove("hasMore")
                    "same-cursor" -> response.put("nextCursor", "cHJldg")
                    "cursor-at-end" -> response.put("hasMore", false)
                    "empty-continuation" -> response.put("items", JSONArray())
                    "invalid-cursor" -> response.put("nextCursor", "not/a+cursor")
                }
                f.pendingPage = { response }
                val engine = f.engine()
                engine.activate().get(5, TimeUnit.SECONDS)
                f.await { (engine.snapshot().get(5, TimeUnit.SECONDS)["blockers"] as List<*>).contains("INTEGRITY_FAILURE") }
                f.stop(engine)
                val journal = NativeTransferJournal(directory)
                assertTrue(journal.records().isEmpty(), invalid)
                assertEquals("cHJldg", journal.pendingDeliveryCursor(f.trip), invalid)
                assertEquals(0, f.receipts, invalid)
                assertEquals(0, f.saves, invalid)
            }
        }
    }

    @Test fun `a late pending page cannot cross pause or account selection`() {
        listOf(false, true).forEach { switchAccount -> Fixture().use { f ->
            val directory = File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.pendingPage = {
                entered.countDown(); check(release.await(5, TimeUnit.SECONDS))
                JSONObject().put("items", JSONArray().put(JSONObject().put("deliveryId", f.delivery).put("assetId", f.asset)
                    .put("tripId", f.trip).put("committedAt", "2026-09-09T12:00:00Z")))
                    .put("nextCursor", "cGFnZTI").put("hasMore", true)
            }
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            try {
                if (switchAccount) {
                    f.context = f.context.copy(scope = NativeKeyScope("b".repeat(64), f.context.scope.installationId))
                    release.countDown()
                    f.run(engine)
                    f.stop(engine)
                } else {
                    val stopped = engine.stop()
                    release.countDown()
                    stopped.get(5, TimeUnit.SECONDS)
                }
                val journal = NativeTransferJournal(directory)
                assertTrue(journal.records().isEmpty())
                assertNull(journal.pendingDeliveryCursor(f.trip))
                assertEquals(0, f.receipts)
                assertEquals(0, f.saves)
            } finally { release.countDown() }
        } }
    }

    @Test fun `a full blocked first page cannot hide a later valid original`() {
        Fixture().use { f ->
            val ledger = NativeTransferJournal(File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}"))
            val first = JSONArray()
            repeat(100) { index ->
                val id = "01990000-0000-4000-8001-${index.toString().padStart(12, '0')}"
                val item = JSONObject().put("deliveryId", id).put("assetId", id).put("tripId", f.trip)
                    .put("committedAt", "2026-09-09T12:00:00Z")
                first.put(item)
                ledger.put(JSONObject(item.toString()).put("workId", id).put("capturedAt", item.getString("committedAt"))
                    .put("complete", false).put("blocker", "INTEGRITY_FAILURE"))
            }
            f.pendingPage = { path ->
                if (path.endsWith("&after=cGFnZTI")) {
                    JSONObject().put("items", JSONArray().apply {
                        if (!f.acknowledged) put(JSONObject().put("deliveryId", f.delivery).put("assetId", f.asset)
                            .put("tripId", f.trip).put("committedAt", "2026-09-09T12:00:01Z"))
                    }).put("nextCursor", JSONObject.NULL).put("hasMore", false)
                } else JSONObject().put("items", first).put("nextCursor", "cGFnZTI").put("hasMore", true)
            }
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            f.stop(engine)
            assertEquals(1, f.saves)
            assertEquals(100, f.count(engine, "blocked"))
            assertTrue(f.pendingPaths.contains("/v1/deliveries/pending?tripId=${f.trip}&after=cGFnZTI"))
            assertEquals(100, NativeTransferJournal(ledger.directory).records().count { it.optionalString("blocker") == "INTEGRITY_FAILURE" })
        }
    }

    @Test fun `credential rotation recovers preinstall and late old bearer rejections`() {
        listOf(false, true).forEach { lateFailure -> Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val old = f.context
            val rejected = java.util.concurrent.atomic.AtomicBoolean(false)
            val rejectOld: (NativeMediaContext) -> Unit = { context ->
                if (MessageDigest.isEqual(context.session.backgroundBearer, old.session.backgroundBearer)) {
                    if (lateFailure) { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
                    rejected.set(true); throw TransferHttpException(401, true)
                }
            }
            if (lateFailure) f.savedReceiptHook = rejectOld else f.downloadGrantHook = rejectOld
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                if (lateFailure) assertTrue(entered.await(5, TimeUnit.SECONDS))
                else f.await { f.count(engine, "blocked") == 1 }
                f.context = old.copy(session = old.session.copy(backgroundBearer = "fresh-credential".toByteArray(), expiresAt = Instant.now().plusSeconds(30 * 86_400)))
                engine.credentialRefreshed(old.session.deviceId).get(5, TimeUnit.SECONDS)
                release.countDown()
                f.await(8) { f.receipts == 1 }
                assertTrue(rejected.get())
                assertEquals(1, f.saves); assertArrayEquals(f.source, f.saved)
                assertEquals(0, f.count(engine, "blocked"))
                assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            } finally { release.countDown() }
        } }
    }

    @Test fun `current credential rejection stays blocked and refresh preserves unrelated failures and pause`() {
        Fixture().use { f ->
            val directory = File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId)
            val unrelated = "01990000-0000-4000-8000-000000000099"
            NativeTransferJournal(directory).put(JSONObject().put("workId", unrelated).put("assetId", unrelated).put("tripId", f.trip)
                .put("capturedAt", Instant.now().toString()).put("complete", false).put("deliveryId", unrelated).put("blocker", "INTEGRITY_FAILURE"))
            val rejected = java.util.concurrent.atomic.AtomicInteger()
            f.downloadGrantHook = { rejected.incrementAndGet(); throw TransferHttpException(403, true) }
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.count(engine, "blocked") == 2 }
            engine.stop().get(5, TimeUnit.SECONDS)
            engine.credentialRefreshed(f.context.session.deviceId) { false }.get(5, TimeUnit.SECONDS)
            assertEquals(2, f.count(engine, "blocked"))
            f.context = f.context.copy(session = f.context.session.copy(backgroundBearer = "fresh-rejected-credential".toByteArray(), expiresAt = Instant.now().plusSeconds(30 * 86_400)))
            engine.credentialRefreshed(f.context.session.deviceId).get(5, TimeUnit.SECONDS)
            assertEquals(1, f.count(engine, "blocked"))
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            assertEquals(0, f.saves); assertEquals(0, f.receipts)
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.count(engine, "blocked") == 2 }
            assertEquals(2, rejected.get(), "the newly current rejected credential stays blocked instead of looping")
        }
    }

    @Test fun `an intervening engine generation rejects erasure instead of acknowledging incomplete cleanup`() {
        Fixture().use { f ->
            val engine = f.engine()
            val directory = File(f.root, f.context.scope.accountHash + ".still-pending").apply { mkdirs() }
            val marker = File(directory, "pending-work").apply { writeText("retry") }
            val erasure = engine.eraseAccount(f.context.scope.accountHash, protectedMutation = { mutation ->
                engine.stop() // A retention stop may advance this without a new selection command.
                mutation()
            })
            assertThrows(java.util.concurrent.ExecutionException::class.java) { erasure.get(5, TimeUnit.SECONDS) }
            assertTrue(marker.exists())
        }
    }
    @Test fun `account erasure takes the ownership fence before deleting local files`() {
        Fixture().use { f ->
            val fence = NativeTransferCommandFence(); val epoch = fence.advance()
            val engine = f.engine()
            val directory = File(f.root, f.context.scope.accountHash + ".old").apply { mkdirs() }
            File(directory, "old-work").writeText("old")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val erasure = engine.eraseAccount(f.context.scope.accountHash, protectedMutation = { mutation ->
                entered.countDown(); check(release.await(8, TimeUnit.SECONDS))
                fence.runIfCurrent(epoch, mutation)
            }) { fence.matches(epoch) }
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val replacement = fence.advance()
                val marker = fence.runIfCurrent(replacement) { File(directory, "new-work").apply { writeText("new") } }
                release.countDown()
                assertThrows(java.util.concurrent.ExecutionException::class.java) { erasure.get(5, TimeUnit.SECONDS) }
                assertTrue(marker.exists())
            } finally { release.countDown() }
        }
    }
    @Test fun `a stale OS lease stop cannot pause newer foreground work`() {
        Fixture().use { f ->
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            engine.stop { false }.get(5, TimeUnit.SECONDS)
            assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            f.await { f.receipts == 1 }
        }
    }
    @Test fun `account file erasure is fenced again after an asynchronous drain`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            val current = java.util.concurrent.atomic.AtomicBoolean(true)
            f.observeHook = { enabled -> if (!enabled) { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) } }
            val engine = f.engine()
            val directory = File(f.root, f.context.scope.accountHash + ".replacement").apply { mkdirs() }
            try {
                val erase = engine.eraseAccount(f.context.scope.accountHash) { current.get() }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                current.set(false)
                val marker = File(directory, "new-session-work").apply { writeText("retained") }
                release.countDown()
                assertThrows(java.util.concurrent.ExecutionException::class.java) { erase.get(5, TimeUnit.SECONDS) }
                assertTrue(marker.exists())
            } finally { release.countDown(); f.observeHook = null }
        }
    }
    @Test fun `expired background wake predicate cannot unpause after a delayed retention scan`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.retentionScanHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            var current = true
            val engine = f.engine()
            try {
                val activation = engine.activate { current }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                current = false
                release.countDown()
                activation.get(5, TimeUnit.SECONDS)
                assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
                assertEquals(0, f.receipts)
                f.retentionScanHook = null
                engine.activate().get(5, TimeUnit.SECONDS)
                f.await { f.receipts == 1 }
            } finally { release.countDown() }
        }
    }
    @Test fun `failed observer registration stays paused and a later activation rebuilds its timers`() {
        Fixture().use { f ->
            var failed = false
            f.observeHook = { enabled ->
                if (enabled && !failed) { failed = true; throw PhotoLibraryException("PHOTO_PERMISSION") }
            }
            val engine = f.engine()
            assertThrows(java.util.concurrent.ExecutionException::class.java) { engine.activate().get(5, TimeUnit.SECONDS) }
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            assertArrayEquals(f.source, f.saved)
            assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
        }
    }

    @Test fun `stale retention candidate skips journal and staged files after authenticated backfill`() {
        Fixture().use { f ->
            val directory = File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId)
            val journal = NativeTransferJournal(directory)
            journal.put(JSONObject().put("workId", "new-work").put("assetId", f.asset).put("tripId", f.trip)
                .put("state", "RECEIVING").put("directory", "stage-01990000-0000-7000-8000-000000000099"))
            val stage = File(directory, "stage-01990000-0000-7000-8000-000000000099").apply { mkdirs() }
            File(stage, "original.ciphertext").writeBytes(byteArrayOf(7))
            f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, f.trip, Instant.now().minusSeconds(1)))
            f.retentionCandidateCurrent = false
            val engine = f.engine()
            engine.reconcileRetention().get(5, TimeUnit.SECONDS)
            assertTrue(f.purgedTrips.isEmpty())
            assertNotNull(NativeTransferJournal(directory).record("new-work"))
            assertTrue(File(stage, "original.ciphertext").isFile)
            assertTrue(f.contextAvailable)
        }
    }

    @Test fun `a successful retention retry restores the current valid trip without another activation`() {
        assertRetentionRetryRespectsPolicy(stopBetweenRetries = false)
    }

    @Test fun `an explicit stop between retention retries prevents automatic resume`() {
        assertRetentionRetryRespectsPolicy(stopBetweenRetries = true)
    }

    private fun assertRetentionRetryRespectsPolicy(stopBetweenRetries: Boolean) {
        Fixture().use { f ->
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            val otherTrip = "01990000-0000-7000-8000-000000000009"
            f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, otherTrip, Instant.now().minusSeconds(1)))
            var failed = false
            f.purgeHook = {
                if (!failed) { failed = true; throw IOException("transient key store failure") }
            }
            assertThrows(java.util.concurrent.ExecutionException::class.java) {
                engine.reconcileRetention().get(5, TimeUnit.SECONDS)
            }
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            assertTrue(f.purgedTrips.isEmpty())
            if (stopBetweenRetries) engine.stop().get(5, TimeUnit.SECONDS)
            engine.reconcileRetention().get(5, TimeUnit.SECONDS)
            assertEquals(listOf(otherTrip), f.purgedTrips.map { it.tripId })
            assertEquals(stopBetweenRetries, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            assertTrue(f.contextAvailable)
            assertArrayEquals(f.source, f.saved)
        }
    }

    @Test fun `an empty retry after a committed purge restores the requested running policy`() {
        Fixture().use { f ->
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            val expired = NativeExpiredTrip(f.context.scope, "01990000-0000-7000-8000-000000000009", Instant.now().minusSeconds(1))
            f.retentionTrips = listOf(expired)
            f.purgeHook = { trip ->
                f.purgedTrips.add(trip); f.retentionTrips = emptyList()
                throw IOException("purge committed before its acknowledgement failed")
            }
            assertThrows(java.util.concurrent.ExecutionException::class.java) {
                engine.reconcileRetention().get(5, TimeUnit.SECONDS)
            }
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            engine.reconcileRetention().get(5, TimeUnit.SECONDS)
            assertEquals(listOf(expired), f.purgedTrips)
            assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            assertArrayEquals(f.source, f.saved)
        }
    }

    @Test fun `an older activation cannot undo a stop while the retention scan is pending`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.retentionScanHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                val activation = engine.activate()
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                engine.stop().get(5, TimeUnit.SECONDS)
                release.countDown()
                activation.get(5, TimeUnit.SECONDS)
                assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
                assertEquals(0, f.downloads)
                f.retentionScanHook = null
                engine.activate().get(5, TimeUnit.SECONDS)
                f.await { f.receipts == 1 }
            } finally { release.countDown() }
        }
    }

    @Test fun `activation still starts the current valid trip after purging another expired trip`() {
        Fixture().use { f ->
            val otherTrip = "01990000-0000-7000-8000-000000000009"
            f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, otherTrip, Instant.now().minusSeconds(1)))
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            assertEquals(listOf(otherTrip), f.purgedTrips.map { it.tripId })
            assertTrue(f.contextAvailable)
            assertArrayEquals(f.source, f.saved)
            assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
        }
    }

    @Test fun `a newer activation joins cleanup and resumes the current valid trip`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalDownloadHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val otherTrip = "01990000-0000-7000-8000-000000000009"
                f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, otherTrip, Instant.now().minusSeconds(1)))
                val cleanup = engine.reconcileRetention()
                f.await { engine.snapshot().get(1, TimeUnit.SECONDS)["paused"] == true }
                val activation = engine.activate()
                release.countDown()
                cleanup.get(5, TimeUnit.SECONDS)
                activation.get(5, TimeUnit.SECONDS)
                f.await { f.receipts == 1 }
                assertEquals(listOf(otherTrip), f.purgedTrips.map { it.tripId })
                assertEquals(false, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
                assertArrayEquals(f.source, f.saved)
            } finally { release.countDown() }
        }
    }

    @Test fun `retention timer preserves the delivery window and never removes a saved system photo`() {
        Fixture().use { f ->
            f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, f.trip, Instant.now().plusMillis(300)))
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            assertTrue(f.purgedTrips.isEmpty())
            f.await { f.receipts == 1 }
            assertArrayEquals(f.source, f.saved)
            f.await { f.purgedTrips.size == 1 }
            assertArrayEquals(f.source, f.saved)
            assertTrue(NativeTransferJournal(File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId)).records().isEmpty())
        }
    }

    @Test fun `an interleaved pause invalidates retention before its destructive phase`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalDownloadHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, f.trip, Instant.now().minusSeconds(1)))
                val cleanup = engine.reconcileRetention()
                f.await { engine.snapshot().get(1, TimeUnit.SECONDS)["paused"] == true }
                val newerPause = engine.stop()
                release.countDown()
                newerPause.get(5, TimeUnit.SECONDS)
                assertThrows(java.util.concurrent.ExecutionException::class.java) { cleanup.get(5, TimeUnit.SECONDS) }
                assertTrue(f.purgedTrips.isEmpty())
                assertTrue(f.contextAvailable)
                val ledger = NativeTransferJournal(File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId))
                assertTrue(ledger.records().any { it.getString("tripId") == f.trip })
            } finally { release.countDown() }
        }
    }

    @Test fun `hard expiry drains in-flight work then purges only that trip before deleting its key`() {
        Fixture().use { f ->
            val otherTrip = "01990000-0000-7000-8000-000000000009"
            val otherWork = "01990000-0000-4000-8000-000000000008"
            val scopeRoot = File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId)
            val ledger = NativeTransferJournal(scopeRoot)
            val otherStage = File(scopeRoot, "stage-$otherWork").apply { mkdirs() }
            File(otherStage, "original.ciphertext").writeText("other-trip")
            ledger.put(JSONObject().put("workId", otherWork).put("tripId", otherTrip).put("complete", false).put("directory", otherStage.name))
            val cache = NativePreviewStore(scopeRoot)
            cache.enqueue(listOf(JSONObject().put("assetId", otherWork).put("tripId", otherTrip)
                .put("retainUntil", Instant.now().plusSeconds(3600).toString())), otherTrip, "1")
            val otherPreview = cache.directory(otherWork).apply { mkdirs() }
            File(otherPreview, "preview.jpg").writeText("other-preview")
            File(otherPreview, "preview.ciphertext").writeText("other-encrypted-preview")
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalDownloadHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, f.trip, Instant.now().minusSeconds(1)))
                f.purgeHook = {
                    assertTrue(NativeTransferJournal(scopeRoot).records().none { it.getString("tripId") == f.trip })
                    assertTrue(NativePreviewStore(scopeRoot).records(f.trip).isEmpty())
                    assertTrue(otherStage.exists())
                }
                val cleanup = engine.reconcileRetention()
                assertThrows(java.util.concurrent.TimeoutException::class.java) { cleanup.get(50, TimeUnit.MILLISECONDS) }
                assertTrue(f.purgedTrips.isEmpty())
                release.countDown()
                cleanup.get(5, TimeUnit.SECONDS)
                assertEquals(listOf(f.trip), f.purgedTrips.map { it.tripId })
                assertNull(f.saved)
                val reopened = NativeTransferJournal(scopeRoot)
                assertEquals(listOf(otherWork), reopened.records().map { it.getString("workId") })
                assertTrue(File(otherStage, "original.ciphertext").exists())
                assertTrue(File(otherPreview, "preview.ciphertext").exists())
                assertTrue(f.root.resolve("fixture-original").exists())
            } finally { release.countDown() }
        }
    }

    @Test fun `saved original rebuilds its preview even when the server gallery is unavailable`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf(); f.acknowledged = true; f.previewFeedMissing = true
            val ledger = NativeTransferJournal(File(f.root.resolve("journals"), f.context.scope.accountHash + "." + f.context.scope.installationId))
            ledger.put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("savedLocalId", "saved").put("downloadBody", f.grant)
                .put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject()))
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.count(engine, "previewReady") == 1 }
            assertEquals(0, f.downloads)
            assertEquals(0, f.saves)
            assertEquals(0, f.receipts)
        }
    }

    @Test fun `a suspended download does not block an outgoing original or gallery status`() {
        Fixture().use { f ->
            f.discover = true; f.receiveWhileSending = true; f.previewFeed = true
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalDownloadHook = { entered.countDown(); check(release.await(8, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                f.await { f.commits == 1 }
                val snapshot = engine.snapshot().get(1, TimeUnit.SECONDS)
                assertEquals(1, (snapshot["sync"] as Map<*, *>)["downloadsActive"])
                assertEquals(0, f.receipts)
            } finally { release.countDown() }
            f.await { f.receipts == 1 }
            assertArrayEquals(f.source, f.saved)
        }
    }
    @Test fun `activation uses the available network after the retired wifi policy or sign out`() {
        Fixture().use { f ->
            val engine = f.engine()
            engine.policy(true, false).get(5, TimeUnit.SECONDS)
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["cellularAllowed"])
            assertTrue(f.connectionPolicies.isNotEmpty())
            assertTrue(f.connectionPolicies.all { it })
            f.stop(engine)
            assertEquals(true, engine.snapshot().get(5, TimeUnit.SECONDS)["paused"])
        }
    }
    @Test fun `leaving acknowledges final discovery only after outgoing original commits`() {
        Fixture().use { f ->
            f.discover = true; f.participation = "LEAVING"
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.drains > 0 }
            assertEquals(1, f.commits)
            assertEquals(2, f.uploads)
        }
    }
    @Test fun `gallery failure cannot prevent acknowledging finished outgoing sync`() {
        Fixture().use { f ->
            f.discover = true; f.participation = "LEAVING"; f.previewFeedMissing = true
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.drains > 0 }
            assertTrue(f.previewFeedFailures > 0)
            assertEquals(1, f.commits)
            assertEquals(2, f.uploads)
        }
    }
    @Test fun `completed departure stops before another gallery request`() {
        Fixture().use { f ->
            f.participation = "LEAVING"; f.acknowledged = true; f.leaveAfterDrain = true
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.drains > 0 }
            assertEquals(0, f.previewFeedReads)
        }
    }
    @Test fun `refreshing an active projection does not cancel the current upload`() {
        Fixture().use { f ->
            f.discover = true
            val engine = f.engine()
            f.originalUploadHook = { f.originalUploadHook = null; engine.activate() }
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.commits == 1 }
            assertEquals(2, f.uploads)
        }
    }
    @Test fun `capture rejected after a pause race stays private without blocking the journal`() {
        Fixture().use { f ->
            f.discover = true; f.rejectCapture = true
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.rejectedCaptures > 0 && f.count(engine, "discovered") == 0 }
            f.stop(engine)
            assertEquals(0, f.uploads)
            assertEquals(0, f.commits)
            assertEquals(0, f.count(engine, "originalsSaved"))
        }
    }

    @Test fun `named trip delivery saves one exact original and never copies a source capture into the album`() {
        Fixture().use { f ->
            val registry = NativeTripAlbumRegistry(f.root.resolve("journals"))
            registry.register(f.context.scope, f.context.metadata, "Jodhpur Wedding")
            f.albums = registry
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "READY" }
            assertEquals(registry.resolve(f.context.scope, f.context.metadata).relativePath, f.savedPath)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertArrayEquals(f.source, f.saved)
            assertEquals(1, f.verifiedLocalIds.count { it == "saved" }, "a final-path save uses its existing verified-save checkpoint")
            assertEquals(0, f.organizationCalls)
            assertEquals("READY", (engine.snapshot().get()["photoOrganization"] as Map<*, *>)["state"])
            f.stop(engine)
        }
    }

    @Test fun `album repair failure remains visible while verified original receipt and completion stay successful`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf(); f.organizationFails = true
            val registry = NativeTripAlbumRegistry(f.root.resolve("journals"))
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "FAILED" }
            assertTrue(f.persistedWork()!!.getBoolean("complete"))
            assertEquals(1, f.receipts); assertEquals(0, f.saves); assertEquals(0, f.downloads)
            val snapshot = engine.snapshot().get()
            assertEquals(emptyList<String>(), snapshot["blockers"])
            assertEquals(mapOf("state" to "FAILED", "pendingCount" to 0, "failedCount" to 1), snapshot["photoOrganization"])
            f.organizationFails = false
            engine.reconcileNow().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "READY" }
            assertEquals(1, f.receipts); assertEquals(0, f.saves); assertEquals(0, f.downloads)
            assertEquals(registry.resolve(f.context.scope, f.context.metadata).relativePath, f.savedPath)
            f.stop(engine)
        }
    }

    @Test fun `metadata write failure delivers to legacy folder then repairs with no second save or receipt`() {
        Fixture().use { f ->
            val root = f.root.resolve("journals")
            val directory = NativeTripAlbumPaths.directory(f.context.scope, root).apply { mkdirs() }
            val obstruction = File(directory, "album-${f.trip}.json").apply { check(mkdir()) }
            val registry = NativeTripAlbumRegistry(root)
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optBoolean("complete") == true }
            assertEquals(NativeTripAlbumPaths.LEGACY, f.savedPath)
            assertEquals("FAILED", (engine.snapshot().get()["photoOrganization"] as Map<*, *>)["state"])
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertTrue(obstruction.delete())
            engine.reconcileNow().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "READY" }
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertNotEquals(NativeTripAlbumPaths.LEGACY, f.savedPath)
            f.stop(engine)
        }
    }

    @Test fun `user moved original is preserved outside the trip album without a new image`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf(); f.savedPath = "Pictures/Favorites/"
            val registry = NativeTripAlbumRegistry(f.root.resolve("journals"))
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "USER_MANAGED" }
            assertEquals("Pictures/Favorites/", f.savedPath)
            assertEquals(1, f.receipts); assertEquals(0, f.saves); assertEquals(0, f.downloads)
            f.stop(engine)
        }
    }

    @Test fun `a journaled app-owned partial pending row is resumed before publication without treating partial bytes as a saved original`() {
        Fixture().use { f ->
            f.saved = byteArrayOf(1); f.savedPublished = false
            val directory = f.root.resolve("journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            NativeTransferJournal(directory).put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", false).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant))
            val engine = f.engine(); f.start(engine)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertTrue(f.savedPublished); assertArrayEquals(f.source, f.saved)
            assertTrue(f.persistedWork()!!.getBoolean("complete"))
        }
    }

    @Test fun `seven day retention removes only expired album metadata and never gallery originals`() {
        Fixture().use { f ->
            val expiredId = "01990000-0000-7000-8000-000000000099"
            val registry = NativeTripAlbumRegistry(f.root.resolve("journals"))
            val old = f.context.metadata.copy(tripId = expiredId, startsAt = "2020-01-01T00:00:00Z", endsAt = "2020-01-02T00:00:00Z")
            registry.register(f.context.scope, old, "Old Wedding")
            f.albums = registry; f.saved = f.source.copyOf()
            f.retentionTrips = listOf(NativeExpiredTrip(f.context.scope, expiredId, Instant.parse("2020-01-09T00:00:00Z")))
            val directory = NativeTripAlbumPaths.directory(f.context.scope, f.root.resolve("journals"))
            assertNotNull(NativeTripAlbumStore(directory).read(expiredId))
            val engine = f.engine(); f.start(engine)
            assertNull(NativeTripAlbumStore(directory).read(expiredId))
            assertArrayEquals(f.source, f.saved)
            assertEquals(0, f.saves); assertEquals(0, f.downloads)
        }
    }

    @Test fun `account erasure clears scoped album metadata and pending presentation memory while preserving saved originals`() {
        Fixture().use { f ->
            val registry = NativeTripAlbumRegistry(f.root.resolve("journals"))
            registry.register(f.context.scope, f.context.metadata, "Wedding")
            f.albums = registry; f.saved = f.source.copyOf()
            val engine = f.engine(); f.start(engine)
            val directory = NativeTripAlbumPaths.directory(f.context.scope, f.root.resolve("journals"))
            assertNotNull(NativeTripAlbumStore(directory).read(f.trip))
            f.contextAvailable = false
            engine.eraseAccount(f.context.scope.accountHash).get(5, TimeUnit.SECONDS)
            assertFalse(directory.exists())
            assertEquals(NativeTripAlbumDestination(null, false, false), registry.peek(f.context.scope, f.trip))
            assertArrayEquals(f.source, f.saved)
            assertEquals(0, f.saves); assertEquals(0, f.downloads)
        }
    }

    @Test fun `headless restart retains pending and failed organization from the durable capture journal without album registry intent`() {
        for (stage in listOf("PENDING", "FAILED")) Fixture().use { f ->
            f.saved = f.source.copyOf()
            val root = f.root.resolve("journals")
            val registry = NativeTripAlbumRegistry(root); f.albums = registry
            val directory = NativeTripAlbumPaths.directory(f.context.scope, root)
            NativeTransferJournal(directory).put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant).put("photoOrganization", stage))
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            val status = engine.snapshot().get()["photoOrganization"] as Map<*, *>
            assertEquals(stage, status["state"])
            assertEquals(if (stage == "FAILED") 1 else 0, status["failedCount"])
            assertEquals(if (stage == "PENDING") 1 else 0, status["pendingCount"])
            registry.register(f.context.scope, f.context.metadata, "Wedding")
            engine.reconcileNow().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optionalString("photoOrganization") == "READY" }
            assertEquals(1, f.verifiedLocalIds.count { it == "saved" }, "only an actual move reopens image bytes")
            assertEquals(0, f.saves); assertEquals(0, f.downloads); assertEquals(0, f.receipts)
            f.stop(engine)
        }
    }

    @Test fun `rebuilt destination confirmation uses cheap inspection without trusting an old ready flag or rereading image bytes`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf(); f.verifyCorrupt = true
            val root = f.root.resolve("journals")
            val registry = NativeTripAlbumRegistry(root)
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            f.savedPath = registry.resolve(f.context.scope, f.context.metadata).relativePath!!
            val directory = NativeTripAlbumPaths.directory(f.context.scope, root)
            NativeTransferJournal(directory).put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant).put("photoOrganization", "READY").put("organizationDestination", "old-destination"))
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.inspectionHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                assertEquals("PENDING", (engine.snapshot().get()["photoOrganization"] as Map<*, *>)["state"])
                release.countDown()
                f.await { f.persistedWork()?.optionalString("organizationDestination") == photoOrganizationDestinationId(f.savedPath) }
                assertEquals("READY", (engine.snapshot().get()["photoOrganization"] as Map<*, *>)["state"])
                assertTrue(f.verifiedLocalIds.isEmpty()); assertEquals(0, f.organizationCalls)
                assertEquals(0, f.saves); assertEquals(0, f.downloads); assertEquals(0, f.receipts)
            } finally { release.countDown(); f.inspectionHook = null; f.stop(engine) }
        }
    }

    @Test fun `late folder inspection cannot confirm old organization after the account generation is paused`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf()
            val root = f.root.resolve("journals")
            val registry = NativeTripAlbumRegistry(root)
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            f.savedPath = registry.resolve(f.context.scope, f.context.metadata).relativePath!!
            NativeTransferJournal(NativeTripAlbumPaths.directory(f.context.scope, root)).put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant).put("photoOrganization", "PENDING"))
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.inspectionHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            val engine = f.engine()
            try {
                engine.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val stopped = engine.stop()
                release.countDown(); stopped.get(5, TimeUnit.SECONDS)
                assertEquals("PENDING", f.persistedWork()!!.optionalString("photoOrganization"))
                assertEquals(0, f.organizationCalls); assertTrue(f.verifiedLocalIds.isEmpty())
            } finally { release.countDown(); f.inspectionHook = null }
        }
    }

    @Test fun `dedicated album retry is trip fenced and changes no original backoff or HTTP state`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf()
            val root = f.root.resolve("journals")
            val registry = NativeTripAlbumRegistry(root)
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            val directory = NativeTripAlbumPaths.directory(f.context.scope, root)
            val journal = NativeTransferJournal(directory)
            journal.put(JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant).put("photoOrganization", "FAILED").put("organizationRetryAt", Instant.now().plusSeconds(300).toString()))
            val uploadId = "01990000-0000-4000-8000-000000000088"
            val original = JSONObject().put("workId", uploadId).put("assetId", uploadId).put("tripId", f.trip).put("sourceLocalId", "source")
                .put("capturedAt", Instant.now().toString()).put("complete", false).put("etags", JSONObject()).put("retryAttempts", 4)
                .put("nextAttemptAt", Instant.now().plusSeconds(300).toString()).put("blocker", "INTEGRITY_FAILURE")
            journal.put(original)
            val engine = f.engine()
            assertThrows(java.util.concurrent.ExecutionException::class.java) { engine.retryPhotoOrganization("01990000-0000-7000-8000-000000000099").get(5, TimeUnit.SECONDS) }
            assertEquals("FAILED", NativeTransferJournal(directory).record(f.delivery)!!.getString("photoOrganization"))
            engine.retryPhotoOrganization(f.trip).get(5, TimeUnit.SECONDS)
            assertEquals("READY", NativeTransferJournal(directory).record(f.delivery)!!.getString("photoOrganization"))
            assertEquals(original.toString(), NativeTransferJournal(directory).record(uploadId)!!.toString())
            assertTrue(engine.snapshot().get()["paused"] as Boolean)
            assertTrue(f.jsonCalls.isEmpty()); assertEquals(0, f.saves); assertEquals(0, f.downloads); assertEquals(0, f.receipts)
        }
    }

    @Test fun `queued old account album retry cannot reset a new account journal even for the same trip id`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf()
            val root = f.root.resolve("journals")
            val registry = NativeTripAlbumRegistry(root)
            registry.register(f.context.scope, f.context.metadata, "Wedding"); f.albums = registry
            val firstScope = f.context.scope
            fun savedWork() = JSONObject().put("workId", f.delivery).put("assetId", f.asset).put("tripId", f.trip)
                .put("deliveryId", f.delivery).put("capturedAt", Instant.now().toString()).put("complete", true).put("etags", JSONObject())
                .put("savedLocalId", "saved").put("downloadBody", f.grant).put("photoOrganization", "FAILED")
                .put("organizationRetryAt", Instant.now().plusSeconds(300).toString())
            NativeTransferJournal(NativeTripAlbumPaths.directory(firstScope, root)).put(savedWork())
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.inspectionHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            val fence = NativeTransferCommandFence()
            val captured = fence.current()
            val engine = f.engine()
            try {
                val holding = engine.retryPhotoOrganization(f.trip) { fence.matches(captured) }
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val queued = engine.retryPhotoOrganization(f.trip) { fence.matches(captured) }
                val next = f.context.copy(scope = NativeKeyScope("b".repeat(64), "installation-other"),
                    session = f.context.session.copy(deviceId = "01990000-0000-4000-8000-000000000077"))
                val nextDirectory = NativeTripAlbumPaths.directory(next.scope, root)
                val newWork = savedWork()
                NativeTransferJournal(nextDirectory).put(newWork)
                val before = File(nextDirectory, "journal.json").readText()
                fence.advance()
                f.context = next
                release.countDown()
                for (pending in listOf(holding, queued)) {
                    val failure = assertThrows(Exception::class.java) { pending.get(5, TimeUnit.SECONDS) }
                    assertTrue((failure.cause ?: failure) is java.util.concurrent.CancellationException)
                }
                assertEquals(before, File(nextDirectory, "journal.json").readText())
                assertEquals("FAILED", NativeTransferJournal(nextDirectory).record(f.delivery)!!.getString("photoOrganization"))
                assertEquals(0, f.organizationCalls); assertTrue(f.verifiedLocalIds.isEmpty()); assertTrue(f.jsonCalls.isEmpty())
            } finally { release.countDown(); f.inspectionHook = null }
        }
    }
    private class Fixture : AutoCloseable {
        val provider = VerifiedSodiumProvider.open()
        val crypto = NativePhotoCrypto(provider.sodium)
        val root = Files.createTempDirectory("crewroll-engine-test-").toFile()
        val trip = "01990000-0000-7000-8000-000000000001"
        val asset = "01990000-0000-4000-8000-000000000002"
        val delivery = "01990000-0000-4000-8000-000000000003"
        val key = crypto.randomKey()
        val source = ByteArray(300_001) { (it % 239).toByte() }
        var rejectCapture = false
        var rejectedCaptures = 0
        var participation = "JOINED"
        var drains = 0
        var leaveAfterDrain = false
        var previewFeedMissing = false
        var previewFeedFailures = 0
        var previewFeedReads = 0
        var discover = false
        var receiveWhileSending = false
        var receiptLost = false
        var commitLost = false
        var acknowledged = false
        var corrupt = false
        var verifyCorrupt = false
        var uploads = 0
        var commits = 0
        var downloads = 0
        var saves = 0
        var albums: NativeTripAlbumRegistry? = null
        var savedPath = NativeTripAlbumPaths.LEGACY
        var organizationFails = false
        var organizationCalls = 0
        var inspectionHook: (() -> Unit)? = null
        var receipts = 0
        val receiptCommands = java.util.concurrent.CopyOnWriteArrayList<String>()
        val acceptedReceiptCommands = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
        val jsonCalls = java.util.concurrent.CopyOnWriteArrayList<String>()
        val downloadedUrls = java.util.concurrent.CopyOnWriteArrayList<String>()
        val downloadGrantCommands = java.util.concurrent.CopyOnWriteArrayList<String>()
        val verifiedLocalIds = java.util.concurrent.CopyOnWriteArrayList<String>()
        var saved: ByteArray? = null
        var savedPublished = true
        var savedHook: (() -> Unit)? = null
        var originalDownloadHook: (() -> Unit)? = null
        var originalDownloadBody: ((String, File, Long) -> Unit)? = null
        var freshDownloadUrls = false
        var originalUploadHook: (() -> Unit)? = null
        var downloadGrantHook: ((NativeMediaContext) -> Unit)? = null
        var savedReceiptHook: ((NativeMediaContext) -> Unit)? = null
        var pendingPage: ((String) -> JSONObject)? = null
        val pendingPaths = java.util.concurrent.CopyOnWriteArrayList<String>()
        var previewFeed = false
        var previewPublications = 0
        @Volatile var retentionCandidateCurrent = true
        @Volatile var retentionTrips = emptyList<NativeExpiredTrip>()
        val purgedTrips = java.util.concurrent.CopyOnWriteArrayList<NativeExpiredTrip>()
        @Volatile var contextAvailable = true
        var purgeHook: ((NativeExpiredTrip) -> Unit)? = null
        var retentionScanHook: (() -> Unit)? = null
        var observeHook: ((Boolean) -> Unit)? = null
        @Volatile var context = NativeMediaContext(
            NativeKeyScope("a".repeat(64), "installation-1234"),
            DeviceSessionRecord("01990000-0000-4000-8000-000000000004", "fake-native-bearer".toByteArray(), Instant.now().plusSeconds(3600), "https://crewroll.invalid"),
            ActiveTripMetadata(trip, "01990000-0000-4000-8000-000000000005", Instant.now().minusSeconds(3600).toString(), Instant.now().plusSeconds(3600).toString(), null, 1), key,
        )
        val encrypted: File
        val grant: JSONObject
        val previewGrant: JSONObject
        val engines = mutableListOf<NativePhotoTransferEngine>()
        init {
            val original = root.resolve("fixture-original").apply { writeBytes(source) }
            val preview = root.resolve("fixture-preview").apply { writeBytes(byteArrayOf(1, 2, 3)) }
            val content = crypto.randomKey()
            try {
                encrypted = root.resolve("fixture-ciphertext")
                val d = crypto.encrypt(original, encrypted, content, trip, asset, MediaVariant.ORIGINAL, "image/jpeg", 1200u, 800u)
                val p = crypto.encrypt(preview, root.resolve("fixture-preview-ciphertext"), content, trip, asset, MediaVariant.PREVIEW, "image/jpeg", 3u, 1u)
                val manifest = crypto.sealManifest(content, Instant.parse("2026-09-09T12:00:00Z"), p, d, key, trip, asset)
                grant = JSONObject().put("assetId", asset).put("deliveryId", delivery).put("encryptedManifest", b64(manifest))
                    .put("objects", JSONArray().put(JSONObject().put("variant", "ORIGINAL").put("url", "https://storage.invalid/original")
                        .put("ciphertextBytes", d.ciphertextBytes.toString()).put("checksumSha256", b64(d.ciphertextSha256))))
                previewGrant = JSONObject().put("assetId", asset).put("expiresAt", Instant.now().plusSeconds(300).toString()).put("encryptedManifest", b64(manifest))
                    .put("object", JSONObject().put("variant", "PREVIEW").put("url", "https://storage.invalid/preview").put("ciphertextBytes", p.ciphertextBytes.toString()).put("checksumSha256", b64(p.ciphertextSha256)))
            } finally { content.fill(0) }
        }
        val photos = object : NativePhotoLibraryPort {
            override fun observe(changed: (() -> Unit)?) { observeHook?.invoke(changed != null) }
            override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int) =
                if (discover && "source" !in excluding) listOf(DiscoveredPhoto("source", Instant.parse("2026-09-09T12:00:00Z"))) else emptyList()
            override fun exportOriginal(localId: String, destination: File): PhotoMetadata {
                destination.writeBytes(source); return PhotoMetadata("image/jpeg", 1200u, 800u)
            }
            override fun preview(source: File, destination: File): PhotoMetadata {
                destination.writeBytes(byteArrayOf(1, 2, 3)); return PhotoMetadata("image/jpeg", 3u, 1u)
            }
            override fun findSaved(assetId: String) = if (saved == null || !savedPublished) null else "saved"
            override fun isPublished(localId: String): Boolean {
                if (localId == "saved" && saved == null) throw PhotoLibraryException("SOURCE_MISSING")
                return localId != "saved" || savedPublished
            }
            override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, relativePath: String, allocated: (String) -> Unit): String {
                allocated("saved"); saves++; savedPath = relativePath; saved = source.readBytes(); savedPublished = true; savedHook?.invoke(); return "saved"
            }
            override fun organizeSaved(localId: String, relativePath: String): PhotoOrganizationResult {
                organizationCalls++
                if (organizationFails) throw IOException("folder unavailable")
                if (savedPath != NativeTripAlbumPaths.LEGACY && savedPath != relativePath) return PhotoOrganizationResult.USER_MANAGED
                savedPath = relativePath
                return PhotoOrganizationResult.ORGANIZED
            }
            override fun inspectOrganization(localId: String, relativePath: String): NativePhotoOrganizationAction {
                inspectionHook?.invoke()
                return when {
                    savedPath == relativePath -> NativePhotoOrganizationAction.ALREADY_ORGANIZED
                    savedPath != NativeTripAlbumPaths.LEGACY -> NativePhotoOrganizationAction.USER_MANAGED
                    else -> NativePhotoOrganizationAction.MOVE
                }
            }
            override fun verify(localId: String, bytes: Long, checksum: ByteArray) {
                val actual = if (localId == "source") source else saved ?: throw PhotoLibraryException("SOURCE_MISSING")
                if (verifyCorrupt || actual.size.toLong() != bytes || !MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(actual), checksum)) throw PhotoLibraryException("INTEGRITY_FAILURE")
                verifiedLocalIds.add(localId)
            }
        }
        val network = object : NativePhotoTransportPort {
            override fun cancel() = Unit
            override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject = when {
                path.endsWith("/transfer-state") -> JSONObject().put("tripId", trip).put("version", 1).put("participation", participation).put("captureUntil", context.metadata.endsAt).put("excludedCaptureWindows", JSONArray().apply { if (rejectedCaptures > 0) put(JSONObject().put("from", "2000-01-01T00:00:00Z").put("until", JSONObject.NULL)) })
                path.endsWith("/drained") -> {
                    assertEquals(1, body!!.getInt("observedVersion"))
                    if (discover) assertEquals(1, commits)
                    drains++
                    if (leaveAfterDrain) participation = "LEFT"
                    JSONObject().put("tripId", trip).put("version", 1).put("participation", participation)
                        .put("captureUntil", context.metadata.endsAt).put("excludedCaptureWindows", JSONArray())
                }
                path.contains("/previews?after=") -> {
                    previewFeedReads++
                    if (previewFeedMissing) { previewFeedFailures++; throw TransferHttpException(404, true) }
                    JSONObject().put("hasMore", false).put("nextCursor", if (previewFeed) "1" else "0").put("items", JSONArray().apply {
                    if (previewFeed && path.endsWith("after=0")) put(JSONObject().put("sequence", "1").put("assetId", asset).put("sourceDeviceId", "another-device").put("publishedAt", "2026-09-09T12:00:00Z").put("download", previewGrant))
                })
                }
                path.endsWith("/preview") && method == "POST" -> { previewPublications++; JSONObject() }
                path.endsWith("/preview") -> if (previewFeed) JSONObject(previewGrant.toString()) else throw IOException("preview unavailable in legacy fixture")
                path.startsWith("/v1/deliveries/pending") -> {
                    pendingPaths.add(path)
                    pendingPage?.invoke(path) ?: JSONObject().put("items", JSONArray().apply {
                        if ((!discover || receiveWhileSending) && !acknowledged) put(JSONObject().put("tripId", trip).put("assetId", asset).put("deliveryId", delivery).put("committedAt", "2026-09-09T12:00:00Z"))
                    })
                }
                path.endsWith("download-session") -> {
                    downloadGrantHook?.invoke(context); downloadGrantCommands.add(commandId)
                    JSONObject(grant.toString()).also {
                        if (freshDownloadUrls) it.getJSONArray("objects").getJSONObject(0).put("url", "https://storage.invalid/original?grant=${downloadGrantCommands.size}")
                    }
                }
                path.endsWith("saved-receipt") -> {
                    savedReceiptHook?.invoke(context)
                    assertEquals("/v1/deliveries/$delivery/saved-receipt", path)
                    assertNotNull(saved); assertArrayEquals(source, saved); receiptCommands.add(commandId); acceptedReceiptCommands.add(commandId); receipts++; acknowledged = true
                    if (receiptLost) { receiptLost = false; throw IOException("lost receipt response") }
                    JSONObject()
                }
                path.endsWith("upload-sessions") && rejectCapture -> { rejectedCaptures++; throw TransferHttpException(409, true) }
                path.endsWith("upload-sessions") -> JSONObject().put("assetId", body!!.getString("assetId")).put("uploadSessionId", "upload-1")
                    .put("objects", JSONArray(listOf("PREVIEW", "ORIGINAL").map { JSONObject().put("variant", it).put("url", "https://storage.invalid/$it").put("requiredHeaders", JSONObject()) }))
                path.endsWith("commit") -> {
                    commits++; if (commitLost) { commitLost = false; throw IOException("lost commit response") }; JSONObject()
                }
                else -> error("unexpected route $path")
            }
            override fun upload(url: String, headers: Map<String, String>, source: File): String {
                if (url.endsWith("ORIGINAL")) originalUploadHook?.invoke()
                assertTrue(source.length() >= 45); uploads++; return "etag"
            }
            override fun download(url: String, destination: File, expectedBytes: Long) {
                if (url.endsWith("preview")) { root.resolve("fixture-preview-ciphertext").copyTo(destination); return }
                originalDownloadHook?.invoke()
                downloads++; downloadedUrls.add(url)
                originalDownloadBody?.let { it(url, destination, expectedBytes); return }
                val bytes = encrypted.readBytes(); if (corrupt) bytes[30] = (bytes[30].toInt() xor 1).toByte(); destination.writeBytes(bytes)
            }
        }
        val connectionPolicies = java.util.concurrent.CopyOnWriteArrayList<Boolean>()
        fun engine(): NativePhotoTransferEngine = NativePhotoTransferEngine(root.resolve("journals"), {
            if (!contextAvailable) null else context.copy(session = context.session.copy(backgroundBearer = context.session.backgroundBearer.copyOf()), tripKey = key.copyOf())
        }, photos, crypto, { cellular ->
            connectionPolicies.add(cellular)
            object : NativePhotoTransportPort by network {
                override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject {
                    jsonCalls.add(path)
                    return network.json(path, method, body, context, commandId)
                }
            }
        }, {},
            expiredTrips = { retentionScanHook?.invoke(); retentionTrips },
            purgeTripKey = { expired, cleanup ->
                if (!retentionCandidateCurrent) false else {
                    cleanup()
                    purgeHook?.invoke(expired); purgedTrips.add(expired)
                    retentionTrips = retentionTrips.filterNot { it == expired }
                    if (expired.tripId == trip) contextAvailable = false
                    true
                }
            },
            nextRetentionDeadline = { retentionTrips.minOfOrNull { it.deadline } },
            albums = albums,
        ).also(engines::add)
        fun start(engine: NativePhotoTransferEngine) {
            val completed = if (discover) commits else receipts
            engine.activate().get(5, TimeUnit.SECONDS)
            await { (if (discover) commits else receipts) > completed || count(engine, "blocked") == 1 }
            // Await the original lane's durable write after its mocked HTTP result.
            engine.stop().get(5, TimeUnit.SECONDS)
        }
        fun await(timeoutSeconds: Long = 5, condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
            while (!condition()) { check(System.nanoTime() < deadline) { "native condition timed out" }; Thread.sleep(2) }
        }
        fun run(engine: NativePhotoTransferEngine) { engine.wake().get(5, TimeUnit.SECONDS); engine.snapshot().get(5, TimeUnit.SECONDS) }
        fun count(engine: NativePhotoTransferEngine, name: String) = (engine.snapshot().get(5, TimeUnit.SECONDS)["counts"] as Map<*, *>)[name]
        // Reopening a journal runs stage recovery/GC. While an engine is active,
        // inspect only its atomically replaced JSON file so polling cannot delete
        // the in-flight receive stage and manufacture a transport failure.
        fun persistedWork(): JSONObject? = root.resolve("journals/${context.scope.accountHash}.${context.scope.installationId}/journal.json").let {
            if (!it.isFile) null else JSONObject(it.readText()).getJSONObject("works").optJSONObject(delivery)
        }
        fun stop(engine: NativePhotoTransferEngine) { engine.stop().get(5, TimeUnit.SECONDS) }
        override fun close() {
            engines.forEach { stop(it); it.close() }; context.erase(); provider.close(); root.deleteRecursively()
        }
        private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    }
    @Test fun `a short production download backs off automatically and refreshes its grant before one verified save`() {
        Fixture().use { f ->
            f.freshDownloadUrls = true
            f.originalDownloadBody = { url, destination, expected ->
                val bytes = f.encrypted.readBytes()
                val body = if (f.downloads == 1) bytes.copyOf(635) else bytes
                NativePhotoTransport({ NativePhotoTestConnection(ByteArrayInputStream(body)) }, { true }).download(url, destination, expected)
            }
            f.savedReceiptHook = { assertTrue(f.verifiedLocalIds.contains("saved")) }
            val directory = f.root.resolve("journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            val engine = f.engine()
            engine.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optInt("retryAttempts") == 1 || f.count(engine, "blocked") == 1 }
            val waiting = f.persistedWork()!!
            assertNull(waiting.optionalString("blocker"))
            assertFalse(waiting.getBoolean("complete"))
            assertTrue(Instant.parse(waiting.getString("nextAttemptAt")).isAfter(Instant.now()))
            assertEquals(0, f.saves); assertEquals(0, f.receipts)
            assertEquals("RETRYING", (engine.snapshot().get(5, TimeUnit.SECONDS)["sync"] as Map<*, *>)["state"])
            // No manual retry/reconcile/wake: the engine's scheduled backoff must resume it.
            f.await(12) { f.receipts == 1 }
            f.stop(engine)
            assertEquals(2, f.downloadGrantCommands.size)
            assertEquals(2, f.downloadedUrls.distinct().size)
            assertEquals(2, f.downloads); assertEquals(1, f.saves); assertEquals(1, f.receipts)
            assertEquals(setOf(f.delivery), f.acceptedReceiptCommands)
            assertArrayEquals(f.source, f.saved)
            assertTrue(NativeTransferJournal(directory).record(f.delivery)!!.getBoolean("complete"))
            assertTrue(directory.listFiles().orEmpty().none { it.name.startsWith("stage-") })
        }
    }

    @Test fun `restart preserves short-download backoff and a lost receipt reuses the saved photo and command`() {
        Fixture().use { f ->
            f.freshDownloadUrls = true; f.receiptLost = true
            f.originalDownloadBody = { url, destination, expected ->
                val bytes = f.encrypted.readBytes()
                NativePhotoTransport({ NativePhotoTestConnection(ByteArrayInputStream(if (f.downloads == 1) bytes.copyOf(635) else bytes)) }, { true }).download(url, destination, expected)
            }
            f.savedReceiptHook = { assertTrue(f.verifiedLocalIds.contains("saved")) }
            val directory = f.root.resolve("journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            val first = f.engine(); first.activate().get(5, TimeUnit.SECONDS)
            f.await { f.persistedWork()?.optInt("retryAttempts") == 1 || f.count(first, "blocked") == 1 }
            f.stop(first)
            val backoff = NativeTransferJournal(directory).record(f.delivery)!!
            assertNull(backoff.optionalString("blocker"))
            assertTrue(Instant.parse(backoff.getString("nextAttemptAt")).isAfter(Instant.now()))
            assertEquals(0, f.saves); assertEquals(0, f.receipts)
            val second = f.engine(); second.activate().get(5, TimeUnit.SECONDS)
            assertEquals(1, f.downloads)
            f.await(12) { f.persistedWork()?.optInt("retryAttempts") == 2 }
            f.stop(second)
            assertEquals(1, f.saves); assertEquals(1, f.receipts)
            assertEquals(2, f.downloads); assertEquals(2, f.downloadedUrls.distinct().size)
            assertFalse(NativeTransferJournal(directory).record(f.delivery)!!.getBoolean("complete"))
            val third = f.engine(); third.activate().get(5, TimeUnit.SECONDS)
            f.await(15) { f.receipts == 2 }; f.stop(third)
            assertEquals(1, f.saves); assertEquals(2, f.downloads)
            assertEquals(2, f.downloadGrantCommands.size)
            assertEquals(listOf(f.delivery, f.delivery), f.receiptCommands)
            assertEquals(setOf(f.delivery), f.acceptedReceiptCommands)
            assertArrayEquals(f.source, f.saved)
            assertTrue(NativeTransferJournal(directory).record(f.delivery)!!.getBoolean("complete"))
        }
    }

    @Test fun `production overlong and complete corrupt downloads remain blocked without save or receipt`() {
        for (overlong in listOf(true, false)) Fixture().use { f ->
            f.originalDownloadBody = { url, destination, expected ->
                val bytes = f.encrypted.readBytes().let { if (overlong) it + byteArrayOf(1) else it.apply { this[30] = (this[30].toInt() xor 1).toByte() } }
                NativePhotoTransport({ NativePhotoTestConnection(ByteArrayInputStream(bytes)) }, { true }).download(url, destination, expected)
            }
            val engine = f.engine(); f.start(engine)
            assertEquals(listOf("INTEGRITY_FAILURE"), engine.snapshot().get(5, TimeUnit.SECONDS)["blockers"])
            assertEquals(0, f.saves); assertEquals(0, f.receipts)
            assertTrue(f.acceptedReceiptCommands.isEmpty())
            assertEquals(1, f.downloads)
            assertEquals(1, f.downloadGrantCommands.size)
        }
    }

    @Test fun `receiver verifies exact bytes and replays lost receipt after restart without saving again`() {
        Fixture().use { f ->
            f.receiptLost = true
            val first = f.engine(); f.start(first)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertEquals(0, f.count(first, "originalsSaved")); f.stop(first)
            val second = f.engine(); f.start(second)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(2, f.receipts)
            assertEquals(1, f.count(second, "originalsSaved")); assertArrayEquals(f.source, f.saved)
        }
    }
    @Test fun `an existing saved original restores its durable gallery reference after journal loss`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.savedHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            f.previewFeedMissing = true
            val first = f.engine()
            try {
                first.activate().get(5, TimeUnit.SECONDS)
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val stopped = first.stop()
                release.countDown(); stopped.get(5, TimeUnit.SECONDS)
                assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(0, f.receipts)
            } finally { release.countDown() }
            f.savedHook = null

            // OS Photos survives lost app-private state. The server still has
            // the unacknowledged delivery, so recovery must recognize the photo.
            val directory = File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            assertTrue(directory.deleteRecursively())
            var localAtReceipt: String? = null
            f.savedReceiptHook = { localAtReceipt = NativeTransferJournal(directory).record(f.delivery)?.optionalString("savedLocalId") }
            val second = f.engine(); f.start(second)
            val recovered = NativeTransferJournal(directory).record(f.delivery)!!
            assertEquals("saved", localAtReceipt)
            assertEquals("saved", recovered.getString("savedLocalId"))
            assertTrue(recovered.getBoolean("complete"))
            assertEquals(f.asset, recovered.getString("assetId"))
            assertEquals(listOf(f.delivery), f.receiptCommands)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
            assertArrayEquals(f.source, f.saved)
            // Reopen the journal rather than relying on the receive worker's
            // in-memory value. No server preview is available to hide the loss.
            val third = f.engine()
            third.activate().get(5, TimeUnit.SECONDS)
            f.await { f.count(third, "previewReady") == 1 }
            val items = third.assets(10, null).get(5, TimeUnit.SECONDS)["items"] as List<*>
            val photo = items.single() as Map<*, *>
            assertEquals(f.asset, photo["assetId"])
            assertEquals("SAVED", photo["originalStage"])
            assertEquals("SAVED", photo["previewStage"])
            assertTrue((photo["previewUri"] as String).startsWith("file:///"))
            assertEquals(listOf(f.delivery), f.receiptCommands)
            assertEquals(1, f.saves); assertEquals(1, f.downloads); assertEquals(1, f.receipts)
        }
    }
    @Test fun `an existing photo with invalid bytes is neither journalled as saved nor acknowledged`() {
        Fixture().use { f ->
            f.saved = f.source.copyOf().apply { this[0] = (this[0].toInt() xor 1).toByte() }
            val engine = f.engine(); f.start(engine)
            val directory = File(f.root, "journals/${f.context.scope.accountHash}.${f.context.scope.installationId}")
            val work = NativeTransferJournal(directory).record(f.delivery)!!
            assertNull(work.optionalString("savedLocalId"))
            assertFalse(work.getBoolean("complete"))
            assertEquals("INTEGRITY_FAILURE", work.getString("blocker"))
            assertEquals(0, f.saves); assertEquals(0, f.downloads); assertEquals(0, f.receipts)
        }
    }
    @Test fun `lost commit response retries from journal without reencrypting or uploading again`() {
        Fixture().use { f ->
            f.discover = true; f.commitLost = true
            val first = f.engine(); f.start(first)
            assertEquals(2, f.uploads); assertEquals(1, f.commits); f.stop(first)
            val second = f.engine(); f.start(second)
            assertEquals(2, f.uploads); assertEquals(2, f.commits); assertEquals(1, f.count(second, "originalsSaved"))
            assertFalse(f.root.resolve("journals").walkTopDown().any { it.name.endsWith(".plaintext") || it.name == "original.ciphertext" })
        }
    }
    @Test fun `corrupt incoming ciphertext cannot be saved or acknowledged and explicit retry recovers`() {
        Fixture().use { f ->
            f.corrupt = true; val engine = f.engine(); f.start(engine)
            assertEquals(0, f.saves); assertEquals(0, f.receipts); assertEquals(1, f.count(engine, "blocked"))
            assertEquals(listOf("INTEGRITY_FAILURE"), engine.snapshot().get()["blockers"])
            assertFalse(f.root.resolve("journals").walkTopDown().any { it.name.endsWith(".plaintext") })
            f.corrupt = false; engine.activate().get(5, TimeUnit.SECONDS); engine.retry(f.delivery).get(5, TimeUnit.SECONDS)
            f.await { f.receipts == 1 }
            assertEquals(1, f.saves); assertEquals(1, f.receipts); assertEquals(1, f.count(engine, "originalsSaved"))
        }
    }
    @Test fun `post-save verification failure never acknowledges`() {
        Fixture().use { f ->
            f.verifyCorrupt = true; val engine = f.engine(); f.start(engine)
            assertEquals(1, f.saves); assertEquals(0, f.receipts); assertEquals(1, f.count(engine, "blocked"))
        }
    }
    @Test fun `pause waits for an in-flight save and fences its receipt then resume reuses saved bytes`() {
        Fixture().use { f ->
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.savedHook = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                val stopped = engine.stop(); assertFalse(stopped.isDone)
                release.countDown(); stopped.get(5, TimeUnit.SECONDS)
                assertEquals(0, f.receipts); assertEquals(1, f.saves)
                f.savedHook = null; f.start(engine)
                assertEquals(1, f.saves); assertEquals(1, f.receipts)
            } finally { release.countDown() }
        }
    }
    @Test fun `journal rejects unsafe persisted staging paths before recovery`() {
        val root = Files.createTempDirectory("crewroll-journal-test-").toFile()
        try {
            root.resolve("journal.json").writeText(JSONObject().put("revision", 1).put("works", JSONObject().put("bad", JSONObject().put("directory", "../outside"))).toString())
            assertThrows(IllegalArgumentException::class.java) { NativeTransferJournal(root) }
        } finally { root.deleteRecursively() }
    }
    @Test fun `preview and status remain available while an original download is stalled`() {
        Fixture().use { f ->
            f.previewFeed = true
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalDownloadHook = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                f.await { engine.assets(20, null).get(250, TimeUnit.MILLISECONDS)["items"].let { rows -> (rows as List<*>).any { (it as Map<*, *>)["previewUri"] != null } } }
                val snapshot = engine.snapshot().get(250, TimeUnit.MILLISECONDS)
                assertEquals(1, (snapshot["counts"] as Map<*, *>)["previewReady"])
                assertEquals(0, (snapshot["counts"] as Map<*, *>)["originalsSaved"])
                assertEquals(0, f.receipts); assertEquals(0, f.saves)
                val stopped = engine.stop(); assertFalse(stopped.isDone)
                release.countDown(); stopped.get(5, TimeUnit.SECONDS)
                assertEquals(0, f.receipts)
                assertFalse(f.root.resolve("journals").walkTopDown().any { it.name == "preview.jpg" })
            } finally { release.countDown() }
        }
    }
    @Test fun `sender publishes its preview before starting the original upload`() {
        Fixture().use { f ->
            f.discover = true
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            f.originalUploadHook = { entered.countDown(); check(release.await(10, TimeUnit.SECONDS)) }
            val engine = f.engine(); engine.activate().get(5, TimeUnit.SECONDS)
            try {
                assertTrue(entered.await(5, TimeUnit.SECONDS))
                assertEquals(1, f.previewPublications); assertEquals(0, f.commits)
                f.await { f.count(engine, "previewReady") == 1 }
                assertEquals(0, f.count(engine, "originalsSaved"))
            } finally { release.countDown() }
        }
    }
}
