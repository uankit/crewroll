package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.transfer.identitykeys.ActiveTripMetadata
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyScope
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import org.json.JSONException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.text.Normalizer
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Presentation metadata only. No image bytes, keys or album moves are stored here. */
object NativeTripAlbumPaths {
    const val LEGACY = "Pictures/CrewRoll/"
    private val tripPattern = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    fun requireTrip(tripId: String) { require(tripPattern.matches(tripId)) }
    fun canonicalName(value: String): String {
        val name = value.trim()
        val points = name.codePoints().toArray()
        require(points.size in 1..80 && points.none { it in 0xD800..0xDFFF })
        return name
    }
    fun directory(scope: NativeKeyScope, root: File): File {
        require(scope.accountHash.matches(Regex("^[a-f0-9]{64}$")))
        require(scope.installationId.matches(Regex("^[A-Za-z0-9_-]{8,128}$")))
        return File(root, "${scope.accountHash}.${scope.installationId}").also {
            require(it.canonicalFile.parentFile == root.canonicalFile)
        }
    }
    fun destination(tripId: String, tripName: String, startsAt: String): String {
        requireTrip(tripId)
        val canonical = canonicalName(tripName)
        val safe = StringBuilder()
        var bytes = 0
        for (point in Normalizer.normalize(canonical, Normalizer.Form.NFC).codePoints().toArray()) {
            val type = Character.getType(point)
            // Path punctuation, controls, bidi/format characters and symbols
            // become separators. Unicode letters and accents remain readable.
            val accepted = Character.isLetterOrDigit(point) || type == Character.NON_SPACING_MARK.toInt() ||
                type == Character.COMBINING_SPACING_MARK.toInt() || point == '-'.code || point == '_'.code
            val piece = if (accepted) String(Character.toChars(point)) else " "
            if (piece == " " && (safe.isEmpty() || safe.last() == ' ')) continue
            val count = piece.toByteArray(Charsets.UTF_8).size
            if (bytes + count > 120) break
            safe.append(piece); bytes += count
        }
        val label = safe.toString().trim().ifEmpty { "Trip" }
        val date = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC).format(Instant.parse(startsAt))
        return "$LEGACY$tripId/$label - $date/"
    }
    fun isDestination(path: String): Boolean {
        if (path == LEGACY) return true
        if (!path.startsWith(LEGACY) || !path.endsWith('/')) return false
        val parts = path.removePrefix(LEGACY).dropLast(1).split('/')
        if (parts.size != 2 || !tripPattern.matches(parts[0])) return false
        val label = parts[1]
        return label.toByteArray(Charsets.UTF_8).size <= 160 &&
            Regex("^.+ - [0-9]{4}-[0-9]{2}-[0-9]{2}$").matches(label) &&
            label.codePoints().allMatch { point -> Character.isLetterOrDigit(point) ||
                Character.getType(point) == Character.NON_SPACING_MARK.toInt() ||
                Character.getType(point) == Character.COMBINING_SPACING_MARK.toInt() || point in intArrayOf(' '.code, '-'.code, '_'.code) }
    }
}

/** First successful destination is frozen. All instances share the metadata
 * writer lock; the runtime/OS jobs already share one process and command fence. */
class NativeTripAlbumStore(private val directory: File) {
    companion object { private val writer = Any() }
    fun register(metadata: ActiveTripMetadata, tripName: String): String = synchronized(writer) {
        NativeTripAlbumPaths.requireTrip(metadata.tripId)
        val chosen = NativeTripAlbumPaths.destination(metadata.tripId, tripName, metadata.startsAt)
        val target = file(metadata.tripId)
        val existing = try { read(metadata.tripId) }
        catch (error: Exception) {
            if (error !is IllegalArgumentException && error !is JSONException) throw error
            // Only this presentation file may be reset, only after a fresh
            // authenticated registration. No photo/journal/key is touched.
            if (!target.isFile) throw IOException("Album metadata unavailable")
            check(target.delete())
            null
        }
        existing?.let { return@synchronized it }
        check(directory.isDirectory || directory.mkdirs())
        val temporary = File(directory, "album-${metadata.tripId}-${UUID.randomUUID()}.pending")
        try {
            val record = JSONObject().put("protocolVersion", 1).put("tripId", metadata.tripId).put("relativePath", chosen)
            FileOutputStream(temporary).use { it.write(record.toString().toByteArray(Charsets.UTF_8)); it.fd.sync() }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE)
            chosen
        } finally { if (temporary.exists()) check(temporary.delete()) }
    }
    fun read(tripId: String): String? = synchronized(writer) {
        val target = file(tripId)
        if (!target.exists()) return@synchronized null
        if (!target.isFile) throw IOException("Album metadata unavailable")
        require(target.length() in 1..4096)
        val record = JSONObject(target.readText(Charsets.UTF_8))
        require(record.keys().asSequence().toSet() == setOf("protocolVersion", "tripId", "relativePath"))
        require(record.get("protocolVersion") == 1 && record.getString("tripId") == tripId)
        val path = record.getString("relativePath")
        require(path.startsWith("${NativeTripAlbumPaths.LEGACY}$tripId/") && NativeTripAlbumPaths.isDestination(path))
        path
    }
    fun purgeTrip(tripId: String) = synchronized(writer) {
        file(tripId).let { if (it.exists()) check(it.delete()) }
        directory.listFiles()?.filter { it.name.startsWith("album-$tripId-") && it.name.endsWith(".pending") }?.forEach {
            require(it.canonicalFile.parentFile == directory.canonicalFile)
            check(it.delete())
        }
        Unit
    }
    private fun file(tripId: String): File {
        NativeTripAlbumPaths.requireTrip(tripId)
        return File(directory, "album-$tripId.json").also { require(it.canonicalFile.parentFile == directory.canonicalFile) }
    }
}

data class NativeTripAlbumDestination(val relativePath: String?, val requested: Boolean, val failed: Boolean)

/** Only the current unresolved presentation request is retained in memory.
 * A failed metadata write never changes crypto/session state or transport work. */
class NativeTripAlbumRegistry(private val root: File, private val now: () -> Instant = Instant::now) {
    private data class Pending(val scope: NativeKeyScope, val metadata: ActiveTripMetadata, val tripName: String)
    private var pending: Pending? = null
    private var cachedScope: NativeKeyScope? = null
    private var cachedTrip: String? = null
    private var cached = NativeTripAlbumDestination(null, false, false)
    private var retryAt: Instant? = null
    @Synchronized fun register(scope: NativeKeyScope, metadata: ActiveTripMetadata, tripName: String) {
        pending = Pending(scope, metadata, NativeTripAlbumPaths.canonicalName(tripName))
        cachedScope = scope; cachedTrip = metadata.tripId
        attempt()
    }
    private fun attempt() {
        val request = pending ?: return
        try {
            val path = NativeTripAlbumStore(NativeTripAlbumPaths.directory(request.scope, root)).register(request.metadata, request.tripName)
            cached = NativeTripAlbumDestination(path, true, false)
            pending = null; retryAt = null
        } catch (_: Exception) {
            cached = NativeTripAlbumDestination(null, true, true)
            retryAt = now().plusSeconds(30)
        }
    }
    @Synchronized fun resolve(scope: NativeKeyScope, metadata: ActiveTripMetadata): NativeTripAlbumDestination {
        if (cachedScope == scope && cachedTrip == metadata.tripId) {
            if (pending != null && retryAt?.isAfter(now()) != true) attempt()
            else if (pending == null && cached.failed && retryAt?.isAfter(now()) != true) readSaved(scope, metadata)
            return cached
        }
        cachedScope = scope; cachedTrip = metadata.tripId; pending = null; retryAt = null
        readSaved(scope, metadata)
        return cached
    }
    private fun readSaved(scope: NativeKeyScope, metadata: ActiveTripMetadata) {
        cached = try {
            val path = NativeTripAlbumStore(NativeTripAlbumPaths.directory(scope, root)).read(metadata.tripId)
            retryAt = null
            NativeTripAlbumDestination(path, path != null, false)
        } catch (_: Exception) { retryAt = now().plusSeconds(30); NativeTripAlbumDestination(null, true, true) }
    }
    @Synchronized fun peek(scope: NativeKeyScope, tripId: String): NativeTripAlbumDestination =
        if (cachedScope == scope && cachedTrip == tripId) cached else NativeTripAlbumDestination(null, false, false)
    @Synchronized fun retry() { retryAt = null }
    @Synchronized fun eraseAccount(accountHash: String) {
        if (cachedScope?.accountHash == accountHash) { pending = null; cachedTrip = null; cachedScope = null; cached = NativeTripAlbumDestination(null, false, false); retryAt = null }
    }
    @Synchronized fun purge(scope: NativeKeyScope, tripId: String) {
        NativeTripAlbumStore(NativeTripAlbumPaths.directory(scope, root)).purgeTrip(tripId)
        if (cachedScope == scope && cachedTrip == tripId) { pending = null; cachedTrip = null; cachedScope = null; cached = NativeTripAlbumDestination(null, false, false) }
    }
}
