package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativeCameraSourcePolicyTest {
    private val cameras = setOf("com.android.camera2")
    @Test fun `legacy DCIM captures remain eligible when owner metadata is absent`() {
        assertTrue(isCameraSource("DCIM/Camera/", null, emptySet()))
    }
    @Test fun `default Pictures folder requires verified system camera ownership`() {
        assertTrue(isCameraSource("Pictures/", "com.android.camera2", cameras))
        assertFalse(isCameraSource("Pictures/", null, cameras))
        assertFalse(isCameraSource("Pictures/", "com.example.download", cameras))
        assertFalse(isCameraSource("Pictures/", "com.android.camera2", emptySet()))
    }
    @Test fun `screenshots received originals and unrelated folders stay excluded`() {
        for (path in listOf(null, "Pictures/Screenshots/", "Pictures/CrewRoll/", "Download/", "DCIM/Camera-edits/")) {
            assertFalse(isCameraSource(path, "com.android.camera2", cameras))
        }
    }
}
