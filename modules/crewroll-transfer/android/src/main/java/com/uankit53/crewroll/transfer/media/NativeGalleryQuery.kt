package com.uankit53.crewroll.transfer.media

import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Filter the complete local index before taking a bounded bridge page. */
class NativeGalleryQuery(
    val sourceMembershipId: String? = null,
    capturedFrom: String? = null,
    capturedBefore: String? = null,
    order: String = "NEWEST",
) {
    private val from = capturedFrom?.let(Instant::parse)
    private val before = capturedBefore?.let(Instant::parse)
    private val newest = order == "NEWEST"
    private val fingerprint: String
    private data class IndexedPhoto(val row: Map<String, Any?>, val captured: Instant, val assetId: String)
    init {
        require(sourceMembershipId == null || UUID.fromString(sourceMembershipId).toString() == sourceMembershipId)
        require(order == "NEWEST" || order == "OLDEST")
        require(from == null || before == null || from < before)
        fingerprint = MessageDigest.getInstance("SHA-256")
            .digest(listOf(sourceMembershipId ?: "", from?.toString() ?: "", before?.toString() ?: "", order).joinToString("|").toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }
    }
    fun page(records: List<Map<String, Any?>>, revision: Long, limit: Int, cursor: String?): Pair<List<Map<String, Any?>>, String?> {
        require(limit in 1..100)
        // Date parsing is linear in rows, rather than repeated by the sorter.
        val comparator = compareBy<IndexedPhoto> { it.captured }.thenBy { it.assetId }
        val filtered = records.map {
            IndexedPhoto(it, Instant.parse(it["capturedAt"] as String), it["assetId"] as String)
        }.filter {
            (sourceMembershipId == null || it.row["sourceMembershipId"] == sourceMembershipId) &&
                (from == null || it.captured >= from) && (before == null || it.captured < before)
        }.sortedWith(if (newest) comparator.reversed() else comparator)
        val prefix = "page_${revision}_${fingerprint}_"
        val offset = if (cursor == null) 0 else {
            require(cursor.startsWith(prefix)); cursor.removePrefix(prefix).toInt()
        }
        require(offset in 0..filtered.size)
        val items = filtered.drop(offset).take(limit).map { it.row }
        return items to if (offset + items.size < filtered.size) prefix + (offset + items.size) else null
    }
}
