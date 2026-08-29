package com.uankit53.crewroll.crypto

import com.goterl.lazysodium.SodiumJava
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.text.Normalizer

data class ManifestVariantDescriptor(
    val variant: MediaVariant,
    val mime: String,
    val pixelWidth: UInt,
    val pixelHeight: UInt,
    val plaintextBytes: ULong,
    val plaintextSha256: ByteArray,
    val ciphertextBytes: ULong,
    val ciphertextSha256: ByteArray,
)

data class ManifestReadResult(
    val contentRoot: ByteArray,
    val capturedAtMilliseconds: ULong?,
    val filename: String?,
    val preview: ManifestVariantDescriptor,
    val original: ManifestVariantDescriptor,
    val plaintext: ByteArray,
)

object ManifestReader {
    private const val MINIMUM_PLAINTEXT_BYTES = 241
    private const val MAXIMUM_PLAINTEXT_BYTES = 744
    private const val MINIMUM_ENCRYPTED_BYTES = 281
    private const val MAXIMUM_ENCRYPTED_BYTES = 784
    private const val NONCE_BYTES = 24
    private const val AUTHENTICATION_BYTES = 16
    private val lastMillisecondYear9999 = 253_402_300_799_999uL

    fun assertMatchesDescriptor(
        actual: ManifestVariantDescriptor,
        expected: ManifestVariantDescriptor,
    ) {
        if (
            actual.variant != expected.variant ||
            actual.mime != expected.mime ||
            actual.pixelWidth != expected.pixelWidth ||
            actual.pixelHeight != expected.pixelHeight ||
            actual.plaintextBytes != expected.plaintextBytes ||
            actual.ciphertextBytes != expected.ciphertextBytes ||
            !bytesEqual(actual.plaintextSha256, expected.plaintextSha256) ||
            !bytesEqual(actual.ciphertextSha256, expected.ciphertextSha256)
        ) {
            throw CryptoReadException(
                CryptoFailure.CHECKSUM,
                "manifest descriptor disagrees with expected media metadata",
            )
        }
    }

    fun assertMatchesMedia(
        descriptor: ManifestVariantDescriptor,
        media: MediaReadResult,
    ) {
        if (
            descriptor.plaintextBytes != media.plaintextBytes ||
            descriptor.ciphertextBytes != media.ciphertextBytes ||
            !bytesEqual(descriptor.plaintextSha256, media.plaintextSha256) ||
            !bytesEqual(descriptor.ciphertextSha256, media.ciphertextSha256)
        ) {
            throw CryptoReadException(
                CryptoFailure.CHECKSUM,
                "manifest descriptor disagrees with verified media",
            )
        }
    }

    fun open(
        sodium: SodiumJava,
        encryptedManifest: ByteArray,
        tripKey: ByteArray,
        aad: ByteArray,
    ): ManifestReadResult {
        if (encryptedManifest.size !in MINIMUM_ENCRYPTED_BYTES .. MAXIMUM_ENCRYPTED_BYTES) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "encrypted manifest is outside v1 bounds",
            )
        }
        requireWidth(tripKey, 32, "trip key")
        requireWidth(aad, 94, "manifest AAD")
        val manifestKey = deriveManifestKey(sodium, tripKey)
        val nonce = encryptedManifest.copyOfRange(0, NONCE_BYTES)
        val ciphertext = encryptedManifest.copyOfRange(NONCE_BYTES, encryptedManifest.size)
        val plaintext = ByteArray(ciphertext.size - AUTHENTICATION_BYTES)
        val plaintextLength = LongArray(1)
        if (sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                plaintext,
                plaintextLength,
                null,
                ciphertext,
                ciphertext.size.toLong(),
                aad,
                aad.size.toLong(),
                nonce,
                manifestKey,
            ) != 0
        ) {
            throw CryptoReadException(
                CryptoFailure.AUTHENTICATION,
                "encrypted manifest failed authentication",
            )
        }
        if (plaintextLength[0] != plaintext.size.toLong()) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "manifest plaintext length disagrees",
            )
        }
        return parse(plaintext)
    }

    internal fun deriveManifestKey(
        sodium: SodiumJava,
        tripKey: ByteArray,
    ): ByteArray {
        requireWidth(tripKey, 32, "trip key")
        val key = ByteArray(32)
        if (sodium.crypto_kdf_derive_from_key(
                key,
                key.size,
                1,
                "CRMANF01".toByteArray(Charsets.US_ASCII),
                tripKey,
            ) != 0
        ) {
            throw CryptoReadException(
                CryptoFailure.AUTHENTICATION,
                "manifest KDF derivation failed",
            )
        }
        return key
    }

    internal fun parse(plaintext: ByteArray): ManifestReadResult {
        if (plaintext.size !in MINIMUM_PLAINTEXT_BYTES .. MAXIMUM_PLAINTEXT_BYTES) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "manifest plaintext is outside v1 bounds",
            )
        }
        val reader = BinaryReader(plaintext)
        if (!reader.readBytes(8).contentEquals("CRMANP1\u0000".toByteArray(Charsets.US_ASCII))) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "manifest domain disagrees",
            )
        }
        if (reader.readU32() != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "manifest schema disagrees",
            )
        }
        val contentRoot = reader.readBytes(32)
        val capturePresent = reader.readU8()
        val captureValue = reader.readU64()
        val capturedAtMilliseconds = when {
            capturePresent == 0 && captureValue == 0uL -> null
            capturePresent == 1 && captureValue in 1uL .. lastMillisecondYear9999 ->
                captureValue
            else -> throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "capture flag/value pairing is invalid",
            )
        }
        val filename = readFilename(reader)
        val preview = readDescriptor(reader, MediaVariant.PREVIEW)
        val original = readDescriptor(reader, MediaVariant.ORIGINAL)
        reader.assertEnd()
        return ManifestReadResult(
            contentRoot = contentRoot,
            capturedAtMilliseconds = capturedAtMilliseconds,
            filename = filename,
            preview = preview,
            original = original,
            plaintext = plaintext,
        )
    }

    private fun readFilename(reader: BinaryReader): String? {
        val count = reader.readU16()
        if (count == 0) {
            return null
        }
        if (count > 255) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "filename exceeds 255 UTF-8 bytes",
            )
        }
        val bytes = reader.readBytes(count)
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val value = try {
            decoder.decode(ByteBuffer.wrap(bytes)).toString()
        } catch (error: Exception) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "filename is not valid UTF-8",
                error,
            )
        }
        if (!value.toByteArray(Charsets.UTF_8).contentEquals(bytes)) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "filename UTF-8 spelling is not canonical",
            )
        }
        if (Normalizer.normalize(value, Normalizer.Form.NFC) != value) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "filename must already be NFC-normalized",
            )
        }
        val safeBasename = value.codePoints().allMatch { codePoint ->
            codePoint != '/'.code && codePoint != '\\'.code && codePoint > 0x1f && codePoint != 0x7f
        }
        if (!safeBasename) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "filename must be a display-only basename",
            )
        }
        return value
    }

    private fun readDescriptor(
        reader: BinaryReader,
        expected: MediaVariant,
    ): ManifestVariantDescriptor {
        if (reader.readU8() != expected.code) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "manifest descriptor order or variant disagrees",
            )
        }
        val mimeLength = reader.readU8()
        val mime = canonicalMime(reader.readBytes(mimeLength))
        val pixelWidth = reader.readU32()
        val pixelHeight = reader.readU32()
        if (pixelWidth == 0L || pixelHeight == 0L) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "manifest pixel dimensions must be positive",
            )
        }
        val plaintextBytes = reader.readU64()
        val plaintextSha256 = reader.readBytes(32)
        val ciphertextBytes = reader.readU64()
        if (ciphertextBytes < 45uL) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "manifest ciphertext length is below v1 minimum",
            )
        }
        val ciphertextSha256 = reader.readBytes(32)
        return ManifestVariantDescriptor(
            variant = expected,
            mime = mime,
            pixelWidth = pixelWidth.toUInt(),
            pixelHeight = pixelHeight.toUInt(),
            plaintextBytes = plaintextBytes,
            plaintextSha256 = plaintextSha256,
            ciphertextBytes = ciphertextBytes,
            ciphertextSha256 = ciphertextSha256,
        )
    }

    private fun canonicalMime(bytes: ByteArray): String {
        val slash = bytes.indexOf('/'.code.toByte())
        val allowed = bytes.withIndex().all { (index, byte) ->
            val value = byte.toInt() and 0xff
            if (value == '/'.code) {
                index == slash
            } else {
                value in 'a'.code .. 'z'.code ||
                    value in '0'.code .. '9'.code ||
                    value in setOf('!'.code, '#'.code, '$'.code, '&'.code, '^'.code, '_'.code, '.'.code, '+'.code, '-'.code)
            }
        }
        if (
            bytes.size !in 3 .. 127 ||
            slash <= 0 ||
            slash >= bytes.lastIndex ||
            !allowed
        ) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "MIME must be canonical lowercase type/subtype ASCII",
            )
        }
        return bytes.toString(Charsets.US_ASCII)
    }
}
