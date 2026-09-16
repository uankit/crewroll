import BackgroundTasks
import ExpoModulesCore
import UIKit

/// Shared by the Expo module and launch-time OS callbacks. Background work must
/// not depend on React mounting a screen or create a second journal writer.
final class CrewRollAppleRuntime {
    private static let instanceLock = NSLock()
    private static var instance: CrewRollAppleRuntime?
    static func get() throws -> CrewRollAppleRuntime {
        instanceLock.lock(); defer { instanceLock.unlock() }
        if let instance { return instance }
        let value = try CrewRollAppleRuntime(); instance = value; return value
    }
    let lifecycle: NativeKeyLifecycle
    let engine: ApplePhotoTransferEngine
    private let lock = NSLock()
    private var visible = false
    private var revision = 0
    private let defaults = UserDefaults.standard
    static let taskID = "com.uankit53.airmesh.media-processing"
    var enabled: Bool { defaults.bool(forKey: "crewroll.background.enabled") }
    var cellular: Bool { defaults.bool(forKey: "crewroll.background.cellular") }
    private init() throws {
        let lifecycle = try AppleNativeKeyInfrastructure.makeLifecycle()
        self.lifecycle = lifecycle
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        engine = ApplePhotoTransferEngine(root: support.appendingPathComponent("CrewRollTransfers"), contextProvider: { try lifecycle.mediaContext() }, invalidated: { revision in
            NotificationCenter.default.post(name: .crewRollEngineInvalidated, object: nil, userInfo: ["revision": revision])
        })
    }
    func foreground(_ value: Bool) { lock.lock(); visible = value; lock.unlock(); if !value { schedule() } }
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
    func run(_ task: BGProcessingTask) {
        let completion = CrewRollProcessingCompletion(task)
        guard enabled else { completion.finish( true); return }
        lock.lock(); let epoch = revision; lock.unlock()
        schedule()
        let operation = Task {
            do {
                guard var context = try lifecycle.mediaContext() else { completion.finish( true); return }
                context.tripKey.resetBytes(in: 0..<context.tripKey.count)
                context.session.backgroundBearer.resetBytes(in: 0..<context.session.backgroundBearer.count)
                await engine.setPolicy(paused: false, cellularAllowed: cellular, ifCurrent: { self.current(epoch) })
                // Both lanes are single-flight. A fixed batch avoids an unbounded
                // daemon; URLSession continues staged ciphertext if suspended.
                for _ in 0..<20 {
                    if Task.isCancelled || !current(epoch) { break }
                    await engine.wakePreviews(); await engine.wake()
                }
                if !Task.isCancelled { completion.finish( true) }
            } catch { if !Task.isCancelled { completion.finish( false) } }
        }
        task.expirationHandler = {
            operation.cancel()
            // URLSession owns staged ciphertext and may continue after this
            // processing window expires. Do not cancel its upload/download.
            completion.finish( false)
        }
    }
    func current(_ epoch: Int, backgroundOnly: Bool = false) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return enabled && epoch == revision && (!backgroundOnly || !visible)
    }
    func resumeAfterTransfer() {
        lock.lock(); let epoch = revision; lock.unlock()
        Task {
            await engine.setPolicy(paused: false, cellularAllowed: cellular, ifCurrent: { self.current(epoch) })
            if current(epoch) { await engine.wake() }
        }
    }
}
extension Notification.Name { static let crewRollEngineInvalidated = Notification.Name("CrewRollEngineInvalidated") }

public final class CrewRollBackgroundTasks: ExpoAppDelegateSubscriber {
    private var listener: NSObjectProtocol?
    private var foregroundLease: UIBackgroundTaskIdentifier = .invalid
    public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: CrewRollAppleRuntime.taskID, using: nil) { task in
            guard let processing = task as? BGProcessingTask, let runtime = try? CrewRollAppleRuntime.get() else { task.setTaskCompleted(success: false); return }
            runtime.run(processing)
        }
        AppleBackgroundTransfer.shared.reconnect()
        listener = NotificationCenter.default.addObserver(forName: .crewRollBackgroundTransferFinished, object: nil, queue: .main) { _ in
            guard let runtime = try? CrewRollAppleRuntime.get(), runtime.enabled else { return }
            runtime.schedule()
            runtime.resumeAfterTransfer()
        }
        return true
    }
    public func applicationDidBecomeActive(_ application: UIApplication) {
        try? CrewRollAppleRuntime.get().foreground(true)
        if foregroundLease != .invalid { application.endBackgroundTask(foregroundLease); foregroundLease = .invalid }
    }
    public func applicationDidEnterBackground(_ application: UIApplication) {
        guard let runtime = try? CrewRollAppleRuntime.get(), runtime.enabled else { return }
        runtime.foreground(false)
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
}

private final class CrewRollProcessingCompletion {
    private let task: BGTask
    private let lock = NSLock()
    private var completed = false
    init(_ task: BGTask) { self.task = task }
    func finish(_ success: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return }; completed = true
        task.setTaskCompleted(success: success)
    }
}
