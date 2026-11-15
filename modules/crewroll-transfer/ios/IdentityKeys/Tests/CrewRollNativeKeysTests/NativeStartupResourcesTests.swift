import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeStartupResourcesTests: XCTestCase {
    func testForegroundSnapshotsPreserveColdBackgroundAndOrderOnlyRealTransitions() {
        let subject = NativeForegroundState()
        XCTAssertEqual(subject.snapshot, NativeForegroundSnapshot(revision: 0, isForeground: false))
        let foreground = subject.update(true)
        XCTAssertEqual(foreground.revision, 1)
        for _ in 0..<100 { XCTAssertEqual(subject.update(true), foreground) }
        let background = subject.update(false)
        XCTAssertEqual(background.revision, 2)
        XCTAssertFalse(background.isForeground)
        XCTAssertTrue(foreground.isForeground, "captured deliveries retain their original ordering token")
        XCTAssertEqual(subject.snapshot, background)
    }

    func testExistingProbeDoesNotWaitForSlowEngineConstruction() {
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let created = DispatchSemaphore(value: 0)
        let probed = DispatchSemaphore(value: 0)
        let subject = NativeLazyResource {
            entered.signal()
            release.wait()
            return NSObject()
        }
        DispatchQueue.global().async { _ = subject.get(); created.signal() }
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
        DispatchQueue.global().async { XCTAssertNil(subject.existing); probed.signal() }
        let probeResult = probed.wait(timeout: .now() + 1)
        release.signal()
        XCTAssertEqual(created.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(probeResult, .success)
    }

    func testCheckingAnUnstartedResourceDoesNotConstructItAndConcurrentUsersShareOneInstance() {
        let counter = ResourceCounter()
        let resource = NativeLazyResource {
            counter.increment()
            return NSObject()
        }
        for _ in 0..<100 { XCTAssertNil(resource.existing) }
        XCTAssertEqual(counter.value, 0)
        let group = DispatchGroup()
        for _ in 0..<20 {
            group.enter()
            DispatchQueue.global().async {
                _ = resource.get()
                group.leave()
            }
        }
        XCTAssertEqual(group.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(counter.value, 1)
        XCTAssertTrue(resource.existing === resource.get())
    }

    func testMaintenanceRequestsStayNonblockingAndCoalesceUntilAsyncDrainCompletes() {
        let subject = NativeMaintenanceWorkQueue()
        let entered = DispatchSemaphore(value: 0)
        let admitted = DispatchSemaphore(value: 0)
        let unexpected = DispatchSemaphore(value: 0)
        let callbacks = MaintenanceCallbacks()
        let counter = ResourceCounter()
        subject.submit { done in
            counter.increment()
            callbacks.append(done)
            entered.signal()
            // Return with an outstanding asynchronous drain, as the runtime's
            // actor operation does. This must remain one pending operation.
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async {
            for _ in 0..<100 {
                subject.submit { done in unexpected.signal(); done() }
            }
            admitted.signal()
        }
        XCTAssertEqual(admitted.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(unexpected.wait(timeout: .now() + 0.05), .timedOut)
        XCTAssertEqual(counter.value, 1)

        callbacks.call(0)
        subject.submit { done in
            counter.increment()
            callbacks.append(done)
            entered.signal()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        callbacks.call(0) // A late duplicate completion cannot clear the new job.
        subject.submit { done in unexpected.signal(); done() }
        XCTAssertEqual(unexpected.wait(timeout: .now() + 0.05), .timedOut)
        XCTAssertEqual(counter.value, 2)
        callbacks.call(1)
    }
}

private final class ResourceCounter {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func increment() { lock.lock(); count += 1; lock.unlock() }
}

private final class MaintenanceCallbacks {
    private let lock = NSLock()
    private var values: [() -> Void] = []
    func append(_ value: @escaping () -> Void) { lock.lock(); values.append(value); lock.unlock() }
    func call(_ index: Int) {
        lock.lock(); let value = values[index]; lock.unlock()
        value()
    }
}
