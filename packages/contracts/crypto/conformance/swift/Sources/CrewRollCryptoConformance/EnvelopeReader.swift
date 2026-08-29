import Clibsodium

public enum EnvelopeReader {
    public static func open(
        ciphertext: Bytes,
        recipientPublicKey: Bytes,
        recipientSecretKey: Bytes,
        expectedTripID: String,
        expectedSenderDeviceID: String,
        expectedRecipientDeviceID: String,
        expectedRecipientE2EEKeyVersion: UInt32
    ) throws -> Bytes {
        guard ciphertext.count == 148 else {
            throw CryptoReadError.structure(
                "envelope ciphertext must be exactly 148 bytes"
            )
        }
        try requireWidth(recipientPublicKey, 32, "recipient public key")
        try requireWidth(recipientSecretKey, 32, "recipient secret key")
        guard expectedRecipientE2EEKeyVersion == 1 else {
            throw CryptoReadError.semanticContext(
                "expected recipient key version must be 1"
            )
        }
        try CrewRollSodium.initialize()
        guard Int(crypto_box_publickeybytes()) == 32,
              Int(crypto_box_secretkeybytes()) == 32,
              Int(crypto_box_sealbytes()) == 48
        else {
            throw CryptoReadError.authentication(
                "libsodium sealed-box constants disagree with format v1"
            )
        }

        var plaintext = Bytes(repeating: 0, count: 100)
        guard crypto_box_seal_open(
            &plaintext,
            ciphertext,
            UInt64(ciphertext.count),
            recipientPublicKey,
            recipientSecretKey
        ) == 0 else {
            throw CryptoReadError.authentication(
                "envelope sealed-box authentication failed"
            )
        }
        var reader = ByteReader(plaintext)
        guard try reader.readBytes(8) == Bytes("CRTKENV1".utf8),
              try reader.readUInt32() == 1
        else {
            throw CryptoReadError.semanticContext(
                "envelope domain or algorithm version disagrees"
            )
        }
        let tripID = try reader.readBytes(16)
        guard try reader.readUInt32() == 1 else {
            throw CryptoReadError.semanticContext("envelope key epoch disagrees")
        }
        let senderDeviceID = try reader.readBytes(16)
        let recipientDeviceID = try reader.readBytes(16)
        guard try reader.readUInt32() == 1 else {
            throw CryptoReadError.semanticContext(
                "envelope recipient key version disagrees"
            )
        }
        let tripKey = try reader.readBytes(32)
        try reader.assertEnd()
        guard bytesEqual(tripID, try uuidBytes(expectedTripID)),
              bytesEqual(senderDeviceID, try uuidBytes(expectedSenderDeviceID)),
              bytesEqual(recipientDeviceID, try uuidBytes(expectedRecipientDeviceID))
        else {
            throw CryptoReadError.semanticContext(
                "envelope inner identity context disagrees"
            )
        }
        return tripKey
    }
}
