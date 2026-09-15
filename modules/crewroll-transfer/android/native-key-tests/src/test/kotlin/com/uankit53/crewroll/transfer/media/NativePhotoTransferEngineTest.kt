package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.crypto.VerifiedSodiumProvider
import com.uankit53.crewroll.transfer.identitykeys.*
import java.io.File
import java.io.IOException
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
    private class Fixture : AutoCloseable {
        val provider = VerifiedSodiumProvider.open()
        val crypto = NativePhotoCrypto(provider.sodium)
        val root = Files.createTempDirectory("crewroll-engine-test-").toFile()
        val trip = "01990000-0000-7000-8000-000000000001"
        val asset = "01990000-0000-4000-8000-000000000002"
        val delivery = "01990000-0000-4000-8000-000000000003"
        val key = crypto.randomKey()
        val source = ByteArray(300_001) { (it % 239).toByte() }
        var discover = false
        var receiptLost = false
        var commitLost = false
        var acknowledged = false
        var corrupt = false
        var verifyCorrupt = false
        var uploads = 0
        var commits = 0
        var downloads = 0
        var saves = 0
        var receipts = 0
        var saved: ByteArray? = null
        var savedHook: (() -> Unit)? = null
        var originalDownloadHook: (() -> Unit)? = null
        var originalUploadHook: (() -> Unit)? = null
        var previewFeed = false
        var previewPublications = 0
        val context = NativeMediaContext(
            NativeKeyScope("a".repeat(64), "installation-1234"),
            DeviceSessionRecord("01990000-0000-4000-8000-000000000004", "fake-native-bearer".toByteArray(), Instant.now().plusSeconds(3600), "https://crewroll.invalid"),
            ActiveTripMetadata(trip, "01990000-0000-4000-8000-000000000005", "2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z", null, 1), key,
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
            override fun observe(changed: (() -> Unit)?) = Unit
            override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int) =
                if (discover && "source" !in excluding) listOf(DiscoveredPhoto("source", Instant.parse("2026-09-09T12:00:00Z"))) else emptyList()
            override fun exportOriginal(localId: String, destination: File): PhotoMetadata {
                destination.writeBytes(source); return PhotoMetadata("image/jpeg", 1200u, 800u)
            }
            override fun preview(source: File, destination: File): PhotoMetadata {
                destination.writeBytes(byteArrayOf(1, 2, 3)); return PhotoMetadata("image/jpeg", 3u, 1u)
            }
            override fun findSaved(assetId: String) = if (saved == null) null else "saved"
            override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, allocated: (String) -> Unit): String {
                allocated("saved"); saves++; saved = source.readBytes(); savedHook?.invoke(); return "saved"
            }
            override fun verify(localId: String, bytes: Long, checksum: ByteArray) {
                val actual = if (localId == "source") source else saved ?: throw PhotoLibraryException("SOURCE_MISSING")
                if (verifyCorrupt || actual.size.toLong() != bytes || !MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(actual), checksum)) throw PhotoLibraryException("INTEGRITY_FAILURE")
            }
        }
        val network = object : NativePhotoTransportPort {
            override fun cancel() = Unit
            override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject = when {
                path.contains("/previews?after=") -> JSONObject().put("hasMore", false).put("nextCursor", if (previewFeed) "1" else "0").put("items", JSONArray().apply {
                    if (previewFeed && path.endsWith("after=0")) put(JSONObject().put("sequence", "1").put("assetId", asset).put("sourceDeviceId", "another-device").put("publishedAt", "2026-09-09T12:00:00Z").put("download", previewGrant))
                })
                path.endsWith("/preview") && method == "POST" -> { previewPublications++; JSONObject() }
                path.endsWith("/preview") -> if (previewFeed) JSONObject(previewGrant.toString()) else throw IOException("preview unavailable in legacy fixture")
                path == "/v1/deliveries/pending" -> JSONObject().put("items", JSONArray().apply {
                    if (!discover && !acknowledged) put(JSONObject().put("tripId", trip).put("assetId", asset).put("deliveryId", delivery).put("committedAt", "2026-09-09T12:00:00Z"))
                })
                path.endsWith("download-session") -> JSONObject(grant.toString())
                path.endsWith("saved-receipt") -> {
                    assertNotNull(saved); assertArrayEquals(source, saved); receipts++; acknowledged = true
                    if (receiptLost) { receiptLost = false; throw IOException("lost receipt response") }
                    JSONObject()
                }
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
                downloads++; val bytes = encrypted.readBytes(); if (corrupt) bytes[30] = (bytes[30].toInt() xor 1).toByte(); destination.writeBytes(bytes)
            }
        }
        fun engine(): NativePhotoTransferEngine = NativePhotoTransferEngine(root.resolve("journals"), {
            context.copy(session = context.session.copy(backgroundBearer = context.session.backgroundBearer.copyOf()), tripKey = key.copyOf())
        }, photos, crypto, { network }, {}).also(engines::add)
        fun start(engine: NativePhotoTransferEngine) {
            val completed = if (discover) commits else receipts
            engine.activate().get(5, TimeUnit.SECONDS)
            await { (if (discover) commits else receipts) > completed || count(engine, "blocked") == 1 }
            // Await the original lane's durable write after its mocked HTTP result.
            engine.stop().get(5, TimeUnit.SECONDS)
        }
        fun await(condition: () -> Boolean) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!condition()) { check(System.nanoTime() < deadline) { "native condition timed out" }; Thread.sleep(2) }
        }
        fun run(engine: NativePhotoTransferEngine) { engine.wake().get(5, TimeUnit.SECONDS); engine.snapshot().get(5, TimeUnit.SECONDS) }
        fun count(engine: NativePhotoTransferEngine, name: String) = (engine.snapshot().get(5, TimeUnit.SECONDS)["counts"] as Map<*, *>)[name]
        fun stop(engine: NativePhotoTransferEngine) { engine.stop().get(5, TimeUnit.SECONDS) }
        override fun close() {
            engines.forEach { stop(it); it.close() }; context.erase(); provider.close(); root.deleteRecursively()
        }
        private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
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
