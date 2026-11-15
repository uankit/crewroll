package com.uankit53.crewroll.transfer.media

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

class NativeTransferJournal(val directory: File) {
    private val file = File(directory, "journal.json")
    private var state: JSONObject
    init {
        check(directory.isDirectory || directory.mkdirs())
        state = if (file.exists()) JSONObject(file.readText()) else JSONObject().put("revision", 0).put("works", JSONObject())
        require(state.getLong("revision") >= 0)
        val retained = records().mapNotNull { it.optionalString("directory") }.onEach(::validateStage).toSet()
        directory.listFiles()?.filter { it.name.startsWith("stage-") }?.forEach { stage ->
            require(stage.canonicalFile.parentFile == directory.canonicalFile)
            if (stage.name !in retained) check(stage.deleteRecursively())
            else listOf("source.plaintext", "preview.plaintext").forEach { name ->
                File(stage, name).let { if (it.exists()) check(it.delete()) }
            }
        }
    }
    @Synchronized fun revision(): Long = state.getLong("revision")
    @Synchronized fun records(): List<JSONObject> = state.getJSONObject("works").let { works ->
        works.keys().asSequence().sorted().map { JSONObject(works.getJSONObject(it).toString()) }.toList()
    }
    @Synchronized fun record(id: String): JSONObject? = state.getJSONObject("works").optJSONObject(id)?.let { JSONObject(it.toString()) }
    @Synchronized fun pendingDeliveryCursor(tripId: String): String? =
        state.optJSONObject("pendingDeliveryCursors")?.optionalString(tripId)?.also(::validatePendingCursor)
    /** Admission and discovery position commit together. A failed write can
     * repeat a page, but can never advance past an undiscovered original. */
    @Synchronized fun admitPendingDeliveries(works: List<JSONObject>, tripId: String, nextCursor: String?) {
        require(UUID.fromString(tripId).toString() == tripId)
        require(works.size <= 100)
        nextCursor?.let(::validatePendingCursor)
        val ids = mutableSetOf<String>()
        works.forEach { work ->
            val id = work.getString("workId")
            require(UUID.fromString(id).toString() == id && ids.add(id))
            require(work.getString("tripId") == tripId && work.getString("deliveryId") == id)
            require(work.isNull("sourceLocalId") && work.isNull("directory") && !work.getBoolean("complete"))
            require(UUID.fromString(work.getString("assetId")).toString() == work.getString("assetId"))
            record(id)?.let { existing ->
                require(existing.getString("tripId") == tripId && existing.getString("assetId") == work.getString("assetId") && existing.getString("deliveryId") == id)
            }
        }
        val next = JSONObject(state.toString())
        var changed = false
        works.forEach { work ->
            val id = work.getString("workId")
            if (!next.getJSONObject("works").has(id)) {
                next.getJSONObject("works").put(id, JSONObject(work.toString()))
                changed = true
            }
        }
        if (pendingDeliveryCursor(tripId) != nextCursor) {
            val cursors = next.optJSONObject("pendingDeliveryCursors") ?: JSONObject()
            if (nextCursor == null) cursors.remove(tripId) else cursors.put(tripId, nextCursor)
            if (cursors.length() == 0) next.remove("pendingDeliveryCursors") else next.put("pendingDeliveryCursors", cursors)
            changed = true
        }
        if (changed) persist(next)
    }
    @Synchronized fun put(work: JSONObject) {
        work.optionalString("directory")?.let(::validateStage)
        val next = JSONObject(state.toString())
        next.getJSONObject("works").put(work.getString("workId"), JSONObject(work.toString()))
        persist(next)
    }
    @Synchronized fun clearAuthenticationBlockers(tripId: String) {
        val blocked = records().filter { it.getString("tripId") == tripId && it.optionalString("blocker") == "AUTH_REVOKED" }
        if (blocked.isEmpty()) return
        val next = JSONObject(state.toString())
        blocked.forEach { record ->
            record.put("blocker", JSONObject.NULL).put("nextAttemptAt", JSONObject.NULL).put("retryAttempts", 0)
            next.getJSONObject("works").put(record.getString("workId"), record)
        }
        persist(next)
    }
    /** One atomic presentation-only update; transport retry/checkpoints remain
     * untouched and a large completed gallery does not cause N full rewrites. */
    @Synchronized fun retryPhotoOrganization(tripId: String) {
        require(UUID.fromString(tripId).toString() == tripId)
        val retrying = records().filter { it.getString("tripId") == tripId && !it.isNull("deliveryId") && it.optBoolean("complete") && it.optionalString("photoOrganization") == "FAILED" }
        if (retrying.isEmpty()) return
        val next = JSONObject(state.toString())
        retrying.forEach { work ->
            next.getJSONObject("works").put(work.getString("workId"), work.put("photoOrganization", "PENDING").put("organizationRetryAt", JSONObject.NULL))
        }
        persist(next)
    }
    @Synchronized fun purgeTrip(tripId: String) {
        val removed = records().filter { it.getString("tripId") == tripId }
        if (removed.isEmpty() && pendingDeliveryCursor(tripId) == null) return
        val next = JSONObject(state.toString())
        removed.forEach { work ->
            work.optionalString("directory")?.let { name ->
                validateStage(name)
                File(directory, name).let { if (it.exists()) check(it.deleteRecursively()) }
            }
            next.getJSONObject("works").remove(work.getString("workId"))
        }
        next.optJSONObject("pendingDeliveryCursors")?.let { cursors ->
            cursors.remove(tripId)
            if (cursors.length() == 0) next.remove("pendingDeliveryCursors")
        }
        persist(next)
    }
    private fun persist(next: JSONObject) {
        next.put("revision", revision() + 1)
        val temporary = File(directory, "journal.tmp")
        FileOutputStream(temporary).use { it.write(next.toString().toByteArray()); it.fd.sync() }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        state = next
    }
    private fun validateStage(name: String) {
        require(name.matches(Regex("stage-[0-9a-f-]{36}")))
        require(java.util.UUID.fromString(name.removePrefix("stage-")).toString() == name.removePrefix("stage-"))
        require(File(directory, name).canonicalFile.parentFile == directory.canonicalFile)
    }
    private fun validatePendingCursor(cursor: String) {
        require(cursor.matches(Regex("^[A-Za-z0-9_-]{1,512}$")))
    }
}

internal fun JSONObject.optionalString(key: String): String? = if (isNull(key)) null else getString(key)
internal fun JSONObject.values(): List<JSONObject> = keys().asSequence().map { getJSONObject(it) }.toList()
