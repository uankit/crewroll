/// Run on the transfer state queue after asynchronous task enumeration returns.
/// A new owner may have rejoined since cancellation was requested. Mark tasks
/// before cancelling so their later delegate completions cannot consume a new
/// owner's waiter for the same ciphertext identity.
enum NativeTransferOwnerCancellation {
    static func cancelUnobserved<TransferTask>(
        tasks: [TransferTask], transferID: String,
        hasWaiters: (String) -> Bool,
        taskTransferID: (TransferTask) -> String?,
        markCancelled: (TransferTask) -> Void,
        cancel: (TransferTask) -> Void
    ) {
        guard !hasWaiters(transferID) else { return }
        for task in tasks where taskTransferID(task) == transferID {
            markCancelled(task)
            cancel(task)
        }
    }
}
