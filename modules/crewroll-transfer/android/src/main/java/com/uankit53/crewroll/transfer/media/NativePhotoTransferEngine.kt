package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.transfer.identitykeys.NativeMediaContext
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyException
import java.io.File
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

/** Two bounded transfer lanes; projections never wait behind bulk network I/O. */
class NativePhotoTransferEngine(
    private val root: File,
    private val contextProvider: () -> NativeMediaContext?,
    private val photos: NativePhotoLibraryPort,
    private val crypto: NativePhotoCrypto,
    private val networkFactory: (Boolean) -> NativePhotoTransportPort,
    private val invalidated: (Long) -> Unit,
) {
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "CrewRollPhotos").apply { isDaemon = true } }
    private val previewExecutor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "CrewRollPreviews").apply { isDaemon = true } }
    private val projectionExecutor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "CrewRollPhotoStatus").apply { isDaemon = true } }
    private val generation = AtomicLong()
    @Volatile private var paused = true
    @Volatile private var network: NativePhotoTransportPort? = null
    @Volatile private var previewNetwork: NativePhotoTransportPort? = null
    @Volatile private var cellular = false
    private var timer: ScheduledFuture<*>? = null
    private var previewTimer: ScheduledFuture<*>? = null
    @Volatile private var journal: NativeTransferJournal? = null
    @Volatile private var previews: NativePreviewStore? = null
    private var scope: String? = null
    @Volatile private var globalBlocker: String? = null
    @Volatile private var previewBlocker: String? = null
    private val wakeQueued = java.util.concurrent.atomic.AtomicBoolean(false)
    private val previewQueued = java.util.concurrent.atomic.AtomicBoolean(false)
    private val originalPoll = NativePollGate()
    private val previewPoll = NativePollGate()

    fun foreground(value: Boolean) {
        originalPoll.foreground(value); previewPoll.foreground(value)
        if (value) { wake(); wakePreviews() }
    }

    private fun <T> serial(action: () -> T): CompletableFuture<T> {
        val result = CompletableFuture<T>()
        executor.execute { try { result.complete(action()) } catch (error: Throwable) { result.completeExceptionally(error) } }
        return result
    }
    fun policy(pause: Boolean, cellularAllowed: Boolean): CompletableFuture<Unit> {
        val epoch = generation.incrementAndGet()
        paused = true; network?.cancel(); previewNetwork?.cancel()
        return serial {
            if (generation.get() == epoch) {
                timer?.cancel(false); timer = null; photos.observe(null)
                previewTimer?.cancel(false); previewTimer = null
                // Wait for both native lanes before acknowledging sign-out.
                previewExecutor.submit {}.get()
                if (generation.get() != epoch) return@serial
                if (pause) previews?.clearRenders()
                cellular = cellularAllowed; paused = pause
                if (!pause) {
                    photos.observe { wakePreviews() }
                    timer = executor.scheduleWithFixedDelay({ runPass() }, 1, 1, TimeUnit.SECONDS)
                    previewTimer = previewExecutor.scheduleWithFixedDelay({ previewPass() }, 1, 1, TimeUnit.SECONDS)
                    wake(); wakePreviews()
                }
            }
        }
    }
    fun activate() = policy(false, cellular)
    fun stop() = policy(true, cellular)
    fun close() { stop().whenComplete { _, _ -> executor.shutdown(); previewExecutor.shutdown(); projectionExecutor.shutdown() } }
    fun wake(): CompletableFuture<Unit> {
        if (!wakeQueued.compareAndSet(false, true)) return CompletableFuture.completedFuture(Unit)
        return serial { try { runPass() } finally { wakeQueued.set(false) } }
    }
    fun retry(id: String) = serial {
        requireUuid(id)
        journal?.record(id)?.let { it.put("blocker", JSONObject.NULL); journal!!.put(it) }
        previewExecutor.submit {
            val assetId = journal?.record(id)?.getString("assetId") ?: id
            previews?.record(assetId)?.let {
                if (it.optionalString("blocker") == "INTEGRITY_FAILURE") {
                    File(previews!!.directory(assetId), "preview.ciphertext").let { file -> if (file.exists()) check(file.delete()) }
                }
                previews!!.put(it.put("blocker", JSONObject.NULL))
            }
            previewBlocker = null
        }.get()
        globalBlocker = null; wakePreviews(); runPass()
    }
    @Synchronized private fun ledger(context: NativeMediaContext): NativeTransferJournal {
        val name = context.scope.accountHash + "." + context.scope.installationId
        if (scope != name) {
            journal = NativeTransferJournal(File(root, name)); previews = NativePreviewStore(File(root, name))
            previews!!.purgeExpired(Instant.now()); scope = name
        }
        return journal!!
    }
    private fun current(context: NativeMediaContext, epoch: Long) {
        if (paused || epoch != generation.get()) throw CancellationException()
        val actual = contextProvider() ?: throw CancellationException()
        try { if (actual.scope != context.scope || actual.metadata.tripId != context.metadata.tripId || actual.session.deviceId != context.session.deviceId) throw CancellationException() }
        finally { actual.erase() }
    }
    private fun newWork(id: String, assetId: String, tripId: String, captured: String) = JSONObject()
        .put("workId", id).put("assetId", assetId).put("tripId", tripId).put("capturedAt", captured)
        .put("complete", false).put("etags", JSONObject())
    private fun runPass() {
        if (paused || !originalPoll.allow()) return
        val epoch = generation.get()
        var context: NativeMediaContext? = null
        var transport: NativePhotoTransportPort? = null
        try {
            val c = contextProvider() ?: return; context = c
            current(c, epoch)
            val ledger = ledger(c); val n = networkFactory(cellular); transport = n; network = n
            val page = n.json("/v1/deliveries/pending", "GET", null, c, uuid()).getJSONArray("items")
            current(c, epoch); require(page.length() <= 100)
            for (index in 0 until page.length()) {
                val item = page.getJSONObject(index); if (item.getString("tripId") != c.metadata.tripId) continue
                val id = item.getString("deliveryId"); val assetId = item.getString("assetId"); requireUuid(id); requireUuid(assetId)
                if (ledger.record(id) == null) ledger.put(newWork(id, assetId, c.metadata.tripId, item.getString("committedAt")).put("deliveryId", id))
            }
            globalBlocker = null
            wakePreviews()
            val pending = ledger.records().filter { it.getString("tripId") == c.metadata.tripId && !it.getBoolean("complete") && it.isNull("blocker") }.sortedBy { it.getString("capturedAt") }
            val works = listOfNotNull(pending.firstOrNull { !it.isNull("deliveryId") }, pending.firstOrNull { !it.isNull("sourceLocalId") && it.optBoolean("previewPublished") })
            for (work in works) {
                current(c, epoch)
                try {
                    if (work.isNull("deliveryId")) publish(work, c, epoch, ledger, n) else receive(work, c, epoch, ledger, n)
                } catch (error: Throwable) {
                    current(c, epoch)
                    val code = blocker(error)
                    if (code != null) ledger.record(work.getString("workId"))?.let { ledger.put(it.put("blocker", code)) }
                    if (code == "AUTH_REVOKED") throw error
                }
                invalidated(ledger.revision())
            }
        } catch (error: Throwable) { if (epoch == generation.get()) globalBlocker = blocker(error) }
        finally { context?.erase(); transport?.cancel(); network = null }
    }
    private fun publish(work: JSONObject, c: NativeMediaContext, epoch: Long, ledger: NativeTransferJournal, n: NativePhotoTransportPort, previewOnly: Boolean = false) {
        val sourceId = work.getString("sourceLocalId"); val assetId = work.getString("assetId"); val tripId = c.metadata.tripId
        if (previewOnly && !work.getJSONObject("etags").isNull("PREVIEW") && !work.getJSONObject("etags").isNull("ORIGINAL")) {
            // The previous build may have lost a full-commit response. Its
            // idempotent commit replay must not require a new preview publish.
            work.put("previewPublished", true); ledger.put(work); return
        }
        if (work.isNull("uploadBody")) {
            val stage = File(ledger.directory, "stage-${uuid()}"); check(stage.mkdir())
            val originalFile = File(stage, "source.plaintext"); val previewFile = File(stage, "preview.plaintext")
            var published = false; var rootKey: ByteArray? = null
            try {
                val metadata = photos.exportOriginal(sourceId, originalFile); current(c, epoch)
                val previewMetadata = photos.preview(originalFile, previewFile)
                val key = crypto.randomKey(); rootKey = key
                val preview = crypto.encrypt(previewFile, File(stage, "preview.ciphertext"), key, tripId, assetId, MediaVariant.PREVIEW, previewMetadata.mime, previewMetadata.width, previewMetadata.height)
                val original = crypto.encrypt(originalFile, File(stage, "original.ciphertext"), key, tripId, assetId, MediaVariant.ORIGINAL, metadata.mime, metadata.width, metadata.height)
                val manifest = crypto.sealManifest(key, Instant.parse(work.getString("capturedAt")), preview, original, c.tripKey, tripId, assetId)
                val mac = Mac.getInstance("HmacSHA256"); mac.init(SecretKeySpec(c.tripKey, "HmacSHA256"))
                val sourceKey = "src_" + Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal("crewroll/source/v1/$tripId/$sourceId".toByteArray()))
                val body = JSONObject().put("tripId", tripId).put("assetId", assetId).put("sourceAssetKey", sourceKey)
                    .put("capturedAt", work.getString("capturedAt")).put("formatVersion", 1).put("keyEpoch", 1).put("encryptedManifest", b64(manifest))
                    .put("objects", JSONArray(listOf(preview, original).map { JSONObject().put("variant", it.variant.name).put("ciphertextBytes", it.ciphertextBytes.toString()).put("checksumSha256", b64(it.ciphertextSha256)) }))
                current(c, epoch); work.put("uploadBody", body).put("directory", stage.name); ledger.put(work); published = true
            } finally { rootKey?.fill(0); originalFile.delete(); previewFile.delete(); if (!published) stage.deleteRecursively() }
        }
        val body = work.getJSONObject("uploadBody")
        val grant = n.json("/v1/assets/upload-sessions", "POST", body, c, work.getString("workId")); current(c, epoch)
        require(grant.getString("assetId") == assetId)
        val objects = grant.getJSONArray("objects"); require(objects.length() == 2)
        for ((index, variant) in listOf("PREVIEW", "ORIGINAL").withIndex()) {
            val obj = objects.getJSONObject(index); require(obj.getString("variant") == variant)
            if (!work.getJSONObject("etags").isNull(variant) || (previewOnly && variant != "PREVIEW")) continue
            val header = obj.getJSONObject("requiredHeaders")
            val headers = header.keys().asSequence().associateWith { header.getString(it) }
            val file = File(File(ledger.directory, work.getString("directory")), variant.lowercase() + ".ciphertext")
            val etag = n.upload(obj.getString("url"), headers, file); current(c, epoch)
            work.getJSONObject("etags").put(variant, etag); ledger.put(work)
        }
        if (previewOnly) {
            n.json("/v1/assets/$assetId/preview", "POST", JSONObject().put("uploadSessionId", grant.getString("uploadSessionId")).put("etag", work.getJSONObject("etags").getString("PREVIEW")), c, work.getString("workId"))
            current(c, epoch)
            val cache = previews!!; val directory = cache.directory(assetId); check(directory.isDirectory || directory.mkdirs())
            val cipher = File(directory, "preview.ciphertext")
            if (!cipher.exists()) File(File(ledger.directory, work.getString("directory")), "preview.ciphertext").copyTo(cipher)
            val descriptor = JSONObject(body.getJSONArray("objects").getJSONObject(0).toString()).put("url", "")
            val previewGrant = JSONObject().put("assetId", assetId).put("expiresAt", Instant.now().plusSeconds(300).toString()).put("encryptedManifest", body.getString("encryptedManifest")).put("object", descriptor)
            cache.put(previewRecord(assetId, work.getString("capturedAt"), previewGrant, c))
            work.put("previewPublished", true); ledger.put(work)
            return
        }
        val manifest = crypto.openManifest(Base64.getDecoder().decode(body.getString("encryptedManifest")), c.tripKey, tripId, assetId)
        try { photos.verify(sourceId, manifest.original.plaintextBytes.toLong(), manifest.original.plaintextSha256) } finally { manifest.erase() }
        current(c, epoch)
        n.json("/v1/assets/$assetId/commit", "POST", JSONObject().put("uploadSessionId", grant.getString("uploadSessionId"))
            .put("objects", JSONArray(listOf("PREVIEW", "ORIGINAL").map { JSONObject().put("variant", it).put("etag", work.getJSONObject("etags").getString(it)) })), c, work.getString("workId"))
        current(c, epoch); work.put("complete", true); ledger.put(work)
        check(File(ledger.directory, work.getString("directory")).deleteRecursively()); work.remove("directory"); ledger.put(work)
    }
    private fun receive(work: JSONObject, c: NativeMediaContext, epoch: Long, ledger: NativeTransferJournal, n: NativePhotoTransportPort) {
        val assetId = work.getString("assetId"); val deliveryId = work.getString("deliveryId")
        // Only a published app-owned MediaStore row qualifies as already saved.
        var saved = photos.findSaved(assetId)
        if (saved == null || work.isNull("downloadBody")) {
            val grant = n.json("/v1/deliveries/$deliveryId/download-session", "POST", JSONObject().put("variants", JSONArray(listOf("ORIGINAL"))), c, work.getString("workId"))
            current(c, epoch); work.put("downloadBody", grant); ledger.put(work)
        }
        val grant = work.getJSONObject("downloadBody"); require(grant.getString("assetId") == assetId && grant.getString("deliveryId") == deliveryId)
        val manifest = crypto.openManifest(Base64.getDecoder().decode(grant.getString("encryptedManifest")), c.tripKey, c.metadata.tripId, assetId)
        try {
            val objects = grant.getJSONArray("objects"); require(objects.length() == 1)
            val obj = objects.getJSONObject(0)
            require(obj.getString("variant") == "ORIGINAL" && obj.getString("ciphertextBytes") == manifest.original.ciphertextBytes.toString() && obj.getString("checksumSha256") == b64(manifest.original.ciphertextSha256))
            if (saved == null) {
                val stage = File(ledger.directory, "stage-${uuid()}"); check(stage.mkdir())
                try {
                    val ciphertext = File(stage, "original.ciphertext"); val plaintext = File(stage, "original.plaintext")
                    n.download(obj.getString("url"), ciphertext, manifest.original.ciphertextBytes.toLong()); current(c, epoch)
                    crypto.decrypt(ciphertext, plaintext, manifest.original, manifest.contentRoot, c.metadata.tripId, assetId); current(c, epoch)
                    saved = photos.save(plaintext, assetId, manifest.capturedAtMilliseconds?.let { Instant.ofEpochMilli(it.toLong()) }, manifest.original.mime) {
                        current(c, epoch); work.put("savedLocalId", it); ledger.put(work)
                    }
                    current(c, epoch); work.put("savedLocalId", saved); ledger.put(work)
                } finally { stage.deleteRecursively() }
            }
            photos.verify(requireNotNull(saved), manifest.original.plaintextBytes.toLong(), manifest.original.plaintextSha256); current(c, epoch)
            n.json("/v1/deliveries/$deliveryId/saved-receipt", "POST", JSONObject().put("assetId", assetId).put("savedAt", Instant.now().toString()).put("engineRevision", ledger.revision()), c, work.getString("workId"))
            current(c, epoch); work.put("complete", true); ledger.put(work)
        } finally { manifest.erase() }
    }
    fun wakePreviews(): CompletableFuture<Unit> {
        if (!previewQueued.compareAndSet(false, true)) return CompletableFuture.completedFuture(Unit)
        val result = CompletableFuture<Unit>()
        previewExecutor.execute {
            try { previewPass(); result.complete(Unit) } catch (error: Throwable) { result.completeExceptionally(error) }
            finally { previewQueued.set(false) }
        }
        return result
    }
    private fun previewRecord(assetId: String, captured: String, grant: JSONObject, c: NativeMediaContext) = JSONObject()
        .put("assetId", assetId).put("tripId", c.metadata.tripId).put("capturedAt", captured)
        .put("retainUntil", Instant.parse(c.metadata.endsAt).plusSeconds(7 * 86400).toString()).put("grant", grant)
    private fun previewPass() {
        if (paused || !previewPoll.allow()) return
        val epoch = generation.get()
        var context: NativeMediaContext? = null
        var transport: NativePhotoTransportPort? = null
        try {
            val c = contextProvider() ?: return; context = c; current(c, epoch)
            val ledger = ledger(c); val cache = previews!!; val revision = ledger.revision() + cache.revision()
            try {
                cache.purgeExpired(Instant.now())
                val n = networkFactory(cellular); transport = n; previewNetwork = n
                val exclusions = ledger.records().flatMap { listOfNotNull(it.optionalString("sourceLocalId"), it.optionalString("savedLocalId")) }.toSet()
                photos.discover(Instant.parse(c.metadata.startsAt), Instant.parse(c.metadata.endsAt), exclusions, 4).forEach { photo ->
                    current(c, epoch)
                    val id = uuid(); ledger.put(newWork(id, id, c.metadata.tripId, photo.capturedAt.toString()).put("sourceLocalId", photo.localId))
                }
                previewBlocker = null
                val outgoing = ledger.records().filter { it.getString("tripId") == c.metadata.tripId && !it.isNull("sourceLocalId") && !it.getBoolean("complete") && !it.optBoolean("previewPublished") && it.isNull("blocker") }.sortedBy { it.getString("capturedAt") }.take(4)
                for (work in outgoing) {
                    try { publish(work, c, epoch, ledger, n, previewOnly = true); invalidated(ledger.revision() + cache.revision()); wake() }
                    catch (error: Throwable) {
                        current(c, epoch)
                        blocker(error)?.let { code -> ledger.record(work.getString("workId"))?.let { ledger.put(it.put("blocker", code)) } }
                    }
                }
                val after = cache.cursor(c.metadata.tripId)
                val feed = n.json("/v1/trips/${c.metadata.tripId}/previews?after=$after", "GET", null, c, uuid()); current(c, epoch)
                val items = feed.getJSONArray("items"); require(items.length() <= 20)
                val cursor = feed.getString("nextCursor")
                require(cursor.matches(Regex("0|[1-9][0-9]{0,18}")) && cursor.toLong() >= after.toLong())
                val queued = (0 until items.length()).map { items.getJSONObject(it) }.mapNotNull { item ->
                    val id = item.getString("assetId"); requireUuid(id)
                    val grant = item.getJSONObject("download"); require(grant.getString("assetId") == id)
                    if (item.getString("sourceDeviceId") == c.session.deviceId) null else previewRecord(id, item.getString("publishedAt"), grant, c)
                }
                if (cursor != after || queued.isNotEmpty()) cache.enqueue(queued, c.metadata.tripId, cursor)
                // Compatibility with old senders that publish only at full commit.
                for (work in ledger.records().filter { it.getString("tripId") == c.metadata.tripId && !it.isNull("deliveryId") && !it.getBoolean("complete") && cache.record(it.getString("assetId")) == null }.take(4)) {
                    val id = work.getString("assetId")
                    val grant = n.json("/v1/assets/$id/preview", "GET", null, c, uuid()); current(c, epoch)
                    require(grant.getString("assetId") == id)
                    cache.put(previewRecord(id, work.getString("capturedAt"), grant, c))
                }
                for (record in cache.records(c.metadata.tripId).filter { cache.render(it.getString("assetId")) == null && it.isNull("blocker") }.sortedByDescending { it.getString("capturedAt") }.take(8)) {
                    try { materializePreview(record, c, epoch, cache, n); invalidated(ledger.revision() + cache.revision()) }
                    catch (error: Throwable) { current(c, epoch); blocker(error)?.let { cache.put(record.put("blocker", it)) } }
                }
            } finally { if (revision != ledger.revision() + cache.revision()) invalidated(ledger.revision() + cache.revision()) }
        } catch (error: Throwable) { if (epoch == generation.get()) previewBlocker = blocker(error) }
        finally { context?.erase(); transport?.cancel(); previewNetwork = null }
    }
    private fun materializePreview(record: JSONObject, c: NativeMediaContext, epoch: Long, cache: NativePreviewStore, n: NativePhotoTransportPort) {
        val id = record.getString("assetId"); val directory = cache.directory(id); check(directory.isDirectory || directory.mkdirs())
        val ciphertext = File(directory, "preview.ciphertext"); val plaintext = File(directory, "preview.jpg")
        if (!ciphertext.exists() && (record.getJSONObject("grant").getJSONObject("object").getString("url").isEmpty() || !Instant.parse(record.getJSONObject("grant").getString("expiresAt")).isAfter(Instant.now()))) {
            val grant = n.json("/v1/assets/$id/preview", "GET", null, c, uuid()); current(c, epoch)
            record.put("grant", grant); cache.put(record)
        }
        val grant = record.getJSONObject("grant"); require(grant.getString("assetId") == id)
        val manifest = crypto.openManifest(Base64.getDecoder().decode(grant.getString("encryptedManifest")), c.tripKey, c.metadata.tripId, id)
        try {
            val obj = grant.getJSONObject("object")
            require(obj.getString("variant") == "PREVIEW" && obj.getString("ciphertextBytes") == manifest.preview.ciphertextBytes.toString() && obj.getString("checksumSha256") == b64(manifest.preview.ciphertextSha256))
            if (!ciphertext.exists()) n.download(obj.getString("url"), ciphertext, manifest.preview.ciphertextBytes.toLong())
            current(c, epoch)
            val pending = File(directory, "preview.pending")
            try {
                crypto.decrypt(ciphertext, pending, manifest.preview, manifest.contentRoot, c.metadata.tripId, id); current(c, epoch)
                java.nio.file.Files.move(pending.toPath(), plaintext.toPath(), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
            } catch (error: Throwable) { pending.delete(); throw error }
            record.put("readyAt", Instant.now().toString()); cache.put(record)
        } finally { manifest.erase() }
    }
    private fun <T> projection(action: () -> T): CompletableFuture<T> {
        val result = CompletableFuture<T>()
        projectionExecutor.execute { try { result.complete(action()) } catch (error: Throwable) { result.completeExceptionally(error) } }
        return result
    }
    // No bearer, key, or signed URL leaves native code. Only verified private file URIs.
    private fun projectedAssets(c: NativeMediaContext?): Pair<Long, List<Map<String, Any?>>> {
        if (c == null) return 0L to emptyList()
        val l = ledger(c); val cache = previews!!
        val works = l.records().filter { it.getString("tripId") == c.metadata.tripId }.associateBy { it.getString("assetId") }
        val images = cache.records(c.metadata.tripId).associateBy { it.getString("assetId") }
        val rows = (works.keys + images.keys).map { id ->
            val work = works[id]; val image = images[id]
            val uri = if (paused) null else cache.render(id)?.toURI()?.toASCIIString()?.replaceFirst("file:/", "file:///")
            mapOf("workId" to (work?.getString("workId") ?: id), "assetId" to id, "capturedAt" to (work ?: image)!!.getString("capturedAt"),
                "previewStage" to if (uri != null) "SAVED" else "PENDING", "previewUri" to uri,
                "originalStage" to if (work?.optBoolean("complete") == true) "SAVED" else "PENDING", "blocker" to (work?.optionalString("blocker") ?: image?.optionalString("blocker")))
        }.sortedWith(compareByDescending<Map<String, Any?>> { it["capturedAt"] as String }.thenByDescending { it["assetId"] as String })
        return (l.revision() + cache.revision()) to rows
    }
    private fun projectionFence(c: NativeMediaContext?, epoch: Long) {
        if (generation.get() != epoch) throw CancellationException()
        val actual = contextProvider()
        try { if (c?.scope != actual?.scope || c?.metadata?.tripId != actual?.metadata?.tripId) throw CancellationException() }
        finally { actual?.erase() }
    }
    fun snapshot(): CompletableFuture<Map<String, Any?>> = projection {
        val epoch = generation.get()
        val c = contextProvider()
        try {
            val (revision, rows) = projectedAssets(c)
            val blockers = if (c == null) emptyList() else (rows.mapNotNull { it["blocker"] as? String } + listOfNotNull(globalBlocker, previewBlocker)).distinct().sorted()
            projectionFence(c, epoch)
            mapOf("protocolVersion" to 1, "revision" to revision, "activeTripId" to c?.metadata?.tripId, "paused" to paused, "cellularAllowed" to cellular,
                "counts" to mapOf("discovered" to rows.size, "previewReady" to rows.count { it["previewUri"] != null }, "originalsSaved" to rows.count { it["originalStage"] == "SAVED" }, "blocked" to rows.count { it["blocker"] != null }), "blockers" to blockers)
        } finally { c?.erase() }
    }
    fun assets(limit: Int, cursor: String?): CompletableFuture<Map<String, Any?>> = projection {
        require(limit in 1..100)
        val epoch = generation.get()
        val c = contextProvider()
        try {
            val (revision, records) = projectedAssets(c)
            val offset = if (cursor == null) 0 else { val p = cursor.split('_'); require(p.size == 3 && p[0] == "page" && p[1].toLong() == revision); p[2].toInt() }
            require(offset in 0..records.size)
            val page = records.drop(offset).take(limit)
            projectionFence(c, epoch)
            mapOf("protocolVersion" to 1, "revision" to revision, "activeTripId" to c?.metadata?.tripId, "items" to page, "nextCursor" to if (offset + page.size < records.size) "page_${revision}_${offset + page.size}" else null)
        } finally { c?.erase() }
    }
    private fun blocker(error: Throwable): String? = when (error) {
        is CancellationException -> null
        is PhotoLibraryException -> error.blocker
        is SecurityException -> "PHOTO_PERMISSION"
        is CryptoReadException, is IllegalArgumentException, is org.json.JSONException -> "INTEGRITY_FAILURE"
        is NativeKeyException -> if (error.code in setOf("KEY_ACCESS_LOCKED", "KEY_MATERIAL_LOST")) error.code else "INTEGRITY_FAILURE"
        is TransferHttpException -> if (error.authenticated && error.status in setOf(401, 403)) "AUTH_REVOKED" else null
        else -> null
    }
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    private fun uuid() = UUID.randomUUID().toString()
    private fun requireUuid(id: String) { require(UUID.fromString(id).toString() == id) }
}
