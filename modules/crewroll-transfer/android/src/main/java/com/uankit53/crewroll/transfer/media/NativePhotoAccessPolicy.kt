package com.uankit53.crewroll.transfer.media

enum class NativePhotoAccess { FULL, LIMITED, ORIGINAL_METADATA_REQUIRED, DENIED }

/** Full read permission and exact-original metadata are independent grants.
 * A selected-only grant on API 34+ never enables automatic trip discovery.
 * The permission requester must request READ_MEDIA_VISUAL_USER_SELECTED with
 * READ_MEDIA_IMAGES to avoid Android's temporary compatibility false grant.
 */
fun nativePhotoAccess(sdk: Int, fullRead: Boolean, selectedRead: Boolean, originalMetadata: Boolean): NativePhotoAccess = when {
    sdk < 29 -> NativePhotoAccess.DENIED
    !fullRead -> if (sdk >= 34 && selectedRead) NativePhotoAccess.LIMITED else NativePhotoAccess.DENIED
    !originalMetadata -> NativePhotoAccess.ORIGINAL_METADATA_REQUIRED
    else -> NativePhotoAccess.FULL
}
