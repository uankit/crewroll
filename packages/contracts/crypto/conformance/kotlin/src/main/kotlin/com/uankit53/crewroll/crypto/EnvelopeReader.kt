package com.uankit53.crewroll.crypto

import com.goterl.lazysodium.SodiumJava

object EnvelopeReader {
    fun open(
        sodium: SodiumJava,
        ciphertext: ByteArray,
        recipientPublicKey: ByteArray,
        recipientSecretKey: ByteArray,
        expectedTripId: String,
        expectedSenderDeviceId: String,
        expectedRecipientDeviceId: String,
        expectedRecipientE2eeKeyVersion: Long,
    ): ByteArray {
        if (ciphertext.size != 148) {
            throw CryptoReadException(
                CryptoFailure.STRUCTURE,
                "envelope ciphertext must be exactly 148 bytes",
            )
        }
        requireWidth(recipientPublicKey, 32, "recipient public key")
        requireWidth(recipientSecretKey, 32, "recipient secret key")
        if (expectedRecipientE2eeKeyVersion != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "expected recipient key version must be 1",
            )
        }
        val plaintext = ByteArray(100)
        if (sodium.crypto_box_seal_open(
                plaintext,
                ciphertext,
                ciphertext.size.toLong(),
                recipientPublicKey,
                recipientSecretKey,
            ) != 0
        ) {
            throw CryptoReadException(
                CryptoFailure.AUTHENTICATION,
                "envelope sealed-box authentication failed",
            )
        }
        val reader = BinaryReader(plaintext)
        if (!reader.readBytes(8).contentEquals("CRTKENV1".toByteArray(Charsets.US_ASCII))) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "envelope domain disagrees",
            )
        }
        if (reader.readU32() != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "envelope algorithm version disagrees",
            )
        }
        val tripId = reader.readBytes(16)
        if (reader.readU32() != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "envelope key epoch disagrees",
            )
        }
        val senderDeviceId = reader.readBytes(16)
        val recipientDeviceId = reader.readBytes(16)
        if (reader.readU32() != 1L) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "envelope recipient key version disagrees",
            )
        }
        val tripKey = reader.readBytes(32)
        reader.assertEnd()
        if (
            !bytesEqual(tripId, uuidBytes(expectedTripId)) ||
            !bytesEqual(senderDeviceId, uuidBytes(expectedSenderDeviceId)) ||
            !bytesEqual(recipientDeviceId, uuidBytes(expectedRecipientDeviceId))
        ) {
            throw CryptoReadException(
                CryptoFailure.SEMANTIC_CONTEXT,
                "envelope inner identity context disagrees",
            )
        }
        return tripKey
    }
}
