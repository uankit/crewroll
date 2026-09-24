import CoreFoundation
import Foundation

public struct NativeKeyError: Error, Equatable, CustomStringConvertible {
    public let code: String
    public var description: String { code }
    public static let accessLocked = Self(code: "KEY_ACCESS_LOCKED")
    public static let materialLost = Self(code: "KEY_MATERIAL_LOST")
    public static let invalidEnvelope = Self(code: "KEY_ENVELOPE_INVALID")
    public static let invalidState = Self(code: "ERR_CREWROLL_KEY_STATE")
    public static let invalidCommand = Self(code: "ERR_CREWROLL_NATIVE_PROTOCOL")
}

public protocol NativeKeyClock { var now: Date { get } }
public struct SystemNativeKeyClock: NativeKeyClock {
    public init() {}
    public var now: Date { Date() }
}

public struct NativeKeyScope: Codable, Equatable, Hashable, Sendable {
    public let accountHash: String
    public let installationID: String
    public init(accountHash: String, installationID: String) {
        self.accountHash = accountHash
        self.installationID = installationID
    }
}

public protocol AccountNamespaceHasher: AnyObject {
    func hash(accountID: String) throws -> String
}

public enum TripCreateOutcome: Equatable, Sendable { case created, existing, tombstoned }
public enum ProvisionalDiscardOutcome: Equatable, Sendable { case absent, discarded, protected }
public enum TripImportOutcome: Equatable, Sendable { case installed, existing, conflict }

public enum KeyState: String, Codable, Sendable { case provisional, installed, active, retained }

public struct TripKeyRecord: Codable, Equatable, Sendable {
    public var key: Data
    public var state: KeyState
    public let createdAt: Date?
    public let provisionalExpiresAt: Date?
    public init(
        key: Data,
        state: KeyState,
        createdAt: Date? = nil,
        provisionalExpiresAt: Date? = nil
    ) {
        self.key = key
        self.state = state
        self.createdAt = createdAt
        self.provisionalExpiresAt = provisionalExpiresAt
    }
}

public struct DeviceIdentityMaterial: Codable, Equatable, Sendable {
    public let installationID: String
    public let authenticationPublicKey: Data
    public let e2eePublicKey: Data
    public var e2eePrivateKey: Data
    public init(
        installationID: String,
        authenticationPublicKey: Data,
        e2eePublicKey: Data,
        e2eePrivateKey: Data
    ) {
        self.installationID = installationID
        self.authenticationPublicKey = authenticationPublicKey
        self.e2eePublicKey = e2eePublicKey
        self.e2eePrivateKey = e2eePrivateKey
    }
}

public struct DeviceSessionRecord: Codable, Equatable, Sendable {
    public let deviceID: String
    public var backgroundBearer: Data
    public let expiresAt: Date
    public let apiBaseURL: String
}

public struct ScopedDeviceSession: Codable, Equatable, Sendable {
    public let scope: NativeKeyScope
    public var session: DeviceSessionRecord
    public init(scope: NativeKeyScope, session: DeviceSessionRecord) {
        self.scope = scope
        self.session = session
    }
}

public struct ActiveTripMetadata: Codable, Equatable, Sendable {
    public let tripID: String
    public let membershipID: String
    public let startsAt: String
    public let endsAt: String
    public let releaseAt: String?
    public let keyEpoch: Int
    public init(
        tripID: String,
        membershipID: String,
        startsAt: String,
        endsAt: String,
        releaseAt: String?,
        keyEpoch: Int
    ) {
        self.tripID = tripID
        self.membershipID = membershipID
        self.startsAt = startsAt
        self.endsAt = endsAt
        self.releaseAt = releaseAt
        self.keyEpoch = keyEpoch
    }
}

public protocol NativeKeyStore: AnyObject {
    func eraseAccount(accountHash: String, removeIdentity: (NativeKeyScope) throws -> Void) throws
    func clearSession() throws
    func mediaContext() throws -> NativeMediaContext?
    func loadIdentity(accountHash: String) throws -> DeviceIdentityMaterial?
    func reservePendingIdentity(
        accountHash: String,
        makeInstallationID: () throws -> String
    ) throws -> NativeKeyScope
    func finalizeIdentity(scope: NativeKeyScope, value: DeviceIdentityMaterial) throws
    func hasScopedMaterial(accountHash: String) throws -> Bool
    func activeSession() throws -> ScopedDeviceSession?
    func installSession(scope: NativeKeyScope, value: DeviceSessionRecord) throws
    func createTrip(
        scope: NativeKeyScope,
        tripID: String,
        makeValue: () throws -> TripKeyRecord
    ) throws -> TripCreateOutcome
    func loadTrip(scope: NativeKeyScope, tripID: String) throws -> TripKeyRecord?
    func discardProvisional(
        scope: NativeKeyScope,
        tripID: String
    ) throws -> ProvisionalDiscardOutcome
    func collectExpiredProvisional(now: Date) throws -> Date?
    func importTrip(
        scope: NativeKeyScope,
        tripID: String,
        key: Data,
        constantTimeEquals: (Data, Data) -> Bool
    ) throws -> TripImportOutcome
    func activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) throws
    func deactivate(scope: NativeKeyScope, tripID: String) throws
}

public struct NativeMediaContext {
    public let scope: NativeKeyScope
    public var session: DeviceSessionRecord
    public let metadata: ActiveTripMetadata
    public var tripKey: Data
}

public extension NativeKeyStore {
    func eraseAccount(accountHash: String, removeIdentity: (NativeKeyScope) throws -> Void) throws { throw NativeKeyError.invalidCommand }
    func mediaContext() throws -> NativeMediaContext? { nil }
}

public protocol NativeKeyCrypto: AnyObject {
    func randomBytes(count: Int) throws -> Data
    func makeX25519KeyPair() throws -> (publicKey: Data, privateKey: Data)
    func deriveX25519PublicKey(privateKey: Data) throws -> Data
    func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool
    func zeroize(_ value: inout Data)
    func seal(_ plaintext: Data, recipientPublicKey: Data) throws -> Data
    func open(_ ciphertext: Data, publicKey: Data, privateKey: Data) throws -> Data
}

public protocol P256IdentityProvider: AnyObject {
    func removeIdentity(scope: NativeKeyScope) throws
    func createPublicKey(scope: NativeKeyScope) throws -> Data
    func loadPublicKey(scope: NativeKeyScope) throws -> Data?
}

public extension P256IdentityProvider {
    func removeIdentity(scope: NativeKeyScope) throws { throw NativeKeyError.invalidCommand }
}

public struct NativeDeviceIdentity: Equatable, Sendable {
    public let protocolVersion = 1
    public let installationID: String
    public let authenticationKeyAlgorithm = "P-256"
    public let authenticationPublicKey: String
    public let authenticationKeyVersion = 1
    public let e2eeKeyAlgorithm = "X25519"
    public let e2eePublicKey: String
    public let e2eeKeyVersion = 1
}

public struct CreateTripKeyResult: Equatable, Sendable {
    public let protocolVersion = 1
    public let tripID: String
    public let keyEpoch = 1
}

public struct WrapTripKeyResult: Equatable, Sendable {
    public let protocolVersion = 1
    public let tripID: String
    public let keyEpoch = 1
    public let algorithmVersion = 1
    public let senderDeviceID: String
    public let recipientDeviceID: String
    public let recipientE2EEKeyVersion = 1
    public let wrappedKey: String
}

public enum CanonicalBase64 {
    public static func encode(_ bytes: Data) -> String { bytes.base64EncodedString() }
    public static func decode(_ value: String, exactBytes: Int) throws -> Data {
        guard value.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) ||
                (48...57).contains($0) || $0 == 43 || $0 == 47 || $0 == 61
        }), let decoded = Data(base64Encoded: value), decoded.count == exactBytes,
        decoded.base64EncodedString() == value
        else { throw NativeKeyError.invalidEnvelope }
        return decoded
    }
}

public enum TripKeyEnvelopeV1 {
    public static func encode(
        tripID: String,
        senderDeviceID: String,
        recipientDeviceID: String,
        recipientE2EEKeyVersion: Int,
        tripKey: Data
    ) throws -> Data {
        guard recipientE2EEKeyVersion == 1, tripKey.count == 32 else {
            throw NativeKeyError.invalidCommand
        }
        var value = Data("CRTKENV1".utf8)
        value.appendUInt32(1)
        value.append(try uuidBytes(tripID))
        value.appendUInt32(1)
        value.append(try uuidBytes(senderDeviceID))
        value.append(try uuidBytes(recipientDeviceID))
        value.appendUInt32(1)
        value.append(tripKey)
        guard value.count == 100 else { throw NativeKeyError.invalidEnvelope }
        return value
    }

    public static func decode(
        _ value: Data,
        tripID: String,
        senderDeviceID: String,
        recipientDeviceID: String,
        recipientE2EEKeyVersion: Int
    ) throws -> Data {
        guard value.count == 100, recipientE2EEKeyVersion == 1,
              value.relativeSubdata(in: 0..<8) == Data("CRTKENV1".utf8),
              value.readUInt32(at: 8) == 1,
              value.relativeSubdata(in: 12..<28) == (try uuidBytes(tripID)),
              value.readUInt32(at: 28) == 1,
              value.relativeSubdata(in: 32..<48) == (try uuidBytes(senderDeviceID)),
              value.relativeSubdata(in: 48..<64) == (try uuidBytes(recipientDeviceID)),
              value.readUInt32(at: 64) == 1
        else { throw NativeKeyError.invalidEnvelope }
        return value.relativeSubdata(in: 68..<100)
    }

    private static func uuidBytes(_ string: String) throws -> Data {
        guard let uuid = UUID(uuidString: string) else { throw NativeKeyError.invalidCommand }
        var bytes = uuid.uuid
        return withUnsafeBytes(of: &bytes) { Data($0) }
    }
}

public enum NativeCommandKind: CaseIterable, Sendable {
    case ensureDeviceIdentity
    case restoreDeviceSession
    case installDeviceSession
    case createTripKey
    case discardProvisionalTripKey
    case wrapTripKey
    case importTripKey
    case activateTrip
    case deactivateTrip

    fileprivate var exactKeys: Set<String> {
        switch self {
        case .ensureDeviceIdentity:
            return ["protocolVersion", "accountId"]
        case .restoreDeviceSession:
            return ["protocolVersion", "accountId", "installationId", "apiBaseUrl"]
        case .installDeviceSession:
            return [
                "protocolVersion",
                "accountId",
                "installationId",
                "deviceId",
                "backgroundBearer",
                "backgroundBearerExpiresAt",
                "apiBaseUrl",
            ]
        case .createTripKey, .discardProvisionalTripKey:
            return ["protocolVersion", "tripId", "keyEpoch"]
        case .wrapTripKey:
            return [
                "protocolVersion",
                "tripId",
                "keyEpoch",
                "recipientDeviceId",
                "recipientE2eePublicKey",
                "recipientE2eeKeyVersion",
            ]
        case .importTripKey:
            return [
                "protocolVersion",
                "tripId",
                "keyEpoch",
                "algorithmVersion",
                "expectedSenderDeviceId",
                "recipientDeviceId",
                "recipientE2eeKeyVersion",
                "wrappedKey",
            ]
        case .activateTrip:
            return [
                "protocolVersion",
                "tripId",
                "membershipId",
                "startsAt",
                "endsAt",
                "releaseAt",
                "keyEpoch",
            ]
        case .deactivateTrip:
            return ["protocolVersion", "tripId"]
        }
    }

    fileprivate var hasTripID: Bool {
        self != .ensureDeviceIdentity && self != .installDeviceSession && self != .restoreDeviceSession
    }
}

public enum NativeCommandDecoder {
    public static func require(
        _ command: [String: Any],
        for kind: NativeCommandKind
    ) throws {
        guard Set(command.keys) == kind.exactKeys else {
            throw NativeKeyError.invalidCommand
        }
        try requireProtocol(command)
        if kind.hasTripID {
            try requireTripID(string(command, "tripId"))
        }
    }

    public static func requireProtocol(_ command: [String: Any]) throws {
        guard try integer(command, "protocolVersion") == 1 else {
            throw NativeKeyError.invalidCommand
        }
    }

    public static func string(_ command: [String: Any], _ key: String) throws -> String {
        guard let value = command[key] as? String, !value.isEmpty else {
            throw NativeKeyError.invalidCommand
        }
        return value
    }

    public static func integer(_ command: [String: Any], _ key: String) throws -> Int {
        guard let number = command[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { throw NativeKeyError.invalidCommand }
        let value = number.doubleValue
        guard value.isFinite,
              value.rounded(.towardZero) == value,
              value >= 0,
              value <= Double(UInt32.max)
        else { throw NativeKeyError.invalidCommand }
        return Int(value)
    }

    public static func date(_ command: [String: Any], _ key: String) throws -> Date {
        try rfc3339Date(string(command, key))
    }

    public static func activation(_ command: [String: Any]) throws -> ActiveTripMetadata {
        try require(command, for: .activateTrip)
        guard command.keys.contains("releaseAt") else { throw NativeKeyError.invalidCommand }
        let releaseAt: String?
        switch command["releaseAt"] {
        case is NSNull:
            releaseAt = nil
        case let value as String:
            _ = try rfc3339Date(value)
            releaseAt = value
        default:
            throw NativeKeyError.invalidCommand
        }
        let metadata = ActiveTripMetadata(
            tripID: try string(command, "tripId"),
            membershipID: try string(command, "membershipId"),
            startsAt: try string(command, "startsAt"),
            endsAt: try string(command, "endsAt"),
            releaseAt: releaseAt,
            keyEpoch: try integer(command, "keyEpoch")
        )
        try validate(metadata)
        return metadata
    }

    public static func validate(_ metadata: ActiveTripMetadata) throws {
        try requireTripID(metadata.tripID)
        try requireUUID(metadata.membershipID)
        _ = try rfc3339Date(metadata.startsAt)
        _ = try rfc3339Date(metadata.endsAt)
        if let releaseAt = metadata.releaseAt { _ = try rfc3339Date(releaseAt) }
        guard metadata.keyEpoch == 1 else { throw NativeKeyError.invalidCommand }
    }

    public static func requireTripID(_ value: String) throws {
        guard value.utf8.count == 36,
              let uuid = UUID(uuidString: value),
              uuid.uuidString.lowercased() == value,
              value[value.index(value.startIndex, offsetBy: 14)] == "7",
              "89ab".contains(value[value.index(value.startIndex, offsetBy: 19)])
        else { throw NativeKeyError.invalidCommand }
    }

    private static func requireUUID(_ value: String) throws {
        guard let uuid = UUID(uuidString: value),
              uuid.uuidString.lowercased() == value.lowercased()
        else { throw NativeKeyError.invalidCommand }
    }

    private static func rfc3339Date(_ raw: String) throws -> Date {
        guard raw.range(
            of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"#,
            options: .regularExpression
        ) != nil else { throw NativeKeyError.invalidCommand }
        let fields = String(raw.prefix(19)).components(
            separatedBy: CharacterSet(charactersIn: "-T:")
        )
        guard fields.count == 6,
              let year = Int(fields[0]), let month = Int(fields[1]),
              let day = Int(fields[2]), let hour = Int(fields[3]),
              let minute = Int(fields[4]), let second = Int(fields[5]),
              (0...23).contains(hour), (0...59).contains(minute),
              (0...59).contains(second)
        else { throw NativeKeyError.invalidCommand }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let firstOfMonth = calendar.date(
            from: DateComponents(year: year, month: month, day: 1)
        ), let days = calendar.range(of: .day, in: .month, for: firstOfMonth),
        days.contains(day)
        else { throw NativeKeyError.invalidCommand }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let wholeSecond = ISO8601DateFormatter()
        wholeSecond.formatOptions = [.withInternetDateTime]
        guard let value = fractional.date(from: raw) ?? wholeSecond.date(from: raw) else {
            throw NativeKeyError.invalidCommand
        }
        return value
    }
}

public protocol NativeKeyCleanupScheduling: AnyObject {
    func schedule(at date: Date, action: @escaping () -> Void)
    func cancel()
    func close()
}

public final class DispatchNativeKeyCleanupScheduler: NativeKeyCleanupScheduling {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "app.crewroll.native-key-cleanup")
    private var pending: DispatchWorkItem?
    private var isClosed = false

    public init() {}

    public func schedule(at date: Date, action: @escaping () -> Void) {
        let delay = max(0, date.timeIntervalSinceNow)
        let item = DispatchWorkItem(block: action)
        lock.lock()
        guard !isClosed else {
            lock.unlock()
            item.cancel()
            return
        }
        pending?.cancel()
        pending = item
        lock.unlock()
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    public func cancel() {
        lock.lock()
        pending?.cancel()
        pending = nil
        lock.unlock()
    }

    public func close() {
        lock.lock()
        isClosed = true
        pending?.cancel()
        pending = nil
        lock.unlock()
    }
}

public final class NativeKeyCleanupRunner {
    private let lock = NSLock()
    private let clock: NativeKeyClock
    private let store: NativeKeyStore

    public init(clock: NativeKeyClock, store: NativeKeyStore) {
        self.clock = clock
        self.store = store
    }

    public func run() throws -> Date? {
        lock.lock()
        defer { lock.unlock() }
        return try store.collectExpiredProvisional(now: clock.now)
    }
}

public final class NativeKeyCleanupCoordinator {
    private let lock = NSLock()
    private let runner: NativeKeyCleanupRunner
    private let scheduler: NativeKeyCleanupScheduling
    private var scheduledAt: Date?
    private var generation = 0
    private var isCancelled = false

    public init(
        runner: NativeKeyCleanupRunner,
        scheduler: NativeKeyCleanupScheduling
    ) {
        self.runner = runner
        self.scheduler = scheduler
    }

    public func reconcile() throws {
        lock.lock()
        defer { lock.unlock() }
        guard !isCancelled else { return }
        generation += 1
        scheduler.cancel()
        scheduledAt = nil
        let nextExpiry = try runner.run()
        if let nextExpiry {
            armLocked(at: nextExpiry)
        }
    }

    public func schedule(at date: Date) {
        lock.lock()
        defer { lock.unlock() }
        guard !isCancelled else { return }
        if let scheduledAt, scheduledAt <= date { return }
        generation += 1
        scheduler.cancel()
        armLocked(at: date)
    }

    public func cancel() {
        lock.lock()
        guard !isCancelled else {
            lock.unlock()
            return
        }
        isCancelled = true
        generation += 1
        scheduledAt = nil
        scheduler.close()
        lock.unlock()
    }

    private func armLocked(at date: Date) {
        let expectedGeneration = generation
        scheduledAt = date
        scheduler.schedule(at: date) { [weak self] in
            self?.fire(expectedGeneration: expectedGeneration, scheduledAt: date)
        }
    }

    private func fire(expectedGeneration: Int, scheduledAt date: Date) {
        lock.lock()
        defer { lock.unlock() }
        guard !isCancelled,
              generation == expectedGeneration,
              scheduledAt == date
        else { return }
        scheduledAt = nil
        do {
            if let nextExpiry = try runner.run() {
                generation += 1
                armLocked(at: nextExpiry)
            }
        } catch {
            // Access-locked/transient failures remain disarmed until the next wake.
        }
    }
}

public final class NativeKeyLifecycle {
    private let clock: NativeKeyClock
    private let store: NativeKeyStore
    private let crypto: NativeKeyCrypto
    private let p256: P256IdentityProvider
    private let accountHasher: AccountNamespaceHasher
    private let cleanupRunner: NativeKeyCleanupRunner
    private let cleanupCoordinator: NativeKeyCleanupCoordinator?

    public init(
        clock: NativeKeyClock,
        store: NativeKeyStore,
        crypto: NativeKeyCrypto,
        p256: P256IdentityProvider,
        accountHasher: AccountNamespaceHasher,
        cleanupScheduler: NativeKeyCleanupScheduling? = nil
    ) {
        self.clock = clock
        self.store = store
        self.crypto = crypto
        self.p256 = p256
        self.accountHasher = accountHasher
        let runner = NativeKeyCleanupRunner(clock: clock, store: store)
        cleanupRunner = runner
        cleanupCoordinator = cleanupScheduler.map {
            NativeKeyCleanupCoordinator(runner: runner, scheduler: $0)
        }
    }

    deinit {
        cleanupCoordinator?.cancel()
    }

    public func ensureDeviceIdentity(accountID: String) throws -> NativeDeviceIdentity {
        try prepare()
        let accountHash = try hashAccountID(accountID)
        if var existing = try store.loadIdentity(accountHash: accountHash) {
            defer { crypto.zeroize(&existing.e2eePrivateKey) }
            let scope = NativeKeyScope(
                accountHash: accountHash,
                installationID: existing.installationID
            )
            return try publicIdentity(validating: existing, scope: scope)
        }
        guard try !store.hasScopedMaterial(accountHash: accountHash) else {
            throw NativeKeyError.materialLost
        }
        let scope = try store.reservePendingIdentity(
            accountHash: accountHash,
            makeInstallationID: {
                var installationBytes = try self.crypto.randomBytes(count: 16)
                defer { self.crypto.zeroize(&installationBytes) }
                guard installationBytes.count == 16 else { throw NativeKeyError.materialLost }
                let value = installationBytes.base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "")
                guard self.validInstallationID(value) else { throw NativeKeyError.materialLost }
                return value
            }
        )
        let authenticationPublicKey: Data
        if let existingKey = try p256.loadPublicKey(scope: scope) {
            authenticationPublicKey = existingKey
        } else {
            authenticationPublicKey = try p256.createPublicKey(scope: scope)
        }
        var pair = try crypto.makeX25519KeyPair()
        defer { crypto.zeroize(&pair.privateKey) }
        guard authenticationPublicKey.count == 65,
              authenticationPublicKey.first == 0x04,
              pair.publicKey.count == 32,
              pair.privateKey.count == 32,
              try validX25519Pair(publicKey: pair.publicKey, privateKey: pair.privateKey)
        else { throw NativeKeyError.materialLost }
        try store.finalizeIdentity(
            scope: scope,
            value: DeviceIdentityMaterial(
                installationID: scope.installationID,
                authenticationPublicKey: authenticationPublicKey,
                e2eePublicKey: pair.publicKey,
                e2eePrivateKey: pair.privateKey
            )
        )
        guard var persisted = try store.loadIdentity(accountHash: accountHash) else {
            throw NativeKeyError.materialLost
        }
        defer { crypto.zeroize(&persisted.e2eePrivateKey) }
        guard persisted.installationID == scope.installationID else {
            throw NativeKeyError.materialLost
        }
        return try publicIdentity(validating: persisted, scope: scope)
    }

    /// Reads only the public device ID; bearer and key material stay native.
    public func restoreDeviceSession(accountID: String, installationID: String, apiBaseURL: String) throws -> String? {
        try prepare()
        let accountHash = try hashAccountID(accountID)
        guard validInstallationID(installationID), URL(string: apiBaseURL)?.scheme == "https" else {
            throw NativeKeyError.invalidCommand
        }
        guard var saved = try store.activeSession() else { return nil }
        defer { crypto.zeroize(&saved.session.backgroundBearer) }
        guard saved.scope == NativeKeyScope(accountHash: accountHash, installationID: installationID),
              saved.session.apiBaseURL == apiBaseURL,
              saved.session.expiresAt > clock.now.addingTimeInterval(300) else { return nil }
        try withValidatedIdentity(scope: saved.scope) { _ in () }
        _ = try TripKeyEnvelopeV1.encodeUUID(saved.session.deviceID)
        return saved.session.deviceID
    }

    public func installDeviceSession(
        accountID: String,
        installationID: String,
        deviceID: String,
        backgroundBearer: String,
        expiresAt: Date,
        apiBaseURL: String
    ) throws {
        try prepare()
        let accountHash = try hashAccountID(accountID)
        guard validInstallationID(installationID) else { throw NativeKeyError.materialLost }
        guard var identity = try store.loadIdentity(accountHash: accountHash) else {
            throw NativeKeyError.materialLost
        }
        defer { crypto.zeroize(&identity.e2eePrivateKey) }
        guard identity.installationID == installationID else {
            throw NativeKeyError.materialLost
        }
        let scope = NativeKeyScope(accountHash: accountHash, installationID: installationID)
        _ = try publicIdentity(validating: identity, scope: scope)
        _ = try TripKeyEnvelopeV1.encodeUUID(deviceID)
        guard backgroundBearer.range(
            of: "^crb_[A-Za-z0-9_-]{12,512}$",
            options: .regularExpression
        ) != nil,
              let url = URL(string: apiBaseURL), url.scheme == "https"
        else { throw NativeKeyError.invalidCommand }
        guard var bearer = backgroundBearer.data(using: .utf8) else {
            throw NativeKeyError.invalidCommand
        }
        defer { crypto.zeroize(&bearer) }
        try store.installSession(
            scope: scope,
            value:
            DeviceSessionRecord(
                deviceID: deviceID,
                backgroundBearer: bearer,
                expiresAt: expiresAt,
                apiBaseURL: apiBaseURL
            )
        )
    }

    public func createTripKey(tripID: String, keyEpoch: Int) throws -> CreateTripKeyResult {
        let session = try currentSession()
        try requireV1(tripID: tripID, keyEpoch: keyEpoch)
        var createdExpiry: Date?
        let result = try store.createTrip(
            scope: session.scope,
            tripID: tripID,
            makeValue: {
                var key = try self.crypto.randomBytes(count: 32)
                defer { self.crypto.zeroize(&key) }
                guard key.count == 32 else { throw NativeKeyError.materialLost }
                let now = self.clock.now
                let expiresAt = now.addingTimeInterval(86_400)
                createdExpiry = expiresAt
                return TripKeyRecord(
                    key: key,
                    state: .provisional,
                    createdAt: now,
                    provisionalExpiresAt: expiresAt
                )
            }
        )
        if result == .tombstoned { throw NativeKeyError.materialLost }
        if result == .created, let createdExpiry {
            cleanupCoordinator?.schedule(at: createdExpiry)
        }
        return CreateTripKeyResult(tripID: tripID)
    }

    public func discardProvisionalTripKey(tripID: String, keyEpoch: Int) throws {
        let session = try currentSession()
        try requireV1(tripID: tripID, keyEpoch: keyEpoch)
        if try store.discardProvisional(scope: session.scope, tripID: tripID) == .protected {
            throw NativeKeyError.invalidState
        }
    }

    public func collectExpiredProvisionalKeys() throws {
        try reconcileCleanup()
    }

    public func runScheduledCleanup() throws {
        try reconcileCleanup()
    }

    public func cancelScheduledCleanup() {
        cleanupCoordinator?.cancel()
    }

    public func wrapTripKey(
        tripID: String,
        keyEpoch: Int,
        recipientDeviceID: String,
        recipientE2EEPublicKey: String,
        recipientE2EEKeyVersion: Int
    ) throws -> WrapTripKeyResult {
        let scopedSession = try currentSession()
        try requireV1(tripID: tripID, keyEpoch: keyEpoch)
        guard recipientE2EEKeyVersion == 1 else { throw NativeKeyError.materialLost }
        guard var record = try store.loadTrip(
            scope: scopedSession.scope,
            tripID: tripID
        ) else { throw NativeKeyError.materialLost }
        defer { crypto.zeroize(&record.key) }
        guard record.key.count == 32, record.state != .retained else {
            throw NativeKeyError.materialLost
        }
        let recipientKey = try CanonicalBase64.decode(recipientE2EEPublicKey, exactBytes: 32)
        var tripKey = record.key
        var plaintext = Data()
        var envelope = Data()
        defer {
            crypto.zeroize(&tripKey)
            crypto.zeroize(&plaintext)
            crypto.zeroize(&envelope)
        }
        plaintext = try TripKeyEnvelopeV1.encode(
            tripID: tripID,
            senderDeviceID: scopedSession.deviceID,
            recipientDeviceID: recipientDeviceID,
            recipientE2EEKeyVersion: 1,
            tripKey: tripKey
        )
        envelope = try crypto.seal(plaintext, recipientPublicKey: recipientKey)
        guard envelope.count == 148 else { throw NativeKeyError.invalidEnvelope }
        let encodedEnvelope = CanonicalBase64.encode(envelope)
        return WrapTripKeyResult(
            tripID: tripID,
            senderDeviceID: scopedSession.deviceID,
            recipientDeviceID: recipientDeviceID,
            wrappedKey: encodedEnvelope
        )
    }

    public func importTripKey(
        tripID: String,
        keyEpoch: Int,
        algorithmVersion: Int,
        expectedSenderDeviceID: String,
        recipientDeviceID: String,
        recipientE2EEKeyVersion: Int,
        wrappedKey: String
    ) throws {
        var envelope = Data()
        var plaintext = Data()
        var key = Data()
        defer {
            crypto.zeroize(&envelope)
            crypto.zeroize(&plaintext)
            crypto.zeroize(&key)
        }
        do {
            let scopedSession = try currentSession()
            try requireV1(tripID: tripID, keyEpoch: keyEpoch)
            guard algorithmVersion == 1, recipientE2EEKeyVersion == 1,
                  scopedSession.deviceID == recipientDeviceID
            else { throw NativeKeyError.invalidEnvelope }
            envelope = try CanonicalBase64.decode(wrappedKey, exactBytes: 148)
            plaintext = try withValidatedIdentity(scope: scopedSession.scope) { material in
                try crypto.open(
                    envelope,
                    publicKey: material.e2eePublicKey,
                    privateKey: material.e2eePrivateKey
                )
            }
            key = try TripKeyEnvelopeV1.decode(
                plaintext,
                tripID: tripID,
                senderDeviceID: expectedSenderDeviceID,
                recipientDeviceID: recipientDeviceID,
                recipientE2EEKeyVersion: 1
            )
            if try store.importTrip(
                scope: scopedSession.scope,
                tripID: tripID,
                key: key,
                constantTimeEquals: crypto.constantTimeEquals
            ) == .conflict {
                throw NativeKeyError.invalidEnvelope
            }
        } catch let error as NativeKeyError {
            if error.code == NativeKeyError.accessLocked.code ||
                error.code == NativeKeyError.materialLost.code { throw error }
            throw NativeKeyError.invalidEnvelope
        } catch {
            throw NativeKeyError.invalidEnvelope
        }
    }

    public func activateTrip(_ metadata: ActiveTripMetadata) throws {
        try NativeCommandDecoder.validate(metadata)
        let session = try currentSession()
        try store.activate(scope: session.scope, metadata: metadata)
    }

    public func clearDeviceSession() throws { try store.clearSession() }
    public func eraseAccount(accountID: String) throws -> String {
        let hash = try hashAccountID(accountID)
        try store.eraseAccount(accountHash: hash, removeIdentity: { try self.p256.removeIdentity(scope: $0) })
        return hash
    }

    public func deactivateTrip(tripID: String) throws {
        let session = try currentSession()
        try NativeCommandDecoder.requireTripID(tripID)
        try store.deactivate(scope: session.scope, tripID: tripID)
    }

    /// Native-only: key and bearer never cross the JavaScript bridge.
    public func mediaContext() throws -> NativeMediaContext? {
        try prepare()
        guard let context = try store.mediaContext() else { return nil }
        try withValidatedIdentity(scope: context.scope) { _ in () }
        guard context.tripKey.count == 32, context.session.expiresAt > clock.now else {
            throw NativeKeyError.materialLost
        }
        try NativeCommandDecoder.validate(context.metadata)
        return context
    }

    private func prepare() throws {
        try reconcileCleanup()
    }

    private func reconcileCleanup() throws {
        if let cleanupCoordinator {
            try cleanupCoordinator.reconcile()
        } else {
            _ = try cleanupRunner.run()
        }
    }

    private struct SessionContext {
        let scope: NativeKeyScope
        let deviceID: String
    }

    private func currentSession() throws -> SessionContext {
        try prepare()
        guard var session = try store.activeSession() else { throw NativeKeyError.materialLost }
        defer { crypto.zeroize(&session.session.backgroundBearer) }
        try withValidatedIdentity(scope: session.scope) { _ in () }
        return SessionContext(scope: session.scope, deviceID: session.session.deviceID)
    }

    private func withValidatedIdentity<T>(
        scope: NativeKeyScope,
        body: (DeviceIdentityMaterial) throws -> T
    ) throws -> T {
        guard var material = try store.loadIdentity(accountHash: scope.accountHash) else {
            throw NativeKeyError.materialLost
        }
        defer { crypto.zeroize(&material.e2eePrivateKey) }
        guard material.installationID == scope.installationID else {
            throw NativeKeyError.materialLost
        }
        _ = try publicIdentity(validating: material, scope: scope)
        return try body(material)
    }

    private func publicIdentity(
        validating material: DeviceIdentityMaterial,
        scope: NativeKeyScope
    ) throws -> NativeDeviceIdentity {
        guard let authenticationPublicKey = try p256.loadPublicKey(scope: scope),
              material.authenticationPublicKey.count == 65,
              material.authenticationPublicKey.first == 0x04,
              crypto.constantTimeEquals(material.authenticationPublicKey, authenticationPublicKey),
              material.e2eePublicKey.count == 32,
              material.e2eePrivateKey.count == 32,
              try validX25519Pair(
                  publicKey: material.e2eePublicKey,
                  privateKey: material.e2eePrivateKey
              )
        else { throw NativeKeyError.materialLost }
        return NativeDeviceIdentity(
            installationID: material.installationID,
            authenticationPublicKey: CanonicalBase64.encode(material.authenticationPublicKey),
            e2eePublicKey: CanonicalBase64.encode(material.e2eePublicKey)
        )
    }

    private func validX25519Pair(publicKey: Data, privateKey: Data) throws -> Bool {
        var privateCopy = privateKey
        var derived = Data()
        defer {
            crypto.zeroize(&privateCopy)
            crypto.zeroize(&derived)
        }
        derived = try crypto.deriveX25519PublicKey(privateKey: privateCopy)
        return derived.count == 32 && crypto.constantTimeEquals(derived, publicKey)
    }

    private func hashAccountID(_ accountID: String) throws -> String {
        guard (1...255).contains(accountID.utf8.count),
              accountID.utf8.allSatisfy({
                  (65...90).contains($0) || (97...122).contains($0) ||
                      (48...57).contains($0) || $0 == 95 || $0 == 45
              })
        else { throw NativeKeyError.invalidCommand }
        let value = try accountHasher.hash(accountID: accountID)
        guard value.utf8.count == 64, value.utf8.allSatisfy({
            (48...57).contains($0) || (97...102).contains($0)
        }) else { throw NativeKeyError.materialLost }
        return value
    }

    private func validInstallationID(_ value: String) -> Bool {
        (8...128).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) ||
                (48...57).contains($0) || $0 == 95 || $0 == 45
        }
    }

    private func requireV1(tripID: String, keyEpoch: Int) throws {
        guard keyEpoch == 1 else { throw NativeKeyError.invalidCommand }
        try NativeCommandDecoder.requireTripID(tripID)
    }
}

private extension TripKeyEnvelopeV1 {
    static func encodeUUID(_ string: String) throws -> Data {
        guard let uuid = UUID(uuidString: string) else { throw NativeKeyError.invalidCommand }
        var bytes = uuid.uuid
        return withUnsafeBytes(of: &bytes) { Data($0) }
    }
}

private extension Data {
    mutating func appendUInt32(_ value: UInt32) {
        var bigEndian = value.bigEndian
        append(Swift.withUnsafeBytes(of: &bigEndian) { Data($0) })
    }
    func relativeSubdata(in offsets: Range<Int>) -> Data {
        let lower = index(startIndex, offsetBy: offsets.lowerBound)
        let upper = index(startIndex, offsetBy: offsets.upperBound)
        return subdata(in: lower..<upper)
    }
    func readUInt32(at offset: Int) -> UInt32 {
        let lower = index(startIndex, offsetBy: offset)
        let upper = index(lower, offsetBy: 4)
        return self[lower..<upper].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }
}
