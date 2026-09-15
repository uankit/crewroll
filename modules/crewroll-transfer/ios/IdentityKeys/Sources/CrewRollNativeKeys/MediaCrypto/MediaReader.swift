import Clibsodium

public struct MediaReadResult: Equatable {
    public let frameCount: Int
    public let plaintextBytes: UInt64
    public let ciphertextBytes: UInt64
    public let plaintext: Bytes
    public let plaintextSHA256: Bytes
    public let ciphertextSHA256: Bytes
}

public enum MediaReader {
    private static let headerBytes = 24
    private static let authenticationBytes = 17
    private static let plaintextFrameBytes = 262_144
    private static let minimumCiphertextFrameBytes = authenticationBytes
    private static let maximumCiphertextFrameBytes =
        plaintextFrameBytes + authenticationBytes

    public static func open(
        blob: Bytes,
        streamKey: Bytes,
        aad: Bytes,
        expectedCiphertextBytes: UInt64,
        expectedCiphertextSHA256: Bytes,
        expectedPlaintextSHA256: Bytes
    ) throws -> MediaReadResult {
        try requireWidth(streamKey, 32, "stream key")
        try requireWidth(aad, 95, "media AAD")
        try requireWidth(expectedCiphertextSHA256, 32, "ciphertext SHA-256")
        try requireWidth(expectedPlaintextSHA256, 32, "plaintext SHA-256")
        guard UInt64(blob.count) == expectedCiphertextBytes else {
            throw CryptoReadError.checksum("ciphertext length disagrees")
        }
        guard blob.count >= headerBytes else {
            throw CryptoReadError.structure("media header is truncated")
        }
        try validateFrameLayout(blob)

        let ciphertextDigest = try sha256(blob)
        guard bytesEqual(ciphertextDigest, expectedCiphertextSHA256) else {
            throw CryptoReadError.checksum("ciphertext SHA-256 disagrees")
        }

        try CrewRollSodium.initialize()
        guard Int(crypto_secretstream_xchacha20poly1305_keybytes()) == 32,
              Int(crypto_secretstream_xchacha20poly1305_headerbytes()) == headerBytes,
              Int(crypto_secretstream_xchacha20poly1305_abytes()) == authenticationBytes,
              crypto_secretstream_xchacha20poly1305_tag_message() == 0,
              crypto_secretstream_xchacha20poly1305_tag_final() == 3
        else {
            throw CryptoReadError.authentication(
                "libsodium secretstream constants disagree with format v1"
            )
        }

        let header = Bytes(blob[0 ..< headerBytes])
        var state = crypto_secretstream_xchacha20poly1305_state()
        guard crypto_secretstream_xchacha20poly1305_init_pull(
            &state,
            header,
            streamKey
        ) == 0 else {
            throw CryptoReadError.authentication(
                "secretstream header initialization failed"
            )
        }

        var reader = ByteReader(blob)
        _ = try reader.readBytes(headerBytes)
        guard reader.remaining > 0 else {
            throw CryptoReadError.structure("media blob contains no frame")
        }

        var plaintext: Bytes = []
        var frameCount = 0
        var sawFinal = false
        while reader.remaining > 0 {
            guard reader.remaining >= 4 else {
                throw CryptoReadError.structure(
                    "media length prefix is truncated"
                )
            }
            let ciphertextLength = Int(try reader.readUInt32())
            guard (minimumCiphertextFrameBytes ... maximumCiphertextFrameBytes)
                .contains(ciphertextLength)
            else {
                throw CryptoReadError.structure(
                    "media ciphertext length is outside v1 bounds"
                )
            }
            let ciphertext = try reader.readBytes(ciphertextLength)
            let isLast = reader.remaining == 0
            var message = Bytes(
                repeating: 0,
                count: ciphertextLength - authenticationBytes
            )
            var messageLength: UInt64 = 0
            var tag: UInt8 = 0
            guard crypto_secretstream_xchacha20poly1305_pull(
                &state,
                &message,
                &messageLength,
                &tag,
                ciphertext,
                UInt64(ciphertext.count),
                aad,
                UInt64(aad.count)
            ) == 0 else {
                throw CryptoReadError.authentication(
                    "secretstream frame \(frameCount) failed authentication"
                )
            }
            guard messageLength == UInt64(message.count) else {
                throw CryptoReadError.structure(
                    "secretstream plaintext length disagrees"
                )
            }

            if tag == crypto_secretstream_xchacha20poly1305_tag_message() {
                guard message.count == plaintextFrameBytes, !isLast else {
                    throw CryptoReadError.structure(
                        "non-final media frame is not canonical"
                    )
                }
            } else if tag == crypto_secretstream_xchacha20poly1305_tag_final() {
                guard isLast, message.count <= plaintextFrameBytes else {
                    throw CryptoReadError.structure(
                        "media FINAL is not canonical exact EOF"
                    )
                }
                sawFinal = true
            } else {
                throw CryptoReadError.structure(
                    "secretstream tag is forbidden in format v1"
                )
            }

            plaintext.append(contentsOf: message)
            frameCount += 1
        }

        guard sawFinal else {
            throw CryptoReadError.structure("media stream has no FINAL tag")
        }
        let plaintextDigest = try sha256(plaintext)
        guard bytesEqual(plaintextDigest, expectedPlaintextSHA256) else {
            throw CryptoReadError.checksum("plaintext SHA-256 disagrees")
        }
        return MediaReadResult(
            frameCount: frameCount,
            plaintextBytes: UInt64(plaintext.count),
            ciphertextBytes: UInt64(blob.count),
            plaintext: plaintext,
            plaintextSHA256: plaintextDigest,
            ciphertextSHA256: ciphertextDigest
        )
    }

    private static func validateFrameLayout(_ blob: Bytes) throws {
        var reader = ByteReader(blob)
        _ = try reader.readBytes(headerBytes)
        guard reader.remaining > 0 else {
            throw CryptoReadError.structure("media blob contains no frame")
        }
        while reader.remaining > 0 {
            guard reader.remaining >= 4 else {
                throw CryptoReadError.structure(
                    "media length prefix is truncated"
                )
            }
            let ciphertextLength = Int(try reader.readUInt32())
            guard (minimumCiphertextFrameBytes ... maximumCiphertextFrameBytes)
                .contains(ciphertextLength)
            else {
                throw CryptoReadError.structure(
                    "media ciphertext length is outside v1 bounds"
                )
            }
            _ = try reader.readBytes(ciphertextLength)
        }
    }
}
