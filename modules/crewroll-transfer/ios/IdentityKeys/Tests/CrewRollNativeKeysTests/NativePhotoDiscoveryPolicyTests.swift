#if canImport(Photos)
import XCTest
@testable import CrewRollNativeKeys

final class NativePhotoDiscoveryPolicyTests: XCTestCase {
    func testReceivedOriginalIsExcludedWithoutAnAccountJournal() {
        let assetID = "01a0b32f-31dc-772c-a25e-c7bd4d819484"
        for name in ["crewroll-\(assetID).jpg", "CREWROLL-\(assetID.uppercased()).HEIC", "crewroll-\(assetID).jpeg"] {
            XCTAssertTrue(NativePhotoDiscoveryPolicy.isCrewRollSavedPhoto(name))
        }
    }

    func testCameraAndUnrelatedFilenamesRemainEligible() {
        for name in ["IMG_0042.HEIC", "IMG_0043.JPG", "crewroll-holiday.jpg", "crewroll-.jpg", "other-01a0b32f-31dc-772c-a25e-c7bd4d819484.jpg"] {
            XCTAssertFalse(NativePhotoDiscoveryPolicy.isCrewRollSavedPhoto(name))
        }
    }
}
#endif
