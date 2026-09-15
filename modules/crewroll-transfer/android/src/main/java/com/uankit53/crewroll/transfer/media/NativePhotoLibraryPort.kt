package com.uankit53.crewroll.transfer.media

import java.io.File
import java.time.Instant

data class DiscoveredPhoto(val localId: String, val capturedAt: Instant)
data class PhotoMetadata(val mime: String, val width: UInt, val height: UInt)
class PhotoLibraryException(val blocker: String) : RuntimeException(blocker)
interface NativePhotoLibraryPort {
    fun observe(changed: (() -> Unit)?)
    fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int): List<DiscoveredPhoto>
    fun exportOriginal(localId: String, destination: File): PhotoMetadata
    fun preview(source: File, destination: File): PhotoMetadata
    fun findSaved(assetId: String): String?
    fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, allocated: (String) -> Unit): String
    fun verify(localId: String, bytes: Long, checksum: ByteArray)
}
