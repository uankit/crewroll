import Clibsodium
import CryptoKit
import Foundation

public final class AppleSodiumCrypto: NativeKeyCrypto {
    public init() throws {
        guard sodium_init() >= 0,
              crypto_box_publickeybytes() == 32,
              crypto_box_secretkeybytes() == 32,
              crypto_box_sealbytes() == 48
        else { throw NativeKeyError.materialLost }
    }

    public func randomBytes(count: Int) throws -> Data {
        guard count > 0 else { throw NativeKeyError.invalidCommand }
        var bytes = [UInt8](repeating: 0, count: count)
        defer { sodium_memzero(&bytes, bytes.count) }
        randombytes_buf(&bytes, count)
        return Data(bytes)
    }

    public func makeX25519KeyPair() throws -> (publicKey: Data, privateKey: Data) {
        var publicKey = [UInt8](repeating: 0, count: 32)
        var privateKey = [UInt8](repeating: 0, count: 32)
        defer { sodium_memzero(&privateKey, privateKey.count) }
        guard crypto_box_keypair(&publicKey, &privateKey) == 0 else {
            throw NativeKeyError.materialLost
        }
        return (Data(publicKey), Data(privateKey))
    }

    public func deriveX25519PublicKey(privateKey: Data) throws -> Data {
        guard privateKey.count == 32 else { throw NativeKeyError.materialLost }
        var output = [UInt8](repeating: 0, count: 32)
        var privateBytes = [UInt8](privateKey)
        defer { sodium_memzero(&privateBytes, privateBytes.count) }
        guard crypto_scalarmult_base(&output, privateBytes) == 0 else {
            throw NativeKeyError.materialLost
        }
        return Data(output)
    }

    public func constantTimeEquals(_ lhs: Data, _ rhs: Data) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return lhs.withUnsafeBytes { left in
            rhs.withUnsafeBytes { right in
                sodium_memcmp(left.baseAddress, right.baseAddress, lhs.count) == 0
            }
        }
    }

    public func zeroize(_ value: inout Data) {
        value.withUnsafeMutableBytes { bytes in
            if let baseAddress = bytes.baseAddress { sodium_memzero(baseAddress, bytes.count) }
        }
    }

    public func seal(_ plaintext: Data, recipientPublicKey: Data) throws -> Data {
        guard plaintext.count == 100, recipientPublicKey.count == 32 else {
            throw NativeKeyError.invalidEnvelope
        }
        var output = [UInt8](repeating: 0, count: 148)
        var message = [UInt8](plaintext)
        let publicKey = [UInt8](recipientPublicKey)
        defer { sodium_memzero(&message, message.count) }
        guard crypto_box_seal(&output, message, UInt64(message.count), publicKey) == 0 else {
            throw NativeKeyError.invalidEnvelope
        }
        return Data(output)
    }

    public func open(_ ciphertext: Data, publicKey: Data, privateKey: Data) throws -> Data {
        guard ciphertext.count == 148, publicKey.count == 32, privateKey.count == 32 else {
            throw NativeKeyError.invalidEnvelope
        }
        var output = [UInt8](repeating: 0, count: 100)
        var sealed = [UInt8](ciphertext)
        let publicBytes = [UInt8](publicKey)
        var privateBytes = [UInt8](privateKey)
        defer {
            sodium_memzero(&output, output.count)
            sodium_memzero(&sealed, sealed.count)
            sodium_memzero(&privateBytes, privateBytes.count)
        }
        guard crypto_box_seal_open(
            &output,
            sealed,
            UInt64(sealed.count),
            publicBytes,
            privateBytes
        ) == 0 else { throw NativeKeyError.invalidEnvelope }
        return Data(output)
    }
}

public final class AppleAccountNamespaceHasher: AccountNamespaceHasher {
    public init() {}
    public func hash(accountID: String) throws -> String {
        SHA256.hash(data: Data(accountID.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
