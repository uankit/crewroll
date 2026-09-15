package com.uankit53.crewroll.transfer.media

import java.nio.file.Files
import java.time.Instant
import java.util.UUID
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePreviewStoreTest {
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
