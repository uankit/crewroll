package com.uankit53.crewroll.crypto

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

enum class CryptoFailure {
    STRUCTURE,
    AUTHENTICATION,
    SEMANTIC_CONTEXT,
    CHECKSUM,
}

class CryptoReadException(
    val failure: CryptoFailure,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

internal class BinaryReader(private val bytes: ByteArray) {
    private val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)

    val offset: Int
        get() = buffer.position()

    val remaining: Int
        get() = buffer.remaining()

    fun readBytes(count: Int): ByteArray {
        if (count < 0 || count > remaining) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "truncated binary input: need $count bytes, have $remaining",
            )
        }
        return ByteArray(count).also(buffer::get)
    }

    fun readU8(): Int = readBytes(1)[0].toInt() and 0xff

    fun readU16(): Int = ByteBuffer.wrap(readBytes(2))
        .order(ByteOrder.BIG_ENDIAN)
        .short
        .toInt() and 0xffff

    fun readU32(): Long = ByteBuffer.wrap(readBytes(4))
        .order(ByteOrder.BIG_ENDIAN)
        .int
        .toLong() and 0xffff_ffffL

    fun readU64(): ULong = readBytes(8).fold(0uL) { value, byte ->
        (value shl 8) or (byte.toInt() and 0xff).toULong()
    }

    fun assertEnd() {
        if (remaining != 0) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "trailing binary input: $remaining bytes",
            )
        }
    }
}

internal class BinaryWriter(capacity: Int) {
    private val buffer = ByteBuffer.allocate(capacity).order(ByteOrder.BIG_ENDIAN)

    fun writeAscii(value: String) {
        val bytes = value.toByteArray(Charsets.US_ASCII)
        if (bytes.size != value.length || bytes.any { (it.toInt() and 0xff) > 0x7f }) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "ASCII field contains non-ASCII",
            )
        }
        buffer.put(bytes)
    }

    fun writeU8(value: Int) {
        require(value in 0 .. 0xff)
        buffer.put(value.toByte())
    }

    fun writeU32(value: Long) {
        require(value in 0 .. 0xffff_ffffL)
        buffer.putInt(value.toInt())
    }

    fun toByteArray(): ByteArray = buffer.array().copyOf(buffer.position())
}

internal fun requireWidth(value: ByteArray, width: Int, label: String) {
    if (value.size != width) {
        throw CryptoReadException(
            CryptoFailure.STRUCTURE,
            "$label must be exactly $width bytes",
        )
    }
}

fun sha256(bytes: ByteArray): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(bytes)

internal fun bytesEqual(left: ByteArray, right: ByteArray): Boolean =
    MessageDigest.isEqual(left, right)
