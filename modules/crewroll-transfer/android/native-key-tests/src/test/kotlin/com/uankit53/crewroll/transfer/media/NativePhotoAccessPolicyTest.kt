package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NativePhotoAccessPolicyTest {
    @Test fun `selected photos never authorize automatic discovery`() {
        assertEquals(NativePhotoAccess.LIMITED, nativePhotoAccess(34, false, true, true))
        assertEquals(NativePhotoAccess.LIMITED, nativePhotoAccess(36, false, true, false))
        assertEquals(NativePhotoAccess.DENIED, nativePhotoAccess(34, false, false, true))
    }

    @Test fun `full access still requires original metadata and supports older scoped storage`() {
        for (sdk in listOf(29, 30, 32, 33, 34, 36)) {
            assertEquals(NativePhotoAccess.ORIGINAL_METADATA_REQUIRED, nativePhotoAccess(sdk, true, false, false))
            assertEquals(NativePhotoAccess.FULL, nativePhotoAccess(sdk, true, false, true))
        }
        // Full and selected grants can coexist after upgrading from partial.
        assertEquals(NativePhotoAccess.FULL, nativePhotoAccess(34, true, true, true))
        assertEquals(NativePhotoAccess.DENIED, nativePhotoAccess(28, true, true, true))
    }
}
