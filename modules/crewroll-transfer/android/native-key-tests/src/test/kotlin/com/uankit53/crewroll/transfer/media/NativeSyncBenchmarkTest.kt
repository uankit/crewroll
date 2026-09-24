package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.crypto.VerifiedSodiumProvider
import com.uankit53.crewroll.transfer.identitykeys.*
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** Real engine, journal, crypto and receipt verification; deterministic transport
 * delay. This measures a concurrency trial, not internet or physical-phone speed. */
class NativeSyncBenchmarkTest {
    @Test fun `100 off-page blocked photos drain with bounded concurrency and responsive snapshots`() {
        val results = JSONArray()
        for (limit in 1..2) results.put(run(limit))
        System.getenv("CREWROLL_SYNC_BENCHMARK_DIR")?.let {
            File(it).apply { mkdirs() }.resolve("native-download-concurrency.json").writeText(JSONObject()
                .put("kind", "native-engine controlled transport comparison")
                .put("networkDelayPerOriginalMs", 40).put("photos", 100).put("runs", results).toString(2))
        }
        assertEquals(1, results.getJSONObject(0).getInt("peakDownloads"))
        assertEquals(2, results.getJSONObject(1).getInt("peakDownloads"))
    }
    private fun run(limit: Int): JSONObject {
        val root = Files.createTempDirectory("crewroll-sync-benchmark-").toFile()
        val provider = VerifiedSodiumProvider.open()
        val crypto = NativePhotoCrypto(provider.sodium)
        val trip = UUID.randomUUID().toString(); val key = crypto.randomKey()
        val captured = Instant.now().minusSeconds(60)
        val context = NativeMediaContext(NativeKeyScope("b".repeat(64), "benchmark-install"),
            DeviceSessionRecord(UUID.randomUUID().toString(), "test-bearer".toByteArray(), Instant.now().plusSeconds(3600), "https://api.example"),
            ActiveTripMetadata(trip, UUID.randomUUID().toString(), captured.minusSeconds(60).toString(), captured.plusSeconds(3600).toString(), null, 1), key)
        val payload = ByteArray(32_768) { (it % 239).toByte() }
        val hash = MessageDigest.getInstance("SHA-256").digest(payload)
        val plain = File(root, "source").apply { writeBytes(payload) }
        val preview = File(root, "preview").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val grants = mutableMapOf<String, JSONObject>(); val cipher = mutableMapOf<String, File>()
        val saved = ConcurrentHashMap<String, ByteArray>(); val received = ConcurrentHashMap.newKeySet<String>()
        val active = AtomicInteger(); val peak = AtomicInteger(); val saves = AtomicInteger()
        val journalRoot = File(root, "journals")
        val journal = NativeTransferJournal(File(journalRoot, context.scope.accountHash + "." + context.scope.installationId))
        repeat(100) { index ->
            val asset = UUID.randomUUID().toString(); val content = crypto.randomKey()
            try {
                val originalFile = File(root, "cipher-$asset")
                val o = crypto.encrypt(plain, originalFile, content, trip, asset, MediaVariant.ORIGINAL, "image/jpeg", 320u, 240u)
                val p = crypto.encrypt(preview, File(root, "preview-$asset"), content, trip, asset, MediaVariant.PREVIEW, "image/jpeg", 3u, 1u)
                cipher[asset] = originalFile
                grants[asset] = JSONObject().put("assetId", asset).put("deliveryId", asset)
                    .put("encryptedManifest", b64(crypto.sealManifest(content, captured, p, o, key, trip, asset)))
                    .put("objects", JSONArray().put(JSONObject().put("variant", "ORIGINAL").put("url", "https://objects.example/$asset")
                        .put("ciphertextBytes", o.ciphertextBytes.toString()).put("checksumSha256", b64(o.ciphertextSha256))))
                journal.put(JSONObject().put("workId", asset).put("assetId", asset).put("deliveryId", asset).put("tripId", trip)
                    .put("capturedAt", captured.plusMillis(index.toLong()).toString()).put("complete", false).put("etags", JSONObject()).put("blocker", "STORAGE_FULL"))
            } finally { content.fill(0) }
        }
        val photos = object : NativePhotoLibraryPort {
            override fun observe(changed: (() -> Unit)?) {}
            override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int) = emptyList<DiscoveredPhoto>()
            override fun exportOriginal(localId: String, destination: File): PhotoMetadata {
                destination.writeBytes(saved[localId] ?: error("missing saved original")); return PhotoMetadata("image/jpeg", 320u, 240u)
            }
            override fun preview(source: File, destination: File): PhotoMetadata {
                destination.writeBytes(byteArrayOf(1, 2, 3)); return PhotoMetadata("image/jpeg", 3u, 1u)
            }
            override fun findSaved(assetId: String): String? = assetId.takeIf { saved.containsKey(it) }
            override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, allocated: (String) -> Unit): String {
                allocated(assetId); assertNull(saved.putIfAbsent(assetId, source.readBytes())); saves.incrementAndGet(); return assetId
            }
            override fun verify(localId: String, bytes: Long, checksum: ByteArray) {
                assertArrayEquals(hash, checksum); assertArrayEquals(payload, saved[localId]); assertEquals(payload.size.toLong(), bytes)
            }
        }
        val engine = NativePhotoTransferEngine(journalRoot, {
            context.copy(session = context.session.copy(backgroundBearer = context.session.backgroundBearer.copyOf()), tripKey = key.copyOf())
        }, photos, crypto, { _ -> object : NativePhotoTransportPort {
            override fun cancel() {}
            override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject = when {
                path.endsWith("transfer-state") -> JSONObject().put("tripId", trip).put("version", 1).put("participation", "JOINED").put("captureUntil", context.metadata.endsAt).put("excludedCaptureWindows", JSONArray())
                path == "/v1/deliveries/pending" -> JSONObject().put("items", JSONArray(grants.keys.filter { !received.contains(it) }.map {
                    JSONObject().put("tripId", trip).put("assetId", it).put("deliveryId", it).put("committedAt", captured.toString())
                }))
                path.endsWith("download-session") -> JSONObject(grants.getValue(path.split('/')[3]).toString())
                path.endsWith("saved-receipt") -> { val id = path.split('/')[3]; assertArrayEquals(payload, saved[id]); assertTrue(received.add(id)); JSONObject() }
                path.contains("previews?after=") -> JSONObject().put("items", JSONArray()).put("nextCursor", "0")
                else -> throw TransferHttpException(404, true)
            }
            override fun upload(url: String, headers: Map<String, String>, source: File): String = error("no upload")
            override fun download(url: String, destination: File, expectedBytes: Long) {
                val current = active.incrementAndGet(); peak.accumulateAndGet(current, ::maxOf)
                try { Thread.sleep(40); cipher.getValue(url.substringAfterLast('/')).copyTo(destination) }
                finally { active.decrementAndGet() }
            }
        } }, {}, downloadLimit = limit)
        try {
            engine.activate().get(5, TimeUnit.SECONDS)
            val started = System.nanoTime()
            engine.requestReconcile().get(1, TimeUnit.SECONDS)
            val reads = mutableListOf<Double>()
            while (received.size < 100) {
                assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(30), "backlog did not drain")
                val before = System.nanoTime()
                engine.snapshot().get(1, TimeUnit.SECONDS)
                reads.add((System.nanoTime() - before) / 1_000_000.0)
                Thread.sleep(5)
            }
            engine.stop().get(5, TimeUnit.SECONDS)
            assertEquals(100, saves.get())
            assertEquals(100, (engine.snapshot().get(1, TimeUnit.SECONDS)["counts"] as Map<*, *>)["originalsSaved"])
            reads.sort()
            return JSONObject().put("downloadLimit", limit).put("peakDownloads", peak.get()).put("durationMs", (System.nanoTime() - started) / 1_000_000.0)
                .put("snapshotP50Ms", reads[reads.size / 2]).put("snapshotP95Ms", reads[((reads.size - 1) * .95).toInt()]).put("verifiedSaves", saves.get())
        } finally { engine.stop().get(5, TimeUnit.SECONDS); engine.close(); context.erase(); provider.close(); root.deleteRecursively() }
    }
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
}
