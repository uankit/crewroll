import XCTest
@testable import CrewRollNativeKeys

final class NativeTransferOwnerCancellationTests: XCTestCase {
    func testDelayedEnumerationCannotCancelATransferRejoinedByAnotherOwner() {
        let transferID = "ciphertext"
        let oldTask = TransferTask(transferID)
        var waiters: [String: [String]] = [:]
        var cancelledTasks = Set<ObjectIdentifier>()
        // URLSession captures this callback while the old owner's last waiter
        // has been removed. Its asynchronous result has not reached the queue.
        let enumerationCompleted: ([TransferTask]) -> Void = { tasks in
            NativeTransferOwnerCancellation.cancelUnobserved(
                tasks: tasks, transferID: transferID,
                hasWaiters: { !(waiters[$0] ?? []).isEmpty },
                taskTransferID: { $0.transferID },
                markCancelled: { cancelledTasks.insert(ObjectIdentifier($0)) },
                cancel: { $0.cancelled = true }
            )
        }
        waiters[transferID] = ["replacement-owner"]
        enumerationCompleted([oldTask])

        XCTAssertFalse(oldTask.cancelled)
        XCTAssertTrue(cancelledTasks.isEmpty)
        XCTAssertEqual(waiters[transferID], ["replacement-owner"])
    }

    func testCancelledTaskIsMarkedBeforeCancellationAndCannotCompleteANewOwner() {
        let transferID = "ciphertext"
        let oldTask = TransferTask(transferID)
        let unrelatedTask = TransferTask("another-ciphertext")
        var waiters: [String: [String]] = [:]
        var cancelledTasks = Set<ObjectIdentifier>()
        NativeTransferOwnerCancellation.cancelUnobserved(
            tasks: [oldTask, unrelatedTask], transferID: transferID,
            hasWaiters: { !(waiters[$0] ?? []).isEmpty },
            taskTransferID: { $0.transferID },
            markCancelled: { cancelledTasks.insert(ObjectIdentifier($0)) },
            cancel: { task in
                XCTAssertTrue(cancelledTasks.contains(ObjectIdentifier(task)),
                    "the delegate may deliver cancellation as soon as cancel is called")
                task.cancelled = true
            }
        )
        XCTAssertTrue(oldTask.cancelled)
        XCTAssertFalse(unrelatedTask.cancelled)
        XCTAssertFalse(cancelledTasks.contains(ObjectIdentifier(unrelatedTask)))

        waiters[transferID] = ["replacement-owner"]
        // Match the background delegate's early return for a cancelled task.
        // Its late completion must leave the replacement owner's waiter alone.
        if cancelledTasks.remove(ObjectIdentifier(oldTask)) == nil {
            waiters.removeValue(forKey: transferID)
        }
        XCTAssertEqual(waiters[transferID], ["replacement-owner"])
        XCTAssertTrue(cancelledTasks.isEmpty)
    }
}

private final class TransferTask {
    let transferID: String
    var cancelled = false
    init(_ transferID: String) { self.transferID = transferID }
}
