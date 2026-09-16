package com.uankit53.crewroll.transfer.media

/** Keep screenshots, downloads and received CrewRoll originals out of capture discovery. */
internal fun isCameraSource(relativePath: String?, ownerPackage: String?, systemCameras: Set<String>): Boolean =
    relativePath == "DCIM/Camera/" ||
        (relativePath == "Pictures/" && ownerPackage != null && ownerPackage in systemCameras)
