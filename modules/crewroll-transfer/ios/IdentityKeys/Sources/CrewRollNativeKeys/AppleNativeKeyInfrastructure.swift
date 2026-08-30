import Foundation
import Security

public protocol AppleP256KeyBackend: AnyObject {
    func loadPublicKey(applicationTag: Data) throws -> Data?
    func createSecureEnclavePublicKey(applicationTag: Data) throws -> Data
}

public final class AppleP256IdentityProvider: P256IdentityProvider {
    private let backend: AppleP256KeyBackend

    public init(backend: AppleP256KeyBackend = AppleSecurityP256KeyBackend()) {
        self.backend = backend
    }

    public func createPublicKey(scope: NativeKeyScope) throws -> Data {
        let tag = try applicationTag(scope: scope)
        guard try backend.loadPublicKey(applicationTag: tag) == nil else {
            throw NativeKeyError.materialLost
        }
        return try validated(backend.createSecureEnclavePublicKey(applicationTag: tag))
    }

    public func loadPublicKey(scope: NativeKeyScope) throws -> Data? {
        let tag = try applicationTag(scope: scope)
        guard let key = try backend.loadPublicKey(applicationTag: tag) else { return nil }
        return try validated(key)
    }

    private func applicationTag(scope: NativeKeyScope) throws -> Data {
        guard scope.accountHash.range(
            of: "^[a-f0-9]{64}$",
            options: .regularExpression
        ) != nil,
        scope.installationID.range(
            of: "^[A-Za-z0-9_-]{8,128}$",
            options: .regularExpression
        ) != nil
        else { throw NativeKeyError.materialLost }
        return Data(
            "com.uankit53.airmesh.p256.v2.\(scope.accountHash).\(scope.installationID)".utf8
        )
    }

    private func validated(_ key: Data) throws -> Data {
        guard key.count == 65, key.first == 0x04 else {
            throw NativeKeyError.materialLost
        }
        return key
    }
}

public final class AppleSecurityP256KeyBackend: AppleP256KeyBackend {
    public init() {}

    public func loadPublicKey(applicationTag: Data) throws -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassKey,
            kSecAttrApplicationTag: applicationTag,
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecReturnRef: true,
            kSecMatchLimit: kSecMatchLimitOne,
            kSecAttrSynchronizable: false,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try appleP256Check(status)
        guard let privateKey = result as! SecKey? else {
            throw NativeKeyError.materialLost
        }
        return try publicRepresentation(privateKey)
    }

    public func createSecureEnclavePublicKey(applicationTag: Data) throws -> Data {
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .privateKeyUsage,
            nil
        ) else { throw NativeKeyError.materialLost }
        let attributes: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: applicationTag,
                kSecAttrAccessControl: access,
                kSecAttrSynchronizable: false,
            ],
        ]
        var error: Unmanaged<CFError>?
        guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
        else { throw NativeKeyError.materialLost }
        return try publicRepresentation(privateKey)
    }

    private func publicRepresentation(_ privateKey: SecKey) throws -> Data {
        guard let attributes = SecKeyCopyAttributes(privateKey) as? [CFString: Any],
              attributes[kSecAttrTokenID] as? String == kSecAttrTokenIDSecureEnclave as String,
              attributes[kSecAttrKeyClass] as? String == kSecAttrKeyClassPrivate as String,
              let publicKey = SecKeyCopyPublicKey(privateKey),
              let external = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
              external.count == 65,
              external.first == 0x04
        else { throw NativeKeyError.materialLost }
        return external
    }
}

public enum AppleNativeKeyInfrastructure {
    public static func makeLifecycle() throws -> NativeKeyLifecycle {
        NativeKeyLifecycle(
            clock: SystemNativeKeyClock(),
            store: AppleAccountScopedKeyStore(),
            crypto: try AppleSodiumCrypto(),
            p256: AppleP256IdentityProvider(),
            accountHasher: AppleAccountNamespaceHasher(),
            cleanupScheduler: DispatchNativeKeyCleanupScheduler()
        )
    }
}

private func appleP256Check(_ status: OSStatus) throws {
    if status == errSecSuccess { return }
    if status == errSecInteractionNotAllowed || status == errSecNotAvailable {
        throw NativeKeyError.accessLocked
    }
    throw NativeKeyError.materialLost
}
