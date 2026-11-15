import BackgroundTasks
import ExpoModulesCore
import UIKit
import Photos

/// Shared by the Expo module and launch-time OS callbacks. Background work must
/// not depend on React mounting a screen or create a second journal writer.
final class CrewRollAppleRuntime {
    static let lifecycleWork = NativeLifecycleWorkQueue()
    static var transferEnabled: Bool { UserDefaults.standard.bool(forKey: "crewroll.background.enabled") }
    private static let instanceLock = NSLock()
    private static var instance: CrewRollAppleRuntime?
    private static let foregroundState = NativeForegroundState()
    static func setForeground(_ value: Bool) {
        let snapshot = foregroundState.update(value)
        guard let runtime = existing() else { return }
        runtime.applyForeground(snapshot)
        if value { runtime.requestRetentionMaintenance() }
    }
    static func existing() -> CrewRollAppleRuntime? {
        instanceLock.lock(); defer { instanceLock.unlock() }
        return instance
    }
    static func get() throws -> CrewRollAppleRuntime {
        instanceLock.lock(); defer { instanceLock.unlock() }
        if let instance { return instance }
        let value = try CrewRollAppleRuntime(); instance = value; return value
    }
    let lifecycle: NativeKeyLifecycle
    private let engineResource: NativeLazyResource<ApplePhotoTransferEngine>
    private let retentionWork = NativeMaintenanceWorkQueue()
    var engine: ApplePhotoTransferEngine { engineResource.get() }
    var existingEngine: ApplePhotoTransferEngine? { engineResource.existing }
    private let lock = NSLock()
    private var revision = 0
    private let pushGate = NativePushWakeGate()
    private let defaults = UserDefaults.standard
    static let taskID = "com.uankit53.airmesh.media-processing"
    var enabled: Bool { defaults.bool(forKey: "crewroll.background.enabled") }
    var cellular: Bool { defaults.object(forKey: "crewroll.background.cellular") as? Bool ?? true }
    var foregroundSnapshot: NativeForegroundSnapshot { Self.foregroundState.snapshot }
    var isForeground: Bool { foregroundSnapshot.isForeground }
    private init() throws {
        let lifecycle = try AppleNativeKeyInfrastructure.makeLifecycle()
        self.lifecycle = lifecycle
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        engineResource = NativeLazyResource {
            ApplePhotoTransferEngine(root: support.appendingPathComponent("CrewRollTransfers"), contextProvider: { try lifecycle.mediaContext() }, invalidated: { revision in
                NotificationCenter.default.post(name: .crewRollEngineInvalidated, object: nil, userInfo: ["revision": revision])
            }, expiredTrips: { try lifecycle.expiredTrips() }, nextRetentionDeadline: { try lifecycle.nextTripRetentionDeadline() }, purgeExpiredKey: { trip, cleanup in try lifecycle.purgeExpiredTrip(trip, beforeKeyRemoval: cleanup) })
        }
        // Replace the retired Wi-Fi-only preference, preserving sign-out and
        // the account-scoped journal. New activations also enable all networks.
        if defaults.integer(forKey: "crewroll.background.networkPolicyVersion") < 1 {
            defaults.set(true, forKey: "crewroll.background.cellular")
            defaults.set(1, forKey: "crewroll.background.networkPolicyVersion")
        }
    }
    private func applyForeground(_ snapshot: NativeForegroundSnapshot) {
        // Delivery can cross another OS transition or an activation task. The
        // actor rejects older revisions instead of trusting Task execution order.
        if let engine = existingEngine { Task { await engine.foreground(snapshot) } }
        if !snapshot.isForeground { schedule() }
    }
    /// Called only after acknowledging interactive pause/restoration. A paused
    /// engine may clean local expiry without starting discovery or networking.
    func requestRetentionMaintenance() {
        retentionWork.submit { [weak self] complete in
            guard let self else { complete(); return }
            do { try self.lifecycle.runScheduledCleanup() }
            catch { complete(); return }
            let engine = self.engine
            Task {
                defer { complete() }
                try? await engine.reconcileRetention(force: true)
            }
        }
    }
    func policy(enabled: Bool, cellular: Bool? = nil) {
        lock.lock(); revision += 1; lock.unlock()
        defaults.set(enabled, forKey: "crewroll.background.enabled")
        if let cellular { defaults.set(cellular, forKey: "crewroll.background.cellular") }
        if enabled { schedule() } else { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.taskID) }
    }
    func schedule() {
        guard enabled else { return }
        let request = BGProcessingTaskRequest(identifier: Self.taskID)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date(timeIntervalSinceNow: 60)
        do { try BGTaskScheduler.shared.submit(request) } catch { /* OS may defer; the native journal remains authoritative. */ }
    }
    fileprivate func run(_ task: BGProcessingTask, completion: CrewRollProcessingCompletion) {
        guard !completion.isFinished else { return }
        guard enabled else { completion.finish( true); return }
        lock.lock(); let epoch = revision; lock.unlock()
        schedule()
        let operation = Task {
            do {
                try Task.checkCancellation()
                guard !completion.isFinished else { return }
                try await engine.reconcileRetention(force: true)
                // Retention can wait for an in-flight Photos save. The OS
                // allowance may have expired while that operation drained.
                try Task.checkCancellation()
                guard !completion.isFinished, current(epoch) else { return }
                guard var context = try lifecycle.mediaContext() else { completion.finish( true); return }
                context.tripKey.resetBytes(in: 0..<context.tripKey.count)
                context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count)
                let started = Date()
                await engine.foreground(foregroundSnapshot)
                await engine.activate(ifCurrent: { self.current(epoch) && !completion.isFinished && !Task.isCancelled })
                try Task.checkCancellation()
                guard !completion.isFinished, current(epoch) else { return }
                try await engine.reconcileNow()
                // Network work continues independently. Stay alive to checkpoint
                // verified saves and receipts, but finish as soon as it drains.
                while current(epoch) && Date().timeIntervalSince(started) < 120 {
                    try Task.checkCancellation()
                    let work = try await engine.backgroundWork(since: started)
                    if work.checked && !work.working && !work.pending { completion.finish(true); return }
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
                if !Task.isCancelled { completion.finish(false) }
            } catch { if !Task.isCancelled { completion.finish( false) } }
        }
        task.expirationHandler = {
            operation.cancel()
            // URLSession owns staged ciphertext and may continue after this
            // processing window expires. Do not cancel its upload/download.
            completion.finish( false)
        }
        // Expiration can race the transition from the launch callback's minimal
        // handler to the operation-specific handler above.
        if completion.isFinished { operation.cancel() }
    }
    func current(_ epoch: Int, backgroundOnly: Bool = false) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return enabled && epoch == revision && (!backgroundOnly || !isForeground)
    }
    func resumeAfterTransfer() {
        lock.lock(); let epoch = revision; lock.unlock()
        Task {
            await engine.foreground(foregroundSnapshot)
            await engine.activate(ifCurrent: { self.current(epoch) })
            if current(epoch) { await engine.wake() }
        }
    }
    func receive(_ hint: NativePushHint, completion: NativePushCompletion) {
        lock.lock(); let epoch = revision; lock.unlock()
        Task {
            do {
                // Expiry cleanup also runs while sharing is paused, without
                // using an active selection as a proxy for all imported keys.
                try await engine.reconcileRetention(force: true)
                guard !completion.isFinished, current(epoch) else { completion.finish(true); return }
                let accepted = try pushGate.accept(hint, enabled: enabled,
                    photosAllowed: PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized) {
                    guard var context = try lifecycle.mediaContext() else { return nil }
                    defer {
                        context.tripKey.resetBytes(in: 0..<context.tripKey.count)
                        context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count)
                    }
                    return (context.session.deviceID, context.metadata.tripID)
                }
                guard accepted else { completion.finish(true); return }
                let started = Date()
                await engine.foreground(foregroundSnapshot)
                await engine.activate(ifCurrent: { self.current(epoch) && !completion.isFinished && PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized && self.matches(hint) })
                guard current(epoch), !completion.isFinished, PHPhotoLibrary.authorizationStatus(for: .readWrite) == .authorized, matches(hint) else { completion.finish(true); return }
                try await engine.reconcileNow()
                while current(epoch), !completion.isFinished, matches(hint) {
                    let work = try await engine.backgroundWork(since: started)
                    if work.checked && !work.working && !work.pending { completion.finish(true); return }
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
                completion.finish(true)
            } catch { completion.finish(false) }
        }
    }
    private func matches(_ hint: NativePushHint) -> Bool {
        guard var context = try? lifecycle.mediaContext() else { return false }
        defer {
            context.tripKey.resetBytes(in: 0..<context.tripKey.count)
            context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count)
        }
        return context.session.deviceID == hint.deviceID && context.metadata.tripID == hint.tripID
    }
}
extension Notification.Name {
    static let crewRollEngineInvalidated = Notification.Name("CrewRollEngineInvalidated")
    static let crewRollPushHint = Notification.Name("CrewRollPushHint")
}

public final class CrewRollBackgroundTasks: ExpoAppDelegateSubscriber {
    private var listener: NSObjectProtocol?
    private var foregroundLease: UIBackgroundTaskIdentifier = .invalid
    public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: CrewRollAppleRuntime.taskID, using: nil) { task in
            let completion = CrewRollProcessingCompletion(task)
            // Install before queueing runtime/Keychain work: the OS deadline
            // applies even while another lifecycle operation is still blocked.
            task.expirationHandler = { completion.finish(false) }
            CrewRollAppleRuntime.lifecycleWork.submit {
                guard !completion.isFinished else { return }
                guard let processing = task as? BGProcessingTask, let runtime = try? CrewRollAppleRuntime.get() else { completion.finish(false); return }
                runtime.run(processing, completion: completion)
            }
        }
        AppleBackgroundTransfer.shared.reconnect()
        listener = NotificationCenter.default.addObserver(forName: .crewRollBackgroundTransferFinished, object: nil, queue: .main) { _ in
            CrewRollAppleRuntime.lifecycleWork.submit {
                guard let runtime = try? CrewRollAppleRuntime.get(), runtime.enabled else { return }
                runtime.schedule()
                runtime.resumeAfterTransfer()
            }
        }
        return true
    }
    public func applicationDidBecomeActive(_ application: UIApplication) {
        CrewRollAppleRuntime.lifecycleWork.submit {
            CrewRollAppleRuntime.setForeground(true)
        }
        if foregroundLease != .invalid { application.endBackgroundTask(foregroundLease); foregroundLease = .invalid }
    }
    public func applicationDidEnterBackground(_ application: UIApplication) {
        CrewRollAppleRuntime.lifecycleWork.submit { CrewRollAppleRuntime.setForeground(false) }
        guard CrewRollAppleRuntime.transferEnabled else { return }
        // Allow a foreground-started batch to checkpoint/stage its ciphertext.
        if foregroundLease == .invalid {
            foregroundLease = application.beginBackgroundTask(withName: "Finish trip photo sync") { [weak self] in
                guard let self else { return }
                if self.foregroundLease != .invalid { application.endBackgroundTask(self.foregroundLease); self.foregroundLease = .invalid }
            }
        }
    }
    public func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        _ = AppleBackgroundTransfer.shared.handleEvents(identifier: identifier, completion: completionHandler)
    }
    public func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let hint = NativePushHint.remote(userInfo) else { completionHandler(.noData); return }
        NotificationCenter.default.post(name: .crewRollPushHint, object: nil, userInfo: hint.data)
        let completion = NativePushCompletion { success in
            DispatchQueue.main.async { completionHandler(success ? .noData : .failed) }
        }
        // Apple's limit is 30 seconds. Reserve time for Expo's completion fanout;
        // a background URLSession may continue staged ciphertext independently.
        DispatchQueue.global().asyncAfter(deadline: .now() + 25) { completion.finish(false) }
        CrewRollAppleRuntime.lifecycleWork.submit {
            guard !completion.isFinished else { return }
            guard let runtime = try? CrewRollAppleRuntime.get() else { completion.finish(false); return }
            runtime.receive(hint, completion: completion)
        }
    }
}

fileprivate final class CrewRollProcessingCompletion {
    private let task: BGTask
    private let lock = NSLock()
    private var completed = false
    init(_ task: BGTask) { self.task = task }
    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return completed }
    func finish(_ success: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return }; completed = true
        task.setTaskCompleted(success: success)
    }
}
