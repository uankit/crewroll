package com.uankit53.crewroll.crypto

import com.goterl.lazysodium.SodiumJava
import com.goterl.lazysodium.interfaces.SecretStream
import java.io.ByteArrayOutputStream

data class MediaReadResult(
    val frameCount: Int,
    val plaintextBytes: ULong,
    val ciphertextBytes: ULong,
    val plaintext: ByteArray,
    val plaintextSha256: ByteArray,
    val ciphertextSha256: ByteArray,
)

object MediaReader {
    private const val HEADER_BYTES = 24
    private const val AUTHENTICATION_BYTES = 17
    private const val PLAINTEXT_FRAME_BYTES = 262_144
    private const val MAXIMUM_CIPHERTEXT_FRAME_BYTES =
        PLAINTEXT_FRAME_BYTES + AUTHENTICATION_BYTES

    fun open(
        sodium: SodiumJava,
        blob: ByteArray,
        streamKey: ByteArray,
        aad: ByteArray,
        expectedCiphertextBytes: Long,
        expectedCiphertextSha256: ByteArray,
        expectedPlaintextSha256: ByteArray,
    ): MediaReadResult {
        requireWidth(streamKey, 32, "stream key")
        requireWidth(aad, 95, "media AAD")
        requireWidth(expectedCiphertextSha256, 32, "ciphertext SHA-256")
        requireWidth(expectedPlaintextSha256, 32, "plaintext SHA-256")
        if (expectedCiphertextBytes < 0 || blob.size.toLong() != expectedCiphertextBytes) {
            throw CryptoReadException(
                CryptoFailure.CHECKSUM,
                "ciphertext length disagrees",
            )
        }
        if (blob.size < HEADER_BYTES) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "media header is truncated",
            )
        }
        validateFrameLayout(blob)
        val ciphertextDigest = sha256(blob)
        if (!bytesEqual(ciphertextDigest, expectedCiphertextSha256)) {
            throw CryptoReadException(
                CryptoFailure.CHECKSUM,
                "ciphertext SHA-256 disagrees",
            )
        }
        if (
            sodium.crypto_secretstream_xchacha20poly1305_keybytes() != 32 ||
            sodium.crypto_secretstream_xchacha20poly1305_headerbytes() != HEADER_BYTES ||
            sodium.crypto_secretstream_xchacha20poly1305_abytes() != AUTHENTICATION_BYTES ||
            sodium.crypto_secretstream_xchacha20poly1305_tag_message().toInt() != 0 ||
            sodium.crypto_secretstream_xchacha20poly1305_tag_final().toInt() != 3
        ) {
            throw CryptoReadException(
                CryptoFailure.AUTHENTICATION,
                "libsodium secretstream constants disagree with format v1",
            )
        }

        val reader = BinaryReader(blob)
        val header = reader.readBytes(HEADER_BYTES)
        if (reader.remaining == 0) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "media blob contains no frame",
            )
        }
        val state = SecretStream.State()
        if (sodium.crypto_secretstream_xchacha20poly1305_init_pull(
                state,
                header,
                streamKey,
            ) != 0
        ) {
            throw CryptoReadException(
                CryptoFailure.AUTHENTICATION,
                "secretstream header initialization failed",
            )
        }

        val plaintext = ByteArrayOutputStream()
        var frameCount = 0
        var sawFinal = false
        while (reader.remaining > 0) {
            if (reader.remaining < 4) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "media length prefix is truncated",
                )
            }
            val ciphertextLength = reader.readU32()
            if (ciphertextLength !in AUTHENTICATION_BYTES.toLong() ..
                MAXIMUM_CIPHERTEXT_FRAME_BYTES.toLong()
            ) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "media ciphertext length is outside v1 bounds",
                )
            }
            val ciphertext = reader.readBytes(ciphertextLength.toInt())
            val isLast = reader.remaining == 0
            val message = ByteArray(ciphertext.size - AUTHENTICATION_BYTES)
            val messageLength = LongArray(1)
            val tag = ByteArray(1)
            if (sodium.crypto_secretstream_xchacha20poly1305_pull(
                    state,
                    message,
                    messageLength,
                    tag,
                    ciphertext,
                    ciphertext.size.toLong(),
                    aad,
                    aad.size.toLong(),
                ) != 0
            ) {
                throw CryptoReadException(
                    CryptoFailure.AUTHENTICATION,
                    "secretstream frame $frameCount failed authentication",
                )
            }
            if (messageLength[0] != message.size.toLong()) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "secretstream plaintext length disagrees",
                )
            }
            when (tag[0]) {
                sodium.crypto_secretstream_xchacha20poly1305_tag_message() -> {
                    if (message.size != PLAINTEXT_FRAME_BYTES || isLast) {
                        throw CryptoReadException(
                            CryptoFailure.STRUCTURE,
                            "non-final media frame is not canonical",
                        )
                    }
                }

                sodium.crypto_secretstream_xchacha20poly1305_tag_final() -> {
                    if (!isLast || message.size > PLAINTEXT_FRAME_BYTES) {
                        throw CryptoReadException(
                            CryptoFailure.STRUCTURE,
                            "media FINAL is not canonical exact EOF",
                        )
                    }
                    sawFinal = true
                }

                else -> throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "secretstream tag is forbidden in format v1",
                )
            }
            plaintext.write(message)
            frameCount += 1
        }
        if (!sawFinal) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "media stream has no FINAL tag",
            )
        }
        val plaintextBytes = plaintext.toByteArray()
        val plaintextDigest = sha256(plaintextBytes)
        if (!bytesEqual(plaintextDigest, expectedPlaintextSha256)) {
            throw CryptoReadException(
                CryptoFailure.CHECKSUM,
                "plaintext SHA-256 disagrees",
            )
        }
        return MediaReadResult(
            frameCount = frameCount,
            plaintextBytes = plaintextBytes.size.toULong(),
            ciphertextBytes = blob.size.toULong(),
            plaintext = plaintextBytes,
            plaintextSha256 = plaintextDigest,
            ciphertextSha256 = ciphertextDigest,
        )
    }

    private fun validateFrameLayout(blob: ByteArray) {
        val reader = BinaryReader(blob)
        reader.readBytes(HEADER_BYTES)
        if (reader.remaining == 0) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "media blob contains no frame",
            )
        }
        while (reader.remaining > 0) {
            if (reader.remaining < 4) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "media length prefix is truncated",
                )
            }
            val ciphertextLength = reader.readU32()
            if (ciphertextLength !in AUTHENTICATION_BYTES.toLong() ..
                MAXIMUM_CIPHERTEXT_FRAME_BYTES.toLong()
            ) {
                throw CryptoReadException(
                    CryptoFailure.STRUCTURE,
                    "media ciphertext length is outside v1 bounds",
                )
            }
            reader.readBytes(ciphertextLength.toInt())
        }
    }
}
