import Foundation

public enum MediaVariant: UInt8, CaseIterable {
    case preview = 1
    case original = 2
}

public enum CrewRollAAD {
    public static func media(
        tripID: String,
        assetID: String,
        variant: MediaVariant,
        keyEpoch: UInt32 = 1,
        formatVersion: UInt32 = 1
    ) throws -> Bytes {
        guard keyEpoch == 1, formatVersion == 1 else {
            throw CryptoReadError.semanticContext(
                "media AAD epoch and format must both be 1"
            )
        }
        var writer = ByteWriter()
        try writer.writeASCII("CRROLL-AAD-V1\0")
        try writer.writeASCII(canonicalUUID(tripID))
        try writer.writeASCII(canonicalUUID(assetID))
        writer.write(variant.rawValue)
        writer.write(keyEpoch)
        writer.write(formatVersion)
        guard writer.bytes.count == 95 else {
            throw CryptoReadError.structure("media AAD must be exactly 95 bytes")
        }
        return writer.bytes
    }

    public static func manifest(
        tripID: String,
        assetID: String,
        keyEpoch: UInt32 = 1,
        formatVersion: UInt32 = 1
    ) throws -> Bytes {
        guard keyEpoch == 1, formatVersion == 1 else {
            throw CryptoReadError.semanticContext(
                "manifest AAD epoch and format must both be 1"
            )
        }
        var writer = ByteWriter()
        try writer.writeASCII("CRROLL-MAN-V1\0")
        try writer.writeASCII(canonicalUUID(tripID))
        try writer.writeASCII(canonicalUUID(assetID))
        writer.write(keyEpoch)
        writer.write(formatVersion)
        guard writer.bytes.count == 94 else {
            throw CryptoReadError.structure(
                "manifest AAD must be exactly 94 bytes"
            )
        }
        return writer.bytes
    }
}

func canonicalUUID(_ value: String) throws -> String {
    let segments = value.split(separator: "-", omittingEmptySubsequences: false)
    let widths = [8, 4, 4, 4, 12]
    guard segments.count == widths.count else {
        throw CryptoReadError.structure("UUID must have canonical shape")
    }
    for (segment, width) in zip(segments, widths) {
        guard segment.count == width,
              segment.utf8.allSatisfy({ byte in
                  (48 ... 57).contains(byte)
                      || (65 ... 70).contains(byte)
                      || (97 ... 102).contains(byte)
              })
        else {
            throw CryptoReadError.structure("UUID must have canonical shape")
        }
    }
    return value.lowercased()
}

func uuidBytes(_ value: String) throws -> Bytes {
    let canonical = try canonicalUUID(value)
    let compact = canonical.replacingOccurrences(of: "-", with: "")
    var result: Bytes = []
    result.reserveCapacity(16)
    var position = compact.startIndex
    for _ in 0 ..< 16 {
        let next = compact.index(position, offsetBy: 2)
        guard let byte = UInt8(compact[position ..< next], radix: 16) else {
            throw CryptoReadError.structure("UUID contains invalid hex")
        }
        result.append(byte)
        position = next
    }
    return result
}
