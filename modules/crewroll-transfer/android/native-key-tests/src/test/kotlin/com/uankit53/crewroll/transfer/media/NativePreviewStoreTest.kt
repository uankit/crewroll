package com.uankit53.crewroll.transfer.media

import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePreviewStoreTest {
    @Test fun `authentication retry is atomic trip scoped and preserves save checkpoints and other failures`() {
        val root = Files.createTempDirectory("crewroll-auth-retry-test-").toFile()
        try {
            val trip = UUID.randomUUID().toString(); val other = UUID.randomUUID().toString()
            val journal = NativeTransferJournal(root); val previews = NativePreviewStore(root)
            val originals = mutableListOf<JSONObject>(); val records = mutableListOf<JSONObject>()
            listOf(trip to "AUTH_REVOKED", trip to "AUTH_REVOKED", trip to "INTEGRITY_FAILURE", other to "AUTH_REVOKED").forEach { (target, blocker) ->
                val id = UUID.randomUUID().toString()
                val work = JSONObject().put("workId", id).put("assetId", id).put("tripId", target).put("blocker", blocker)
                    .put("savedLocalId", "already-saved").put("downloadBody", "checkpoint").put("complete", false)
                    .put("retryAttempts", 3).put("nextAttemptAt", Instant.now().plusSeconds(60).toString())
                journal.put(work); originals.add(work)
                records.add(JSONObject().put("assetId", id).put("tripId", target).put("blocker", blocker)
                    .put("retainUntil", Instant.now().plusSeconds(60).toString()))
            }
            previews.enqueue(records.filter { it.getString("tripId") == trip }, trip, "12")
            previews.enqueue(records.filter { it.getString("tripId") == other }, other, "7")
            val originalRevision = journal.revision(); val previewRevision = previews.revision()
            journal.clearAuthenticationBlockers(trip); previews.clearAuthenticationBlockers(trip)
            assertEquals(originalRevision + 1, journal.revision()); assertEquals(previewRevision + 1, previews.revision())
            journal.clearAuthenticationBlockers(trip); previews.clearAuthenticationBlockers(trip)
            assertEquals(originalRevision + 1, journal.revision()); assertEquals(previewRevision + 1, previews.revision())
            val restarted = NativeTransferJournal(root); val restored = NativePreviewStore(root)
            originals.forEach { work ->
                val actual = restarted.record(work.getString("workId"))!!
                val expected = if (work.getString("tripId") == trip && work.getString("blocker") == "AUTH_REVOKED") null else work.getString("blocker")
                assertEquals(expected, actual.optionalString("blocker")); assertEquals(expected, restored.record(work.getString("assetId"))!!.optionalString("blocker"))
                assertEquals(work.getString("savedLocalId"), actual.getString("savedLocalId")); assertEquals(work.getString("downloadBody"), actual.getString("downloadBody"))
            }
            assertEquals("12", restored.cursor(trip)); assertEquals("7", restored.cursor(other))
        } finally { root.deleteRecursively() }
    }

    @Test fun `queue and cursor are durable and only atomically verified render files are visible`() {
        val root = Files.createTempDirectory("crewroll-preview-store-test-").toFile()
        try {
            val id = UUID.randomUUID().toString(); val trip = UUID.randomUUID().toString()
            val store = NativePreviewStore(root)
            store.enqueue(listOf(JSONObject().put("assetId", id).put("tripId", trip).put("retainUntil", Instant.now().plusSeconds(60).toString())), trip, "12")
            val directory = store.directory(id).apply { mkdirs() }
            directory.resolve("preview.ciphertext").writeBytes(byteArrayOf(1))
            directory.resolve("preview.pending").writeBytes(byteArrayOf(2))
            assertNull(store.render(id))
            val restarted = NativePreviewStore(root)
            assertEquals("12", restarted.cursor(trip)); assertEquals(1, restarted.records(trip).size)
            assertFalse(directory.resolve("preview.pending").exists())
            assertThrows(IllegalArgumentException::class.java) { restarted.enqueue(emptyList(), trip, "11") }
            assertThrows(IllegalArgumentException::class.java) { restarted.directory("../outside") }
            directory.resolve("preview.jpg").writeBytes(byteArrayOf(3))
            assertNotNull(restarted.render(id))
            restarted.clearRenders()
            assertNull(restarted.render(id)); assertTrue(directory.resolve("preview.ciphertext").exists())
            assertEquals("12", restarted.cursor(trip))
            restarted.purgeExpired(Instant.now().plusSeconds(61))
            assertFalse(directory.exists()); assertTrue(restarted.records(trip).isEmpty())
        } finally { root.deleteRecursively() }
    }
}
