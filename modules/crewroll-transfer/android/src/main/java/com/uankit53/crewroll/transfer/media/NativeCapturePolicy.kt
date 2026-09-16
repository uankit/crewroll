package com.uankit53.crewroll.transfer.media

import java.time.Instant
import org.json.JSONObject

/** Server-owned capture boundaries; paused photos are never caught up on resume. */
internal class NativeCapturePolicy(json: JSONObject, tripId: String) {
    val version = json.getLong("version")
    val participation = json.getString("participation")
    val left = participation == "LEFT"
    val leaving = participation == "LEAVING"
    private val until = Instant.parse(json.getString("captureUntil"))
    private val excluded = json.getJSONArray("excludedCaptureWindows").let { rows ->
        (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            Instant.parse(row.getString("from")) to if (row.isNull("until")) null else Instant.parse(row.getString("until"))
        }.sortedBy { it.first }
    }
    init {
        require(json.getString("tripId") == tripId && version > 0)
        require(participation in setOf("JOINED", "JOINING", "LEAVING", "LEFT"))
        require(excluded.all { it.second == null || !it.second!!.isBefore(it.first) })
    }
    fun windows(start: Instant, end: Instant): List<Pair<Instant, Instant>> {
        if (left) return emptyList()
        val bound = minOf(end, until)
        var cursor = start
        val result = mutableListOf<Pair<Instant, Instant>>()
        for ((from, to) in excluded) {
            if (to != null && to <= cursor) continue
            if (from > bound) break
            if (from > cursor) result.add(cursor to minOf(bound, from.minusMillis(1)))
            if (to == null) return result
            cursor = maxOf(cursor, to)
        }
        if (cursor <= bound) result.add(cursor to bound)
        return result
    }
}
