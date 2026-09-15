package com.uankit53.crewroll.transfer.media

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

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
    @Synchronized fun put(work: JSONObject) {
        work.optionalString("directory")?.let(::validateStage)
        val next = JSONObject(state.toString())
        next.getJSONObject("works").put(work.getString("workId"), JSONObject(work.toString()))
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
}

internal fun JSONObject.optionalString(key: String): String? = if (isNull(key)) null else getString(key)
internal fun JSONObject.values(): List<JSONObject> = keys().asSequence().map { getJSONObject(it) }.toList()
