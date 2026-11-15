package com.uankit53.crewroll.transfer.media

import java.io.File
import java.time.Instant

data class DiscoveredPhoto(val localId: String, val capturedAt: Instant)
data class PhotoMetadata(val mime: String, val width: UInt, val height: UInt)
class PhotoLibraryException(val blocker: String) : RuntimeException(blocker)
enum class PhotoOrganizationResult { ORGANIZED, USER_MANAGED }
interface NativePhotoLibraryPort {
    fun observe(changed: (() -> Unit)?)
    fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int): List<DiscoveredPhoto>
    fun exportOriginal(localId: String, destination: File): PhotoMetadata
    fun preview(source: File, destination: File): PhotoMetadata
    fun findSaved(assetId: String): String?
    fun isPublished(localId: String): Boolean = true
    fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, relativePath: String, allocated: (String) -> Unit): String
    fun verify(localId: String, bytes: Long, checksum: ByteArray)
    fun inspectOrganization(localId: String, relativePath: String): NativePhotoOrganizationAction = NativePhotoOrganizationAction.USER_MANAGED
    fun organizeSaved(localId: String, relativePath: String): PhotoOrganizationResult = PhotoOrganizationResult.USER_MANAGED
}
