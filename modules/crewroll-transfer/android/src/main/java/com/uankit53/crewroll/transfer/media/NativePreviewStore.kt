package com.uankit53.crewroll.transfer.media

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.util.UUID
import org.json.JSONObject

/** Account-private previews. Queue entries and their feed cursor persist atomically. */
class NativePreviewStore(directory: File) {
    val root = File(directory, "previews")
    private val file = File(root, "index.json")
    private var state: JSONObject
    init {
        check(root.isDirectory || root.mkdirs())
        state = if (file.exists()) JSONObject(file.readText()) else JSONObject().put("revision", 0).put("cursors", JSONObject()).put("records", JSONObject())
        require(state.getLong("revision") >= 0)
        root.listFiles()?.filter { it.isDirectory }?.forEach { child ->
            directory(child.name)
            if (state.getJSONObject("records").isNull(child.name)) check(child.deleteRecursively())
            else File(child, "preview.pending").let { if (it.exists()) check(it.delete()) }
        }
    }
    @Synchronized fun revision() = state.getLong("revision")
    @Synchronized fun cursor(tripId: String) = state.getJSONObject("cursors").optString(tripId, "0")
    @Synchronized fun record(id: String): JSONObject? = state.getJSONObject("records").optJSONObject(id)?.let { JSONObject(it.toString()) }
    @Synchronized fun records(tripId: String): List<JSONObject> = state.getJSONObject("records").values()
        .filter { it.getString("tripId") == tripId }.map { JSONObject(it.toString()) }
    @Synchronized fun enqueue(records: List<JSONObject>, tripId: String, cursor: String) {
        require(cursor.matches(Regex("0|[1-9][0-9]{0,18}")) && cursor.toLong() >= this.cursor(tripId).toLong())
        val next = JSONObject(state.toString())
        for (record in records) {
            val id = record.getString("assetId"); directory(id)
            require(record.getString("tripId") == tripId)
            if (next.getJSONObject("records").isNull(id)) next.getJSONObject("records").put(id, record)
        }
        next.getJSONObject("cursors").put(tripId, cursor); persist(next)
    }
    @Synchronized fun put(record: JSONObject) {
        val id = record.getString("assetId"); directory(id)
        val next = JSONObject(state.toString()); next.getJSONObject("records").put(id, JSONObject(record.toString())); persist(next)
    }
    fun directory(id: String): File {
        require(UUID.fromString(id).toString() == id)
        return File(root, id).also { require(it.canonicalFile.parentFile == root.canonicalFile) }
    }
    fun render(id: String): File? = File(directory(id), "preview.jpg").takeIf { it.isFile }
    @Synchronized fun clearRenders() {
        state.getJSONObject("records").keys().asSequence().forEach { id -> render(id)?.let { check(it.delete()) } }
    }
    @Synchronized fun purgeExpired(now: Instant) {
        val expired = state.getJSONObject("records").values().filter { !Instant.parse(it.getString("retainUntil")).isAfter(now) }
        if (expired.isEmpty()) return
        val next = JSONObject(state.toString())
        expired.forEach { record ->
            val id = record.getString("assetId"); val path = directory(id)
            if (path.exists()) check(path.deleteRecursively())
            next.getJSONObject("records").remove(id)
        }
        persist(next)
    }
    private fun persist(next: JSONObject) {
        next.put("revision", revision() + 1)
        val temporary = File(root, "index.tmp")
        FileOutputStream(temporary).use { it.write(next.toString().toByteArray()); it.fd.sync() }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        state = next
    }
}
