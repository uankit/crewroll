package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.transfer.identitykeys.ActiveTripMetadata
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyScope
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.File

class NativeTripAlbumStoreTest {
    private val trip = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
    private val other = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
    private val metadata = ActiveTripMetadata(trip, "018f0d98-76fa-4d1a-b4b4-1f742c2e3130", "2026-12-07T03:30:00Z", "2026-12-11T18:30:00Z", null, 1)
    private val scope = NativeKeyScope("a".repeat(64), "installation-1234")

    @Test fun `destination accepts canonical Unicode names and never contains controls traversal or overlong basenames`() {
        for (name in listOf("Jodhpur / Bikaner", "..\\/\u0000 \u202E Wedding : ? *", "शादी की यात्रा", "🧡".repeat(80), "𐐀".repeat(80))) {
            val path = NativeTripAlbumPaths.destination(trip, name, metadata.startsAt)
            assertTrue(NativeTripAlbumPaths.isDestination(path), path)
            assertTrue(path.startsWith("Pictures/CrewRoll/$trip/"))
            val basename = path.removeSuffix("/").substringAfterLast('/')
            assertTrue(basename.toByteArray(Charsets.UTF_8).size <= 160)
            assertFalse(basename.any { Character.isISOControl(it) || it == '\u202E' || it in "/\\:*?<>|" })
        }
        assertEquals("Trip", NativeTripAlbumPaths.destination(trip, "🧡".repeat(80), metadata.startsAt).substringAfter("$trip/").substringBefore(" - "))
        assertThrows(IllegalArgumentException::class.java) { NativeTripAlbumPaths.destination(trip, "a".repeat(81), metadata.startsAt) }
        assertThrows(IllegalArgumentException::class.java) { NativeTripAlbumPaths.destination(trip, "\uD800", metadata.startsAt) }
        assertFalse(NativeTripAlbumPaths.isDestination("Pictures/CrewRoll/$trip/../../camera/"))
    }

    @Test fun `concurrent registrations freeze one destination across restart renames and same-named trips`() {
        val root = Files.createTempDirectory("crewroll-albums-").toFile()
        val executor = Executors.newFixedThreadPool(4)
        try {
            val directory = NativeTripAlbumPaths.directory(scope, root)
            val tasks = (1..12).map { index -> executor.submit<String> { NativeTripAlbumStore(directory).register(metadata, "Wedding $index") } }
            val results = tasks.map { it.get(5, TimeUnit.SECONDS) }.toSet()
            assertEquals(1, results.size)
            assertEquals(results.single(), NativeTripAlbumStore(directory).read(trip))
            assertEquals(results.single(), NativeTripAlbumStore(directory).register(metadata, "Renamed trip"))
            val second = NativeTripAlbumStore(directory).register(metadata.copy(tripId = other), "Wedding 1")
            assertNotEquals(results.single(), second)
            assertEquals(2, directory.listFiles()!!.size)
            NativeTripAlbumStore(directory).purgeTrip(trip)
            assertNull(NativeTripAlbumStore(directory).read(trip))
            assertEquals(second, NativeTripAlbumStore(directory).read(other))
        } finally { executor.shutdownNow(); root.deleteRecursively() }
    }

    @Test fun `presentation I O failure does not escape registration and manual retry repairs its own metadata only`() {
        val root = Files.createTempDirectory("crewroll-album-failure-").toFile()
        try {
            val directory = NativeTripAlbumPaths.directory(scope, root)
            assertTrue(directory.mkdirs())
            val obstruction = File(directory, "album-$trip.json").apply { assertTrue(mkdir()) }
            val registry = NativeTripAlbumRegistry(root) { Instant.parse("2026-12-07T00:00:00Z") }
            registry.register(scope, metadata, "Wedding")
            assertEquals(NativeTripAlbumDestination(null, true, true), registry.peek(scope, trip))
            assertTrue(obstruction.delete())
            assertTrue(registry.resolve(scope, metadata).failed, "failed writes back off")
            registry.retry()
            val repaired = registry.resolve(scope, metadata)
            assertNotNull(repaired.relativePath); assertFalse(repaired.failed)
            val restarted = NativeTripAlbumRegistry(root).resolve(scope, metadata)
            assertEquals(repaired, restarted)
            registry.purge(scope, trip)
            assertNull(NativeTripAlbumStore(directory).read(trip))
        } finally { root.deleteRecursively() }
    }

    @Test fun `fresh authenticated registration resets only corrupt cosmetic metadata and freezes its repaired choice`() {
        val root = Files.createTempDirectory("crewroll-album-corrupt-").toFile()
        try {
            val directory = NativeTripAlbumPaths.directory(scope, root).apply { mkdirs() }
            File(directory, "album-$trip.json").writeText("{\"protocolVersion\":1,\"tripId\":\"$trip\",\"relativePath\":\"DCIM/Camera/\"}")
            val registry = NativeTripAlbumRegistry(root)
            registry.register(scope, metadata, "Wedding")
            val repaired = registry.resolve(scope, metadata)
            assertFalse(repaired.failed)
            assertNotNull(repaired.relativePath)
            assertEquals(1, directory.listFiles()!!.size)
            registry.register(scope, metadata, "A later rename")
            assertEquals(repaired, registry.resolve(scope, metadata))
        } finally { root.deleteRecursively() }
    }
}
