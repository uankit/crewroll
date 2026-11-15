package com.uankit53.crewroll.transfer.media

import java.security.MessageDigest

/** A compact destination version, never an image-content identity. */
fun photoOrganizationDestinationId(relativePath: String): String =
    MessageDigest.getInstance("SHA-256").digest(relativePath.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }

enum class NativePhotoOrganizationAction { ALREADY_ORGANIZED, USER_MANAGED, MOVE, OWNERSHIP_UNAVAILABLE }

/** Never rearrange camera/other-app photos or a user's chosen location. */
fun photoOrganizationAction(currentPath: String, targetPath: String, ownerPackage: String?, applicationPackage: String): NativePhotoOrganizationAction {
    require(NativeTripAlbumPaths.isDestination(targetPath) && targetPath != NativeTripAlbumPaths.LEGACY)
    if (currentPath == targetPath) return NativePhotoOrganizationAction.ALREADY_ORGANIZED
    if (currentPath != NativeTripAlbumPaths.LEGACY) return NativePhotoOrganizationAction.USER_MANAGED
    if (ownerPackage != applicationPackage) return NativePhotoOrganizationAction.OWNERSHIP_UNAVAILABLE
    return NativePhotoOrganizationAction.MOVE
}
