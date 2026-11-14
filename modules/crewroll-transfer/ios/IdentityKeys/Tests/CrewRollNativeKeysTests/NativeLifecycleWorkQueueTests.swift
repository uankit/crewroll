import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class NativeLifecycleWorkQueueTests: XCTestCase {
    func testBlockedSecureStorageDoesNotBlockCallbackAndPreservesWakeOrder() {
        let queue = NativeLifecycleWorkQueue()
        let started = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let second = expectation(description: "next lifecycle callback completes")
        let lock = NSLock()
        var order: [Int] = []
        queue.submit {
            XCTAssertFalse(Thread.isMainThread)
            started.signal()
            _ = release.wait(timeout: .now() + 2)
            lock.lock(); order.append(1); lock.unlock()
        }
        XCTAssertEqual(started.wait(timeout: .now() + 1), .success)
        queue.submit {
            lock.lock(); order.append(2); lock.unlock()
            second.fulfill()
        }
        // Enqueuing the next callback returned while the first remains blocked.
        lock.lock(); XCTAssertTrue(order.isEmpty); lock.unlock()
        release.signal()
        wait(for: [second], timeout: 1)
        lock.lock(); XCTAssertEqual(order, [1, 2]); lock.unlock()
    }
}
