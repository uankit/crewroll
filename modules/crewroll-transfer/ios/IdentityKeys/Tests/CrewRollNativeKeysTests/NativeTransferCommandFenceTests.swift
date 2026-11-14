import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeTransferCommandFenceTests: XCTestCase {
    func testLaterInstalledSelectionRejectsAnOldClearOrEraseAfterAsyncDrain() throws {
        let fence = NativeTransferCommandFence()
        let selected = LockedSelection("account-A")
        let oldClear = fence.advance()
        let drain = DispatchSemaphore(value: 0)
        let done = expectation(description: "old clear completes without mutation")
        DispatchQueue.global().async {
            drain.wait()
            do {
                try fence.withCurrent(oldClear) { selected.value = nil }
                XCTFail("stale teardown must be rejected")
            } catch { XCTAssertTrue(error is CancellationError) }
            done.fulfill()
        }
        fence.begin { _ in selected.value = "account-B" }
        drain.signal()
        wait(for: [done], timeout: 2)
        XCTAssertEqual(selected.value, "account-B")
    }

    func testSelectionAndOldTeardownMutationAreSerializedAtomically() {
        let fence = NativeTransferCommandFence()
        let epoch = fence.advance()
        let protected = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let tryingInstall = DispatchSemaphore(value: 0)
        let completedInstall = DispatchSemaphore(value: 0)
        let cleared = expectation(description: "eligible clear finishes")
        let selected = LockedSelection("account-A")
        DispatchQueue.global().async {
            do {
                try fence.withCurrent(epoch) {
                    protected.signal()
                    XCTAssertEqual(release.wait(timeout: .now() + 2), .success)
                    selected.value = nil
                }
            } catch { XCTFail("eligible mutation failed: \(error)") }
            cleared.fulfill()
        }
        XCTAssertEqual(protected.wait(timeout: .now() + 1), .success)
        DispatchQueue.global().async {
            tryingInstall.signal()
            fence.begin { _ in selected.value = "account-B" }
            completedInstall.signal()
        }
        XCTAssertEqual(tryingInstall.wait(timeout: .now() + 1), .success)
        // The install cannot publish in the gap between a stale predicate and
        // clear's actual mutation: the operation lock protects both together.
        XCTAssertEqual(completedInstall.wait(timeout: .now() + 0.02), .timedOut)
        release.signal()
        wait(for: [cleared], timeout: 2)
        XCTAssertEqual(completedInstall.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(selected.value, "account-B")
        XCTAssertThrowsError(try fence.withCurrent(epoch) { selected.value = nil })
    }

    func testProcessSharedFenceSurvivesReplacingAnExpoModuleOwner() {
        let firstModule = NativeTransferCommandFence.shared
        let old = firstModule.advance()
        let replacementModule = NativeTransferCommandFence.shared
        _ = replacementModule.advance()
        XCTAssertFalse(firstModule.matches(old))
        XCTAssertThrowsError(try firstModule.withCurrent(old) { XCTFail("old module cannot mutate replacement selection") })
    }

    func testActorPredicateDoesNotWaitForSlowSecureStorageMutation() {
        let fence = NativeTransferCommandFence()
        let old = fence.advance()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let completed = expectation(description: "slow storage finishes")
        DispatchQueue.global().async {
            fence.begin { _ in entered.signal(); _ = release.wait(timeout: .now() + 2) }
            completed.fulfill()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
        let checked = expectation(description: "actor predicate remains responsive")
        DispatchQueue.global().async { XCTAssertFalse(fence.matches(old)); checked.fulfill() }
        wait(for: [checked], timeout: 1)
        release.signal()
        wait(for: [completed], timeout: 1)
    }
}

private final class LockedSelection: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    init(_ value: String?) { stored = value }
    var value: String? {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}
