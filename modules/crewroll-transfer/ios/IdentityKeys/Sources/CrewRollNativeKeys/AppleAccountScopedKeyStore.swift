import Clibsodium
import Foundation
import Security

private struct AppleScopedState: Codable {
    let scope: NativeKeyScope
    var session: DeviceSessionRecord?
    var trips: [String: TripKeyRecord] = [:]
    var tombstones: Set<String> = []
    var activeMetadata: ActiveTripMetadata?
    var frozenMetadata: [String: ActiveTripMetadata] = [:]
}

private struct AppleScopedDatabase: Codable {
    var identities: [String: DeviceIdentityMaterial] = [:]
    var pendingIdentities: [String: String] = [:]
    var scopes: [String: AppleScopedState] = [:]
    var selectedScope: NativeKeyScope?

    private enum CodingKeys: String, CodingKey {
        case identities, pendingIdentities, scopes, selectedScope
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        identities = try container.decodeIfPresent(
            [String: DeviceIdentityMaterial].self,
            forKey: .identities
        ) ?? [:]
        pendingIdentities = try container.decodeIfPresent(
            [String: String].self,
            forKey: .pendingIdentities
        ) ?? [:]
        scopes = try container.decodeIfPresent(
            [String: AppleScopedState].self,
            forKey: .scopes
        ) ?? [:]
        selectedScope = try container.decodeIfPresent(
            NativeKeyScope.self,
            forKey: .selectedScope
        )
    }
}

/// A new v2 record keeps the unreleased v1 records untouched. All logical
/// aliases inside the authenticated record use only account hashes and
/// installation IDs, and every mutation commits as one Keychain update.
public final class AppleAccountScopedKeyStore: NativeKeyStore {
    private let service: String
    private let databaseAccount = "scoped-database.v2"
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let lock = NSRecursiveLock()

    public convenience init() {
        self.init(service: "com.uankit53.airmesh.native-keys.v2")
    }

    init(service: String) {
        self.service = service
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        decoder.dateDecodingStrategy = .millisecondsSince1970
    }

    public func loadIdentity(accountHash: String) throws -> DeviceIdentityMaterial? {
        try read { database in
            database.identities[accountHash].map(scopedIdentityCopy)
        }
    }

    public func eraseAccount(accountHash: String, removeIdentity: (NativeKeyScope) throws -> Void) throws {
        guard scopedValidAccountHash(accountHash) else { throw NativeKeyError.invalidCommand }
        try transaction { database in
            var installations = Set(database.scopes.values.filter { $0.scope.accountHash == accountHash }.map { $0.scope.installationID })
            if let identity = database.identities[accountHash] { installations.insert(identity.installationID) }
            if let pending = database.pendingIdentities[accountHash] { installations.insert(pending) }
            // Delete hardware keys before committing the record removal, so a
            // locked Keychain leaves enough information for an idempotent retry.
            for installation in installations { try removeIdentity(NativeKeyScope(accountHash: accountHash, installationID: installation)) }
            if var identity = database.identities.removeValue(forKey: accountHash) {
                scopedSecureZero(&identity.e2eePrivateKey)
            }
            database.pendingIdentities.removeValue(forKey: accountHash)
            for key in Array(database.scopes.keys) where database.scopes[key]?.scope.accountHash == accountHash {
                database.scopes[key]?.secureClearSession()
                for tripID in Array(database.scopes[key]?.trips.keys ?? Dictionary<String, TripKeyRecord>().keys) {
                    database.scopes[key]?.secureRemoveTrip(tripID)
                }
                database.scopes.removeValue(forKey: key)
            }
            if database.selectedScope?.accountHash == accountHash { database.selectedScope = nil }
        }
    }

    public func reservePendingIdentity(
        accountHash: String,
        makeInstallationID: () throws -> String
    ) throws -> NativeKeyScope {
        try transaction { database in
            guard scopedValidAccountHash(accountHash) else {
                throw NativeKeyError.materialLost
            }
            if let installationID = database.pendingIdentities[accountHash] {
                guard scopedValidInstallationID(installationID),
                      database.identities[accountHash] == nil,
                      !database.scopes.values.contains(where: {
                          $0.scope.accountHash == accountHash
                      })
                else {
                    throw NativeKeyError.materialLost
                }
                return NativeKeyScope(accountHash: accountHash, installationID: installationID)
            }
            guard database.identities[accountHash] == nil,
                  !database.scopes.values.contains(where: {
                      $0.scope.accountHash == accountHash
                  })
            else { throw NativeKeyError.materialLost }
            let installationID = try makeInstallationID()
            guard scopedValidInstallationID(installationID) else {
                throw NativeKeyError.materialLost
            }
            database.pendingIdentities[accountHash] = installationID
            return NativeKeyScope(accountHash: accountHash, installationID: installationID)
        }
    }

    public func finalizeIdentity(
        scope: NativeKeyScope,
        value: DeviceIdentityMaterial
    ) throws {
        try transaction { database in
            guard scopedValidAccountHash(scope.accountHash),
                  scopedValidInstallationID(scope.installationID),
                  database.pendingIdentities[scope.accountHash] == scope.installationID,
                  value.installationID == scope.installationID,
                  database.identities[scope.accountHash] == nil
            else { throw NativeKeyError.materialLost }
            database.identities[scope.accountHash] = scopedIdentityCopy(value)
            let key = scopeKey(scope)
            database.scopes[key] = database.scopes[key] ?? AppleScopedState(scope: scope)
            database.pendingIdentities.removeValue(forKey: scope.accountHash)
        }
    }

    public func hasScopedMaterial(accountHash: String) throws -> Bool {
        try read { database in
            database.scopes.values.contains { state in
                state.scope.accountHash == accountHash &&
                    (state.session != nil || !state.trips.isEmpty ||
                        !state.tombstones.isEmpty || state.activeMetadata != nil)
            }
        }
    }

    public func activeSession() throws -> ScopedDeviceSession? {
        try read { database in
            guard let scope = database.selectedScope,
                  let session = database.scopes[scopeKey(scope)]?.session
            else { return nil }
            return ScopedDeviceSession(scope: scope, session: scopedSessionCopy(session))
        }
    }

    public func installSession(scope: NativeKeyScope, value: DeviceSessionRecord) throws {
        try transaction { database in
            if let prior = database.selectedScope, prior != scope {
                let priorKey = scopeKey(prior)
                database.scopes[priorKey]?.secureClearSession()
                if var priorState = database.scopes[priorKey] {
                    if let activeID = priorState.activeMetadata?.tripID,
                       var active = priorState.trips[activeID] {
                        active.state = .installed
                        priorState.trips[activeID] = active
                    }
                    priorState.activeMetadata = nil
                    database.scopes[priorKey] = priorState
                }
            }
            let key = scopeKey(scope)
            if database.scopes[key] == nil {
                database.scopes[key] = AppleScopedState(scope: scope)
            }
            database.scopes[key]!.secureClearSession()
            database.scopes[key]!.session = scopedSessionCopy(value)
            database.selectedScope = scope
        }
    }

    public func clearSession() throws {
        try transaction { database in
            if let scope = database.selectedScope {
                let key = scopeKey(scope)
                database.scopes[key]?.secureClearSession()
                if var state = database.scopes[key] {
                    if let id = state.activeMetadata?.tripID, var trip = state.trips[id] {
                        trip.state = .installed
                        state.trips[id] = trip
                    }
                    state.activeMetadata = nil
                    database.scopes[key] = state
                }
            }
            database.selectedScope = nil
        }
    }

    public func createTrip(
        scope: NativeKeyScope,
        tripID: String,
        makeValue: () throws -> TripKeyRecord
    ) throws -> TripCreateOutcome {
        try transaction { database in
            let key = scopeKey(scope)
            var state = database.scopes[key] ?? AppleScopedState(scope: scope)
            if state.tombstones.contains(tripID) { return .tombstoned }
            if state.trips[tripID] != nil { return .existing }
            var value = try makeValue()
            defer { scopedSecureZero(&value.key) }
            state.trips[tripID] = scopedTripCopy(value)
            database.scopes[key] = state
            return .created
        }
    }

    public func loadTrip(scope: NativeKeyScope, tripID: String) throws -> TripKeyRecord? {
        try read { database in
            guard let record = database.scopes[scopeKey(scope)]?.trips[tripID] else {
                return nil
            }
            guard record.key.count == 32 else { throw NativeKeyError.materialLost }
            return scopedTripCopy(record)
        }
    }

    public func discardProvisional(
        scope: NativeKeyScope,
        tripID: String
    ) throws -> ProvisionalDiscardOutcome {
        try transaction { database in
            let key = scopeKey(scope)
            guard let recordState = database.scopes[key]?.trips[tripID]?.state else {
                return .absent
            }
            guard recordState == .provisional else { return .protected }
            database.scopes[key]!.secureRemoveTrip(tripID)
            database.scopes[key]!.tombstones.insert(tripID)
            return .discarded
        }
    }

    public func collectExpiredProvisional(now: Date) throws -> Date? {
        try transaction { database in
            for key in Array(database.scopes.keys) {
                guard database.scopes[key] != nil else { continue }
                for tripID in Array(database.scopes[key]!.trips.keys) {
                    guard database.scopes[key]?.trips[tripID]?.state == .provisional else {
                        continue
                    }
                    guard let expiresAt = database.scopes[key]?.trips[tripID]?.provisionalExpiresAt else {
                        throw NativeKeyError.materialLost
                    }
                    guard expiresAt <= now,
                          database.scopes[key]?.trips[tripID]?.state == .provisional
                    else { continue }
                    database.scopes[key]!.secureRemoveTrip(tripID)
                    database.scopes[key]!.tombstones.insert(tripID)
                }
            }
            return try database.scopes.values.reduce(nil as Date?) { next, state in
                try state.trips.values.reduce(next) { earliest, record in
                    guard record.state == .provisional else { return earliest }
                    guard let expiresAt = record.provisionalExpiresAt else {
                        throw NativeKeyError.materialLost
                    }
                    return min(earliest ?? expiresAt, expiresAt)
                }
            }
        }
    }

    public func importTrip(
        scope: NativeKeyScope,
        tripID: String,
        key: Data,
        constantTimeEquals: (Data, Data) -> Bool
    ) throws -> TripImportOutcome {
        try transaction { database in
            guard key.count == 32 else { throw NativeKeyError.invalidEnvelope }
            let alias = scopeKey(scope)
            var state = database.scopes[alias] ?? AppleScopedState(scope: scope)
            if var existing = state.trips[tripID] {
                guard constantTimeEquals(existing.key, key) else { return .conflict }
                if existing.state == .provisional { existing.state = .installed }
                state.trips[tripID] = existing
                state.tombstones.remove(tripID)
                database.scopes[alias] = state
                return .existing
            }
            state.trips[tripID] = TripKeyRecord(
                key: scopedSecretCopy(key),
                state: .installed
            )
            state.tombstones.remove(tripID)
            database.scopes[alias] = state
            return .installed
        }
    }

    public func activate(scope: NativeKeyScope, metadata: ActiveTripMetadata) throws {
        try transaction { database in
            let key = scopeKey(scope)
            guard var state = database.scopes[key],
                  var target = state.trips[metadata.tripID],
                  target.key.count == 32,
                  target.state == .installed || target.state == .active
            else { throw NativeKeyError.materialLost }
            if let frozen = state.frozenMetadata[metadata.tripID], frozen != metadata {
                throw NativeKeyError.invalidState
            }
            if let priorID = state.activeMetadata?.tripID,
               priorID != metadata.tripID,
               var prior = state.trips[priorID] {
                prior.state = .installed
                state.trips[priorID] = prior
            }
            target.state = .active
            state.trips[metadata.tripID] = target
            state.frozenMetadata[metadata.tripID] = metadata
            state.activeMetadata = metadata
            database.scopes[key] = state
        }
    }

    public func deactivate(scope: NativeKeyScope, tripID: String) throws {
        try transaction { database in
            let key = scopeKey(scope)
            guard var state = database.scopes[key],
                  state.activeMetadata?.tripID == tripID
            else { return }
            if var trip = state.trips[tripID] {
                trip.state = .installed
                state.trips[tripID] = trip
            }
            state.activeMetadata = nil
            database.scopes[key] = state
        }
    }

    public func mediaContext() throws -> NativeMediaContext? {
        try read { database in
            guard let scope = database.selectedScope,
                  let state = database.scopes[scopeKey(scope)],
                  let session = state.session,
                  let metadata = state.activeMetadata,
                  let trip = state.trips[metadata.tripID], trip.state == .active else { return nil }
            return NativeMediaContext(scope: scope, session: session, metadata: metadata, tripKey: trip.key)
        }
    }

    private func scopeKey(_ scope: NativeKeyScope) -> String {
        "\(scope.accountHash).\(scope.installationID)"
    }

    private func read<T>(_ body: (AppleScopedDatabase) throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        var database = try loadDatabase()
        defer { database.scopedZeroize() }
        return try body(database)
    }

    private func transaction<T>(
        _ body: (inout AppleScopedDatabase) throws -> T
    ) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        var database = try loadDatabase()
        defer { database.scopedZeroize() }
        let result = try body(&database)
        try saveDatabase(database)
        return result
    }

    private func loadDatabase() throws -> AppleScopedDatabase {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: databaseAccount,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecAttrSynchronizable: false,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return AppleScopedDatabase() }
        try scopedCheckKeychain(status)
        guard var data = result as? Data else { throw NativeKeyError.materialLost }
        result = nil
        defer { scopedSecureZero(&data) }
        do { return try decoder.decode(AppleScopedDatabase.self, from: data) }
        catch { throw NativeKeyError.materialLost }
    }

    private func saveDatabase(_ database: AppleScopedDatabase) throws {
        var data: Data
        do { data = try encoder.encode(database) }
        catch { throw NativeKeyError.materialLost }
        defer { scopedSecureZero(&data) }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: databaseAccount,
            kSecAttrSynchronizable: false,
        ]
        var update: [CFString: Any] = [kSecValueData: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        update.removeValue(forKey: kSecValueData)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            add.removeValue(forKey: kSecValueData)
            try scopedCheckKeychain(addStatus)
        } else {
            try scopedCheckKeychain(status)
        }
    }
}

private func scopedIdentityCopy(_ value: DeviceIdentityMaterial) -> DeviceIdentityMaterial {
    DeviceIdentityMaterial(
        installationID: value.installationID,
        authenticationPublicKey: Data(value.authenticationPublicKey),
        e2eePublicKey: Data(value.e2eePublicKey),
        e2eePrivateKey: scopedSecretCopy(value.e2eePrivateKey)
    )
}

private func scopedSessionCopy(_ value: DeviceSessionRecord) -> DeviceSessionRecord {
    DeviceSessionRecord(
        deviceID: value.deviceID,
        backgroundBearer: scopedSecretCopy(value.backgroundBearer),
        expiresAt: value.expiresAt,
        apiBaseURL: value.apiBaseURL
    )
}

private func scopedTripCopy(_ value: TripKeyRecord) -> TripKeyRecord {
    TripKeyRecord(
        key: scopedSecretCopy(value.key),
        state: value.state,
        createdAt: value.createdAt,
        provisionalExpiresAt: value.provisionalExpiresAt
    )
}

private func scopedSecretCopy(_ value: Data) -> Data {
    var bytes = [UInt8](value)
    defer { sodium_memzero(&bytes, bytes.count) }
    return Data(bytes)
}

private func scopedValidAccountHash(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
}

private func scopedValidInstallationID(_ value: String) -> Bool {
    value.range(
        of: "^[A-Za-z0-9_-]{8,128}$",
        options: .regularExpression
    ) != nil
}

private extension AppleScopedState {
    mutating func secureClearSession() {
        guard session != nil else { return }
        scopedSecureZero(&session!.backgroundBearer)
        session = nil
    }

    mutating func secureRemoveTrip(_ tripID: String) {
        guard trips[tripID] != nil else { return }
        scopedSecureZero(&trips[tripID]!.key)
        trips.removeValue(forKey: tripID)
    }
}

private extension AppleScopedDatabase {
    mutating func scopedZeroize() {
        while let entry = identities.popFirst() {
            var identity = entry.value
            scopedSecureZero(&identity.e2eePrivateKey)
        }
        while let entry = scopes.popFirst() {
            var state = entry.value
            if var session = state.session {
                state.session = nil
                scopedSecureZero(&session.backgroundBearer)
            }
            while let tripEntry = state.trips.popFirst() {
                var record = tripEntry.value
                scopedSecureZero(&record.key)
            }
        }
        pendingIdentities.removeAll(keepingCapacity: false)
        selectedScope = nil
    }
}

private func scopedSecureZero(_ value: inout Data) {
    value.withUnsafeMutableBytes { bytes in
        if let baseAddress = bytes.baseAddress {
            sodium_memzero(baseAddress, bytes.count)
        }
    }
}

private func scopedCheckKeychain(_ status: OSStatus) throws {
    if status == errSecSuccess { return }
    if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
        throw NativeKeyError.accessLocked
    }
    throw NativeKeyError.materialLost
}
