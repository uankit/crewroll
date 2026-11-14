package com.uankit53.crewroll.transfer.media

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.UUID
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativeTransferJournalTest {
    private fun work(trip: String, id: String = UUID.randomUUID().toString()) = JSONObject()
        .put("workId", id).put("deliveryId", id).put("assetId", UUID.randomUUID().toString())
        .put("tripId", trip).put("complete", false).put("capturedAt", "2026-09-09T12:00:00Z")

    @Test fun `page admission survives restart and preserves existing failures and save checkpoints`() {
        val root = Files.createTempDirectory("crewroll-pending-page-").toFile()
        try {
            val trip = UUID.randomUUID().toString()
            val journal = NativeTransferJournal(root)
            val old = work(trip).put("blocker", "INTEGRITY_FAILURE").put("savedLocalId", "verified-save")
            journal.put(old)
            val incoming = work(trip)
            val before = journal.revision()
            val rediscovered = JSONObject(old.toString()).apply { remove("blocker"); remove("savedLocalId") }
            journal.admitPendingDeliveries(listOf(rediscovered, incoming), trip, "cGFnZTI")
            assertEquals(before + 1, journal.revision(), "one page commits with one atomic file replacement")
            journal.admitPendingDeliveries(listOf(old, incoming), trip, "cGFnZTI")
            assertEquals(before + 1, journal.revision(), "duplicate discovery must not rewrite the journal")
            val restarted = NativeTransferJournal(root)
            assertEquals("cGFnZTI", restarted.pendingDeliveryCursor(trip))
            assertEquals(2, restarted.records().size)
            assertEquals("INTEGRITY_FAILURE", restarted.record(old.getString("workId"))!!.getString("blocker"))
            assertEquals("verified-save", restarted.record(old.getString("workId"))!!.getString("savedLocalId"))
            restarted.admitPendingDeliveries(emptyList(), trip, null)
            assertNull(NativeTransferJournal(root).pendingDeliveryCursor(trip), "end of scan returns discovery to its head")
        } finally { root.deleteRecursively() }
    }

    @Test fun `failed page persistence never advances its cursor or partially admits work`() {
        val root = Files.createTempDirectory("crewroll-pending-failed-write-").toFile()
        try {
            val trip = UUID.randomUUID().toString()
            val journal = NativeTransferJournal(root)
            journal.admitPendingDeliveries(listOf(work(trip)), trip, "cGFnZTI")
            val revision = journal.revision()
            val incoming = work(trip)
            val obstruction = File(root, "journal.tmp").apply { mkdir() }
            assertThrows(IOException::class.java) { journal.admitPendingDeliveries(listOf(incoming), trip, "cGFnZTM") }
            assertEquals(revision, journal.revision())
            assertNull(journal.record(incoming.getString("workId")))
            assertEquals("cGFnZTI", NativeTransferJournal(root).pendingDeliveryCursor(trip))
            assertEquals(1, NativeTransferJournal(root).records().size)
            check(obstruction.delete())
            journal.admitPendingDeliveries(listOf(incoming), trip, "cGFnZTM")
            assertEquals(2, NativeTransferJournal(root).records().size)
            assertEquals("cGFnZTM", NativeTransferJournal(root).pendingDeliveryCursor(trip))
        } finally { root.deleteRecursively() }
    }

    @Test fun `invalid batch rejects every item without moving discovery`() {
        val root = Files.createTempDirectory("crewroll-pending-invalid-page-").toFile()
        try {
            val trip = UUID.randomUUID().toString()
            val journal = NativeTransferJournal(root)
            val valid = work(trip)
            assertThrows(IllegalArgumentException::class.java) {
                journal.admitPendingDeliveries(listOf(valid, work(UUID.randomUUID().toString())), trip, "cGFnZTI")
            }
            assertThrows(IllegalArgumentException::class.java) {
                journal.admitPendingDeliveries(listOf(valid, valid), trip, "cGFnZTI")
            }
            assertThrows(IllegalArgumentException::class.java) {
                journal.admitPendingDeliveries(listOf(valid), trip, "x".repeat(513))
            }
            assertTrue(journal.records().isEmpty())
            assertNull(journal.pendingDeliveryCursor(trip))
            assertEquals(0, journal.revision())
        } finally { root.deleteRecursively() }
    }

    @Test fun `trip purge removes a cursor without works and preserves another trip`() {
        val root = Files.createTempDirectory("crewroll-pending-purge-").toFile()
        try {
            val trip = UUID.randomUUID().toString()
            val other = UUID.randomUUID().toString()
            val journal = NativeTransferJournal(root)
            journal.admitPendingDeliveries(emptyList(), trip, "cGFnZTI")
            journal.admitPendingDeliveries(listOf(work(other)), other, "cGFnZTM")
            journal.purgeTrip(trip)
            val restarted = NativeTransferJournal(root)
            assertNull(restarted.pendingDeliveryCursor(trip))
            assertEquals("cGFnZTM", restarted.pendingDeliveryCursor(other))
            assertEquals(listOf(other), restarted.records().map { it.getString("tripId") })
        } finally { root.deleteRecursively() }
    }
}
