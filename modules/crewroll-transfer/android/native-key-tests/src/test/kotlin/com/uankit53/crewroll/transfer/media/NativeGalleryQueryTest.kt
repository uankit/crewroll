package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativeGalleryQueryTest {
    private val a = "10000000-0000-4000-8000-000000000001"
    private val b = "10000000-0000-4000-8000-000000000002"
    private fun row(index: Int, author: String? = a, stamp: String = "2026-09-16T12:00:00Z") = mapOf<String, Any?>("assetId" to index.toString().padStart(4, '0'), "sourceMembershipId" to author, "capturedAt" to stamp)
    @Test fun `author filters apply to the whole collection before bounded pagination`() {
        val records = (0 until 32).map { row(it, if (it < 27) a else b) }
        val query = NativeGalleryQuery(sourceMembershipId = b)
        val first = query.page(records, 7, 2, null)
        assertEquals(listOf("0031", "0030"), first.first.map { it["assetId"] })
        val second = query.page(records, 7, 2, first.second)
        assertEquals(listOf("0029", "0028"), second.first.map { it["assetId"] })
        val last = query.page(records, 7, 2, second.second)
        assertEquals(listOf("0027"), last.first.map { it["assetId"] }); assertNull(last.second)
    }
    @Test fun `day filtering uses inclusive start exclusive end and actual instants`() {
        val records = listOf(row(1, stamp = "2026-09-15T18:29:59.999Z"), row(2, stamp = "2026-09-15T18:30:00Z"), row(3, stamp = "2026-09-16T18:29:59.999Z"), row(4, stamp = "2026-09-16T18:30:00Z"))
        val query = NativeGalleryQuery(capturedFrom = "2026-09-16T00:00:00+05:30", capturedBefore = "2026-09-17T00:00:00+05:30", order = "OLDEST")
        assertEquals(listOf("0002", "0003"), query.page(records, 1, 24, null).first.map { it["assetId"] })
    }
    @Test fun `unknown authors remain in everyone and are not attributed to a friend`() {
        val records = listOf(row(1, null), row(2, b))
        assertEquals(2, NativeGalleryQuery().page(records, 1, 24, null).first.size)
        assertEquals(1, NativeGalleryQuery(sourceMembershipId = b).page(records, 1, 24, null).first.size)
    }
    @Test fun `cursor is invalid after the query or revision changes`() {
        val rows = (1..5).map { row(it) }
        val cursor = NativeGalleryQuery().page(rows, 1, 2, null).second
        assertThrows(IllegalArgumentException::class.java) { NativeGalleryQuery(order = "OLDEST").page(rows, 1, 2, cursor) }
        assertThrows(IllegalArgumentException::class.java) { NativeGalleryQuery().page(rows, 2, 2, cursor) }
    }
    @Test fun `invalid ranges and orders fail closed`() {
        assertThrows(IllegalArgumentException::class.java) { NativeGalleryQuery(order = "RANDOM") }
        assertThrows(IllegalArgumentException::class.java) { NativeGalleryQuery(capturedFrom = "2026-09-17T00:00:00Z", capturedBefore = "2026-09-16T00:00:00Z") }
    }
}
