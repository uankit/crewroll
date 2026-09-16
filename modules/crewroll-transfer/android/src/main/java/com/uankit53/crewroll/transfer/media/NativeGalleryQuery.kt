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
        val comparator = compareBy<Map<String, Any?>> { Instant.parse(it["capturedAt"] as String) }.thenBy { it["assetId"] as String }
        val filtered = records.filter {
            val captured = Instant.parse(it["capturedAt"] as String)
            (sourceMembershipId == null || it["sourceMembershipId"] == sourceMembershipId) &&
                (from == null || captured >= from) && (before == null || captured < before)
        }.sortedWith(if (newest) comparator.reversed() else comparator)
        val prefix = "page_${revision}_${fingerprint}_"
        val offset = if (cursor == null) 0 else {
            require(cursor.startsWith(prefix)); cursor.removePrefix(prefix).toInt()
        }
        require(offset in 0..filtered.size)
        val items = filtered.drop(offset).take(limit)
        return items to if (offset + items.size < filtered.size) prefix + (offset + items.size) else null
    }
}
