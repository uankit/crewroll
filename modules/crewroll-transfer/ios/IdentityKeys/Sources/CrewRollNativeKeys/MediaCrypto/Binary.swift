import Clibsodium
import Foundation

public typealias Bytes = [UInt8]

public enum CryptoReadError: Error, Equatable, LocalizedError {
    case structure(String)
    case authentication(String)
    case semanticContext(String)
    case checksum(String)

    public var errorDescription: String? {
        switch self {
        case let .structure(message),
             let .authentication(message),
             let .semanticContext(message),
             let .checksum(message):
            return message
        }
    }
}

struct ByteReader {
    private let bytes: Bytes
    private(set) var offset = 0

    init(_ bytes: Bytes) {
        self.bytes = bytes
    }

    var remaining: Int {
        bytes.count - offset
    }

    mutating func readBytes(_ count: Int) throws -> Bytes {
        guard count >= 0, count <= remaining else {
            throw CryptoReadError.structure(
                "truncated binary input: need \(count) bytes, have \(remaining)"
            )
        }
        let value = Bytes(bytes[offset ..< offset + count])
        offset += count
        return value
    }

    mutating func readUInt8() throws -> UInt8 {
        try readBytes(1)[0]
    }

    mutating func readUInt16() throws -> UInt16 {
        let value = try readBytes(2)
        return UInt16(value[0]) << 8 | UInt16(value[1])
    }

    mutating func readUInt32() throws -> UInt32 {
        let value = try readBytes(4)
        return value.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
    }

    mutating func readUInt64() throws -> UInt64 {
        let value = try readBytes(8)
        return value.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }

    mutating func assertEnd() throws {
        guard remaining == 0 else {
            throw CryptoReadError.structure(
                "trailing binary input: \(remaining) bytes"
            )
        }
    }
}

struct ByteWriter {
    private(set) var bytes: Bytes = []
    mutating func erase() { sodium_memzero(&bytes, bytes.count) }

    mutating func write(_ value: UInt8) {
        bytes.append(value)
    }

    mutating func write(_ value: UInt32) {
        bytes.append(UInt8(truncatingIfNeeded: value >> 24))
        bytes.append(UInt8(truncatingIfNeeded: value >> 16))
        bytes.append(UInt8(truncatingIfNeeded: value >> 8))
        bytes.append(UInt8(truncatingIfNeeded: value))
    }

    mutating func write(_ value: Bytes) {
        bytes.append(contentsOf: value)
    }

    mutating func writeASCII(_ value: String) throws {
        let encoded = Bytes(value.utf8)
        guard encoded.allSatisfy({ $0 <= 0x7f }) else {
            throw CryptoReadError.structure("ASCII field contains non-ASCII")
        }
        write(encoded)
    }
}

func requireWidth(_ value: Bytes, _ width: Int, _ label: String) throws {
    guard value.count == width else {
        throw CryptoReadError.structure(
            "\(label) must be exactly \(width) bytes"
        )
    }
}

func bytesEqual(_ left: Bytes, _ right: Bytes) -> Bool {
    guard left.count == right.count else {
        return false
    }
    var difference: UInt8 = 0
    for index in left.indices {
        difference |= left[index] ^ right[index]
    }
    return difference == 0
}

public func sha256(_ bytes: Bytes) throws -> Bytes {
    var digest = Bytes(repeating: 0, count: Int(crypto_hash_sha256_bytes()))
    guard crypto_hash_sha256(&digest, bytes, UInt64(bytes.count)) == 0 else {
        throw CryptoReadError.authentication("libsodium SHA-256 failed")
    }
    return digest
}

public enum CrewRollSodium {
    public static func initialize() throws {
        guard sodium_init() >= 0 else {
            throw CryptoReadError.authentication("sodium_init failed")
        }
    }

    public static var version: String {
        String(cString: sodium_version_string())
    }
}
