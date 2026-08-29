package com.uankit53.crewroll.crypto

import java.util.Locale

enum class MediaVariant(val code: Int) {
    PREVIEW(1),
    ORIGINAL(2),
}

object CrewRollAad {
    fun media(
        tripId: String,
        assetId: String,
        variant: MediaVariant,
        keyEpoch: Long = 1,
        formatVersion: Long = 1,
    ): ByteArray {
        if (keyEpoch != 1L || formatVersion != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "media AAD epoch and format must both be 1",
            )
        }
        return BinaryWriter(95).apply {
            writeAscii("CRROLL-AAD-V1\u0000")
            writeAscii(canonicalUuid(tripId))
            writeAscii(canonicalUuid(assetId))
            writeU8(variant.code)
            writeU32(keyEpoch)
            writeU32(formatVersion)
        }.toByteArray().also {
            check(it.size == 95)
        }
    }

    fun manifest(
        tripId: String,
        assetId: String,
        keyEpoch: Long = 1,
        formatVersion: Long = 1,
    ): ByteArray {
        if (keyEpoch != 1L || formatVersion != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "manifest AAD epoch and format must both be 1",
            )
        }
        return BinaryWriter(94).apply {
            writeAscii("CRROLL-MAN-V1\u0000")
            writeAscii(canonicalUuid(tripId))
            writeAscii(canonicalUuid(assetId))
            writeU32(keyEpoch)
            writeU32(formatVersion)
        }.toByteArray().also {
            check(it.size == 94)
        }
    }
}

private val canonicalUuidPattern = Regex(
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
)

internal fun canonicalUuid(value: String): String {
    if (!canonicalUuidPattern.matches(value)) {
        throw CryptoReadException(
            CryptoFailure.STRUCTURE,
            "UUID must have canonical shape",
        )
    }
    return value.lowercase(Locale.ROOT)
}

internal fun uuidBytes(value: String): ByteArray {
    val compact = canonicalUuid(value).replace("-", "")
    return ByteArray(16) { index ->
        compact.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
}
