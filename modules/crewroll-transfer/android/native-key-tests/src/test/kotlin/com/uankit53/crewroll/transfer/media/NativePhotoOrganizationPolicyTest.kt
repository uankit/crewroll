package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePhotoOrganizationPolicyTest {
    private val target = NativeTripAlbumPaths.destination("018f0d98-76fa-7d1a-b4b4-1f742c2e3130", "Wedding", "2026-12-07T00:00:00Z")
    @Test fun `only app-owned legacy receives may be moved without a prompt`() {
        assertEquals(NativePhotoOrganizationAction.MOVE, photoOrganizationAction(NativeTripAlbumPaths.LEGACY, target, "crewroll", "crewroll"))
        assertEquals(NativePhotoOrganizationAction.OWNERSHIP_UNAVAILABLE, photoOrganizationAction(NativeTripAlbumPaths.LEGACY, target, null, "crewroll"))
        assertEquals(NativePhotoOrganizationAction.ALREADY_ORGANIZED, photoOrganizationAction(target, target, null, "crewroll"))
        for (path in listOf("DCIM/Camera/", "Pictures/My wedding/", "Pictures/CrewRoll/another-choice/")) {
            assertEquals(NativePhotoOrganizationAction.USER_MANAGED, photoOrganizationAction(path, target, "crewroll", "crewroll"))
        }
    }
}
