package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.File
import java.time.Instant
import java.security.MessageDigest

class NativeSavedOriginalTest {
    private val bytes = byteArrayOf(1, 2, 3)
    private val hash = MessageDigest.getInstance("SHA-256").digest(bytes)
    private class Photos : NativePhotoLibraryPort {
        val saved = mutableMapOf<String, ByteArray>()
        val assets = mutableMapOf<String, String>()
        var finds = 0
        override fun observe(changed: (() -> Unit)?) {}
        override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int) = emptyList<DiscoveredPhoto>()
        override fun exportOriginal(localId: String, destination: File): PhotoMetadata = error("not exporting")
        override fun preview(source: File, destination: File): PhotoMetadata = error("not generating")
        override fun findSaved(assetId: String): String? { finds++; return assets[assetId] }
        override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, relativePath: String, allocated: (String) -> Unit): String = error("never resave")
        override fun verify(localId: String, bytes: Long, checksum: ByteArray) {
            val actual = saved[localId] ?: throw PhotoLibraryException("SOURCE_MISSING")
            if (actual.size.toLong() != bytes || !MessageDigest.isEqual(MessageDigest.getInstance("SHA-256").digest(actual), checksum)) throw PhotoLibraryException("INTEGRITY_FAILURE")
        }
    }
    @Test fun `journaled URI survives a user move without a filename or folder lookup`() {
        val photos = Photos(); photos.saved["content://moved/12"] = bytes
        assertEquals("content://moved/12", findVerifiedSavedOriginal(photos, "asset", "content://moved/12", 3, hash))
        assertEquals(0, photos.finds)
    }
    @Test fun `missing stale URI can recover a verified legacy asset lookup`() {
        val photos = Photos(); photos.saved["legacy"] = bytes; photos.assets["asset"] = "legacy"
        assertEquals("legacy", findVerifiedSavedOriginal(photos, "asset", "deleted", 3, hash))
    }
    @Test fun `two distinct captures containing identical bytes keep their separate asset identity`() {
        val photos = Photos()
        val first = "018f0d98-76fa-4d1a-b4b4-1f742c2e3130"
        val second = "018f0d98-76fa-4d1a-b4b4-1f742c2e3140"
        listOf(first, second).forEach { photos.saved[it] = bytes.copyOf(); photos.assets[it] = it }
        assertEquals(first, findVerifiedSavedOriginal(photos, first, null, 3, hash))
        assertEquals(second, findVerifiedSavedOriginal(photos, second, null, 3, hash))
        assertEquals(2, photos.finds)
    }
    @Test fun `a hash mismatch never falls back to a different photo or causes a save`() {
        val photos = Photos(); photos.saved["tampered"] = byteArrayOf(9, 9, 9)
        val error = assertThrows(PhotoLibraryException::class.java) { findVerifiedSavedOriginal(photos, "asset", "tampered", 3, hash) }
        assertEquals("INTEGRITY_FAILURE", error.blocker); assertEquals(0, photos.finds)
    }
    @Test fun `moved asset ID filename can recover after journal loss with zero inserts`() {
        val asset = "018f0d98-76fa-4d1a-b4b4-1f742c2e3130"
        val photos = Photos()
        photos.saved["content://gallery/user-moved-photo"] = bytes.copyOf()
        photos.assets[asset] = "content://gallery/user-moved-photo"
        assertEquals("content://gallery/user-moved-photo", findVerifiedSavedOriginal(photos, asset, null, 3, hash))
        assertEquals(1, photos.finds)
    }

}
