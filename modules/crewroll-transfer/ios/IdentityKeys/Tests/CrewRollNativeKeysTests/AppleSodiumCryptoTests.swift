import Foundation
import XCTest
@testable import CrewRollNativeKeys

final class AppleSodiumCryptoTests: XCTestCase {
    func testUsesRandomizedSealedBoxesAndRejectsWrongRecipient() throws {
        let crypto = try AppleSodiumCrypto()
        let recipient = try crypto.makeX25519KeyPair()
        let wrongRecipient = try crypto.makeX25519KeyPair()
        let plaintext = try crypto.randomBytes(count: 100)

        let first = try crypto.seal(plaintext, recipientPublicKey: recipient.publicKey)
        let second = try crypto.seal(plaintext, recipientPublicKey: recipient.publicKey)

        XCTAssertEqual(first.count, 148)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(
            try crypto.open(
                first,
                publicKey: recipient.publicKey,
                privateKey: recipient.privateKey
            ),
            plaintext
        )
        XCTAssertThrowsError(
            try crypto.open(
                first,
                publicKey: wrongRecipient.publicKey,
                privateKey: wrongRecipient.privateKey
            )
        ) { XCTAssertEqual(($0 as? NativeKeyError)?.code, "KEY_ENVELOPE_INVALID") }
    }
}
