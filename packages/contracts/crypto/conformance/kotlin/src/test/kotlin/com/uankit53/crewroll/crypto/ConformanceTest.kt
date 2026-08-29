package com.uankit53.crewroll.crypto

import com.goterl.lazysodium.interfaces.SecretStream
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.nio.file.Path
import java.util.Base64
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance

private data class MediaVector(
    val file: String,
    val variant: MediaVariant,
    val plaintextBytes: Int,
    val frameCount: Int,
    val ciphertextBytes: Long,
    val headerBase64: String,
    val streamKeyBase64: String,
    val plaintextSha256Base64: String,
    val ciphertextSha256Base64: String,
)

private data class EnvelopeVector(
    val file: String,
    val kind: String,
    val recipientDeviceId: String,
    val recipientPublicKeyBase64: String,
    val expectedTripKeyBase64: String,
    val residualAnonymousSubstitution: Boolean,
)

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ConformanceTest {
    private lateinit var provider: VerifiedSodiumProvider

    @BeforeAll
    fun openProvider() {
        provider = VerifiedSodiumProvider.open()
    }

    @AfterAll
    fun closeProvider() {
        provider.close()
    }

    @Test
    fun committedMediaOpensWithTheVerifiedReader() {
        assertEquals("1.0.20", provider.version)
        val record = mediaVectors.first {
            it.variant == MediaVariant.PREVIEW && it.plaintextBytes == 1
        }
        val result = openMedia(record)
        assertEquals(1, result.frameCount)
        assertArrayEquals(byteArrayOf(0x11), result.plaintext)
    }

    @Test
    fun allCanonicalMediaManifestAndEnvelopeVectorsAgree() {
        assertEquals(
            "1e7362663aa56308465e71d533fb9c92bef542a15bf77fa853c41f858abb3318",
            sha256(Files.readAllBytes(vectorPath("index.json"))).toHex(),
        )
        assertEquals(12, inventory.size)
        inventory.forEach { (file, digest) ->
            assertEquals(digest, sha256(Files.readAllBytes(vectorPath(file))).toHex(), file)
        }

        val previewAad = CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW)
        val originalAad = CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.ORIGINAL)
        val manifestAad = CrewRollAad.manifest(TRIP_ID, ASSET_ID)
        assertArrayEquals(decode(PREVIEW_AAD), previewAad)
        assertArrayEquals(decode(ORIGINAL_AAD), originalAad)
        assertArrayEquals(decode(MANIFEST_AAD), manifestAad)

        val contentRoot = decode(CONTENT_ROOT)
        val results = mutableMapOf<String, MediaReadResult>()
        mediaVectors.forEach { vector ->
            val streamKey = deriveKey(
                contentRoot,
                "CRROLL01",
                if (vector.variant == MediaVariant.PREVIEW) 1 else 2,
            )
            assertArrayEquals(decode(vector.streamKeyBase64), streamKey, vector.file)
            val blob = Files.readAllBytes(vectorPath(vector.file))
            assertArrayEquals(decode(vector.headerBase64), blob.copyOfRange(0, 24))
            val result = MediaReader.open(
                sodium = provider.sodium,
                blob = blob,
                streamKey = streamKey,
                aad = if (vector.variant == MediaVariant.PREVIEW) previewAad else originalAad,
                expectedCiphertextBytes = vector.ciphertextBytes,
                expectedCiphertextSha256 = decode(vector.ciphertextSha256Base64),
                expectedPlaintextSha256 = decode(vector.plaintextSha256Base64),
            )
            assertEquals(vector.frameCount, result.frameCount, vector.file)
            assertArrayEquals(plaintextPattern(vector.plaintextBytes), result.plaintext, vector.file)
            results[vector.file] = result
        }
        assertEquals(8, results.size)

        val encryptedManifest = Files.readAllBytes(vectorPath("manifest-canonical.bin"))
        val manifest = ManifestReader.open(
            sodium = provider.sodium,
            encryptedManifest = encryptedManifest,
            tripKey = decode(TRIP_KEY),
            aad = manifestAad,
        )
        assertArrayEquals(contentRoot, manifest.contentRoot)
        assertEquals(1_777_777_777_777uL, manifest.capturedAtMilliseconds)
        assertEquals("Café.jpg", manifest.filename)
        assertEquals(263, manifest.plaintext.size)
        assertArrayEquals(
            decode("ECuIKD1dVy6zNUPrb9AfxfFETbdxxMaNq7ozlxOAuvY="),
            sha256(manifest.plaintext),
        )
        val previewResult = checkNotNull(results["media-one-preview.bin"])
        val originalResult = checkNotNull(results["media-chunk-plus-one-original.bin"])
        ManifestReader.assertMatchesMedia(manifest.preview, previewResult)
        ManifestReader.assertMatchesMedia(manifest.original, originalResult)
        assertEquals("image/jpeg", manifest.preview.mime)
        assertEquals(320u, manifest.preview.pixelWidth)
        assertEquals(240u, manifest.preview.pixelHeight)
        assertEquals("video/mp4", manifest.original.mime)
        assertEquals(1_920u, manifest.original.pixelWidth)
        assertEquals(1_080u, manifest.original.pixelHeight)

        val canonicalTripKey = decode(TRIP_KEY)
        val substitutedTripKey = decode(SUBSTITUTED_TRIP_KEY)
        envelopeVectors.forEach { vector ->
            val secretKey = if (vector.recipientDeviceId == OWNER_DEVICE_ID) {
                decode(OWNER_SECRET_KEY)
            } else {
                decode(RECIPIENT_SECRET_KEY)
            }
            val opened = EnvelopeReader.open(
                sodium = provider.sodium,
                ciphertext = Files.readAllBytes(vectorPath(vector.file)),
                recipientPublicKey = decode(vector.recipientPublicKeyBase64),
                recipientSecretKey = secretKey,
                expectedTripId = TRIP_ID,
                expectedSenderDeviceId = OWNER_DEVICE_ID,
                expectedRecipientDeviceId = vector.recipientDeviceId,
                expectedRecipientE2eeKeyVersion = 1,
            )
            assertArrayEquals(decode(vector.expectedTripKeyBase64), opened, vector.file)
            if (vector.residualAnonymousSubstitution) {
                assertArrayEquals(substitutedTripKey, opened)
                assertFalse(opened.contentEquals(canonicalTripKey))
            } else {
                assertArrayEquals(canonicalTripKey, opened)
            }
        }
    }

    @Test
    fun sodiumExtractionVerifiesBeforeLoadingUsesNoFallbackAndDeletesOnClose() {
        assertEquals("1.0.20", provider.version)
        assertTrue(Files.isRegularFile(provider.extractedLibrary))
        assertTrue(provider.extractedLibrary.isAbsolute)

        val source = Files.readString(
            Path.of(System.getProperty("user.dir"))
                .resolve("src/main/kotlin/com/uankit53/crewroll/crypto/SodiumProvider.kt"),
        )
        assertFalse(source.contains("LibraryLoader.Mode"))
        assertFalse(Regex("SodiumJava\\s*\\(\\s*\\)").containsMatchIn(source))
        assertTrue(source.contains("sodiumFactory(libraryPath.toString())"))

        val before = sodiumTemporaryDirectories()
        var missingFactoryCalls = 0
        assertThrows(CryptoReadException::class.java) {
            VerifiedSodiumProvider.openVerified(
                resource = { null },
                expectedSha256 = "0".repeat(64),
                sodiumFactory = {
                    missingFactoryCalls += 1
                    error("factory must not run")
                },
            )
        }
        assertEquals(0, missingFactoryCalls)
        assertEquals(before, sodiumTemporaryDirectories())

        var mismatchFactoryCalls = 0
        val mismatch = assertThrows(CryptoReadException::class.java) {
            VerifiedSodiumProvider.openVerified(
                resource = { ByteArrayInputStream(byteArrayOf(1, 2, 3)) },
                expectedSha256 = "0".repeat(64),
                sodiumFactory = {
                    mismatchFactoryCalls += 1
                    error("factory must not run")
                },
            )
        }
        assertEquals(CryptoFailure.CHECKSUM, mismatch.failure)
        assertEquals(0, mismatchFactoryCalls)
        assertEquals(before, sodiumTemporaryDirectories())

        val disposable = VerifiedSodiumProvider.open()
        val extracted = disposable.extractedLibrary
        val directory = checkNotNull(extracted.parent)
        assertTrue(Files.exists(extracted))
        disposable.close()
        assertFalse(Files.exists(extracted))
        assertFalse(Files.exists(directory))
    }

    @Test
    fun aadSemanticAndCanonicalizationMutationMatrix() {
        val record = mediaVectors.first { it.file == "media-one-preview.bin" }
        val blob = Files.readAllBytes(vectorPath(record.file))
        val key = decode(record.streamKeyBase64)
        val mediaAad = CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW)
        val manifestAad = CrewRollAad.manifest(TRIP_ID, ASSET_ID)

        assertArrayEquals(
            mediaAad,
            CrewRollAad.media(TRIP_ID.uppercase(), ASSET_ID.uppercase(), MediaVariant.PREVIEW),
        )
        assertArrayEquals(
            manifestAad,
            CrewRollAad.manifest(TRIP_ID.uppercase(), ASSET_ID.uppercase()),
        )
        listOf(
            TRIP_ID.replace("-", ""),
            "g${TRIP_ID.drop(1)}",
            TRIP_ID.dropLast(1),
        ).forEach { malformed ->
            assertCryptoFailure(CryptoFailure.STRUCTURE, "malformed UUID $malformed") {
                CrewRollAad.media(malformed, ASSET_ID, MediaVariant.PREVIEW)
            }
        }
        assertCryptoFailure(CryptoFailure.STRUCTURE, "malformed asset UUID") {
            CrewRollAad.manifest(TRIP_ID, ASSET_ID.dropLast(1))
        }
        listOf(0L, 2L).forEach { value ->
            assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT, "media epoch $value") {
                CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW, keyEpoch = value)
            }
            assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT, "media format $value") {
                CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW, formatVersion = value)
            }
            assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT, "manifest epoch $value") {
                CrewRollAad.manifest(TRIP_ID, ASSET_ID, keyEpoch = value)
            }
            assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT, "manifest format $value") {
                CrewRollAad.manifest(TRIP_ID, ASSET_ID, formatVersion = value)
            }
        }

        val swappedMediaIds = mediaAad.copyOf().also { candidate ->
            val trip = candidate.copyOfRange(14, 50)
            val asset = candidate.copyOfRange(50, 86)
            asset.copyInto(candidate, 14)
            trip.copyInto(candidate, 50)
        }
        val mediaCases = listOf(
            Triple("wrong trip", flipped(mediaAad, 14), CryptoFailure.AUTHENTICATION),
            Triple("wrong asset", flipped(mediaAad, 50), CryptoFailure.AUTHENTICATION),
            Triple("wrong variant", flipped(mediaAad, 86), CryptoFailure.AUTHENTICATION),
            Triple("wrong epoch", flipped(mediaAad, 90), CryptoFailure.AUTHENTICATION),
            Triple("wrong format", flipped(mediaAad, 94), CryptoFailure.AUTHENTICATION),
            Triple("field order", swappedMediaIds, CryptoFailure.AUTHENTICATION),
            Triple(
                "epoch byte order",
                replacingBytes(mediaAad, 87, 91, byteArrayOf(1, 0, 0, 0)),
                CryptoFailure.AUTHENTICATION,
            ),
            Triple(
                "format byte order",
                replacingBytes(mediaAad, 91, 95, byteArrayOf(1, 0, 0, 0)),
                CryptoFailure.AUTHENTICATION,
            ),
            Triple("missing byte", mediaAad.copyOf(mediaAad.size - 1), CryptoFailure.STRUCTURE),
            Triple("extra byte", mediaAad + byteArrayOf(0), CryptoFailure.STRUCTURE),
            Triple("single domain bit", flipped(mediaAad, 0), CryptoFailure.AUTHENTICATION),
        )
        mediaCases.forEach { (label, candidate, expected) ->
            assertCryptoFailure(expected, label) {
                openMutatedMedia(blob, record, candidate, key)
            }
        }

        val encryptedManifest = Files.readAllBytes(vectorPath("manifest-canonical.bin"))
        val tripKey = decode(TRIP_KEY)
        val swappedManifestIds = manifestAad.copyOf().also { candidate ->
            val trip = candidate.copyOfRange(14, 50)
            val asset = candidate.copyOfRange(50, 86)
            asset.copyInto(candidate, 14)
            trip.copyInto(candidate, 50)
        }
        val manifestCases = listOf(
            Triple("manifest wrong trip", flipped(manifestAad, 14), CryptoFailure.AUTHENTICATION),
            Triple("manifest wrong asset", flipped(manifestAad, 50), CryptoFailure.AUTHENTICATION),
            Triple("manifest wrong epoch", flipped(manifestAad, 89), CryptoFailure.AUTHENTICATION),
            Triple("manifest wrong format", flipped(manifestAad, 93), CryptoFailure.AUTHENTICATION),
            Triple("manifest field order", swappedManifestIds, CryptoFailure.AUTHENTICATION),
            Triple(
                "manifest epoch byte order",
                replacingBytes(manifestAad, 86, 90, byteArrayOf(1, 0, 0, 0)),
                CryptoFailure.AUTHENTICATION,
            ),
            Triple(
                "manifest format byte order",
                replacingBytes(manifestAad, 90, 94, byteArrayOf(1, 0, 0, 0)),
                CryptoFailure.AUTHENTICATION,
            ),
            Triple(
                "manifest missing byte",
                manifestAad.copyOf(manifestAad.size - 1),
                CryptoFailure.STRUCTURE,
            ),
            Triple("manifest extra byte", manifestAad + byteArrayOf(0), CryptoFailure.STRUCTURE),
            Triple("manifest domain bit", flipped(manifestAad, 0), CryptoFailure.AUTHENTICATION),
        )
        manifestCases.forEach { (label, candidate, expected) ->
            assertCryptoFailure(expected, label) {
                ManifestReader.open(provider.sodium, encryptedManifest, tripKey, candidate)
            }
        }
    }

    @Test
    fun mediaCorruptionFramingTagsAndChecksumsFailClosed() {
        val record = mediaVectors.first {
            it.variant == MediaVariant.PREVIEW && it.plaintextBytes == 262_145
        }
        val blob = Files.readAllBytes(vectorPath(record.file))
        val aad = CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW)
        val key = decode(record.streamKeyBase64)

        listOf(0, 12, 23, 28, blob.size / 2, blob.lastIndex).forEach { offset ->
            assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
                openMutatedMedia(flipped(blob, offset), record, aad, key)
            }
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            openMutatedMedia(blob, record, flipped(aad, 0), key)
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            openMutatedMedia(blob, record, aad, flipped(key, 0))
        }

        listOf(0, 1, 23, 24, 25, 27, 28, blob.lastIndex).forEach { cut ->
            assertCryptoFailure(CryptoFailure.STRUCTURE) {
                openMutatedMedia(blob.copyOfRange(0, cut), record, aad, key)
            }
        }
        listOf(0L, 16L, 262_162L).forEach { length ->
            assertCryptoFailure(CryptoFailure.STRUCTURE) {
                openMutatedMedia(replacingU32(blob, 24, length), record, aad, key)
            }
        }
        assertCryptoFailure(CryptoFailure.STRUCTURE) {
            openMutatedMedia(blob + byteArrayOf(0), record, aad, key)
        }
        assertCryptoFailure(CryptoFailure.CHECKSUM) {
            MediaReader.open(
                provider.sodium,
                blob,
                key,
                aad,
                blob.size.toLong() + 1,
                sha256(blob),
                decode(record.plaintextSha256Base64),
            )
        }
        assertCryptoFailure(CryptoFailure.CHECKSUM) {
            MediaReader.open(
                provider.sodium,
                blob,
                key,
                aad,
                blob.size.toLong(),
                ByteArray(32),
                decode(record.plaintextSha256Base64),
            )
        }
        assertCryptoFailure(CryptoFailure.CHECKSUM) {
            MediaReader.open(
                provider.sodium,
                blob,
                key,
                aad,
                blob.size.toLong(),
                sha256(blob),
                ByteArray(32),
            )
        }

        val full = plaintextPattern(262_144)
        val missingFinal = oracleMedia(
            listOf(full to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_message()),
            aad,
            key,
        )
        assertCryptoFailure(CryptoFailure.STRUCTURE) {
            openMutatedMedia(missingFinal, record, aad, key)
        }
        val earlyFinal = oracleMedia(
            listOf(
                full to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_final(),
                byteArrayOf(0x5a) to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_final(),
            ),
            aad,
            key,
        )
        assertCryptoFailure(CryptoFailure.STRUCTURE) {
            openMutatedMedia(earlyFinal, record, aad, key)
        }
        val shortMessage = oracleMedia(
            listOf(byteArrayOf(1) to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_message()),
            aad,
            key,
        )
        assertCryptoFailure(CryptoFailure.STRUCTURE) {
            openMutatedMedia(shortMessage, record, aad, key)
        }
        listOf(
            provider.sodium.crypto_secretstream_xchacha20poly1305_tag_push(),
            provider.sodium.crypto_secretstream_xchacha20poly1305_tag_rekey(),
            4.toByte(),
        ).forEach { tag ->
            val forbidden = oracleMedia(listOf(byteArrayOf(1) to tag), aad, key)
            assertCryptoFailure(CryptoFailure.STRUCTURE) {
                openMutatedMedia(forbidden, record, aad, key)
            }
        }

        val frames = framedRecords(blob)
        assertEquals(2, frames.size)
        val reordered = blob.copyOfRange(0, 24) + frames.reversed().fold(ByteArray(0)) { all, frame -> all + frame }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            openMutatedMedia(reordered, record, aad, key)
        }
        val duplicated = blob.copyOfRange(0, 24) + frames[0] + frames[0] + frames[1]
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            openMutatedMedia(duplicated, record, aad, key)
        }
    }

    @Test
    fun everyMediaStructuralBoundaryAndFrameSubstitutionFailsClosed() {
        val empty = mediaVectors.first { it.file == "media-empty-preview.bin" }
        val one = mediaVectors.first { it.file == "media-one-preview.bin" }
        val full = mediaVectors.first { it.file == "media-exact-chunk-preview.bin" }
        val two = mediaVectors.first { it.file == "media-chunk-plus-one-preview.bin" }
        val emptyBlob = Files.readAllBytes(vectorPath(empty.file))
        val oneBlob = Files.readAllBytes(vectorPath(one.file))
        val fullBlob = Files.readAllBytes(vectorPath(full.file))
        val twoBlob = Files.readAllBytes(vectorPath(two.file))
        val aad = CrewRollAad.media(TRIP_ID, ASSET_ID, MediaVariant.PREVIEW)
        val key = decode(one.streamKeyBase64)

        assertEquals(listOf(17), framedRecords(emptyBlob).map { it.size - 4 })
        openMutatedMedia(emptyBlob, empty, aad, key)
        assertEquals(listOf(262_161), framedRecords(fullBlob).map { it.size - 4 })
        openMutatedMedia(fullBlob, full, aad, key)

        listOf(0L, 16L, 17L, 262_161L).forEach { value ->
            assertCryptoFailure(CryptoFailure.STRUCTURE, "prefix $value in invalid place") {
                openMutatedMedia(replacingU32(oneBlob, 24, value), one, aad, key)
            }
        }
        assertCryptoFailure(CryptoFailure.STRUCTURE, "prefix above maximum") {
            openMutatedMedia(replacingU32(fullBlob, 24, 262_162), full, aad, key)
        }

        val frames = framedRecords(twoBlob)
        val firstEnd = 24 + frames.first().size
        val cuts = setOf(
            0,
            1,
            23,
            24,
            25,
            27,
            28,
            29,
            28 + 262_161 / 2,
            firstEnd - 1,
            firstEnd,
            firstEnd + 1,
            firstEnd + 4,
            firstEnd + 5,
            firstEnd + 4 + 18 / 2,
            twoBlob.lastIndex,
        )
        cuts.forEach { cut ->
            assertCryptoFailure(CryptoFailure.STRUCTURE, "cut at $cut") {
                openMutatedMedia(twoBlob.copyOfRange(0, cut), two, aad, key)
            }
        }

        val completeFrame = plaintextPattern(262_144)
        val lastByte = byteArrayOf(0x5a)
        val threeFrames = oracleMedia(
            listOf(
                completeFrame to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_message(),
                completeFrame to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_message(),
                lastByte to provider.sodium.crypto_secretstream_xchacha20poly1305_tag_final(),
            ),
            aad,
            key,
        )
        val records = framedRecords(threeFrames)
        assertEquals(3, records.size)
        val arrangements = listOf(
            "reversed frames" to listOf(records[2], records[1], records[0]),
            "duplicated middle" to listOf(records[0], records[1], records[1], records[2]),
            "omitted middle" to listOf(records[0], records[2]),
        )
        arrangements.forEach { (label, arrangement) ->
            val candidate = arrangement.fold(threeFrames.copyOfRange(0, 24)) { all, frame ->
                all + frame
            }
            assertCryptoFailure(CryptoFailure.AUTHENTICATION, label) {
                openMutatedMedia(candidate, two, aad, key)
            }
        }

        val original = mediaVectors.first { it.file == "media-one-original.bin" }
        val originalFrames = framedRecords(Files.readAllBytes(vectorPath(original.file)))
        val crossVariant = originalFrames.fold(oneBlob.copyOfRange(0, 24)) { all, frame ->
            all + frame
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION, "cross-variant frame") {
            openMutatedMedia(crossVariant, one, aad, key)
        }
    }

    @Test
    fun manifestAuthenticationSemanticsAndDescriptorParityFailClosed() {
        val tripKey = decode(TRIP_KEY)
        val aad = CrewRollAad.manifest(TRIP_ID, ASSET_ID)
        val encrypted = Files.readAllBytes(vectorPath("manifest-canonical.bin"))
        val plaintext = decryptManifest(encrypted, tripKey, aad)

        listOf(
            flipped(encrypted, 0),
            flipped(encrypted, 12),
            flipped(encrypted, 23),
            flipped(encrypted, encrypted.size / 2),
            flipped(encrypted, encrypted.lastIndex),
            encrypted.copyOf(encrypted.size - 1),
            encrypted + byteArrayOf(0),
        ).forEach { mutation ->
            assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
                ManifestReader.open(provider.sodium, mutation, tripKey, aad)
            }
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            ManifestReader.open(provider.sodium, encrypted, flipped(tripKey, 0), aad)
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            ManifestReader.open(provider.sodium, encrypted, tripKey, flipped(aad, 0))
        }

        assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT) {
            openAuthenticatedManifest(flipped(plaintext, 0), encrypted, tripKey, aad)
        }
        val wrongSchema = plaintext.copyOf().also { it[11] = 2 }
        assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT) {
            openAuthenticatedManifest(wrongSchema, encrypted, tripKey, aad)
        }

        val structuralMutations = listOf(
            plaintext.copyOf().also { it[55] = '/'.code.toByte() },
            plaintext.copyOf().also { it[55] = 0xff.toByte() },
            plaintext.copyOf().also { it[53] = 0xff.toByte(); it[54] = 0xff.toByte() },
            plaintext.copyOf().also { it[66] = 'I'.code.toByte() },
            plaintext.copyOf().also { it[44] = 0 },
            plaintext.copyOf().also { it.fill(0, 45, 53) },
            plaintext.copyOf().also { it[44] = 2 },
            plaintext.copyOf().also { it[164] = 1 },
            plaintext.copyOf().also { it[64] = 2 },
            plaintext.copyOf().also { it[64] = 3 },
            plaintext.copyOfRange(0, 164),
            plaintext.copyOfRange(0, 53) + byteArrayOf(0, 10) + "Cafe\u0301.jpg".toByteArray() + plaintext.copyOfRange(64, plaintext.size),
            plaintext + byteArrayOf(0),
        )
        structuralMutations.forEach { mutation ->
            assertCryptoFailure(CryptoFailure.STRUCTURE) {
                openAuthenticatedManifest(mutation, encrypted, tripKey, aad)
            }
        }

        val previewVector = mediaVectors.first { it.file == "media-one-preview.bin" }
        val previewResult = openMedia(previewVector)
        val canonical = ManifestReader.open(provider.sodium, encrypted, tripKey, aad)
        ManifestReader.assertMatchesMedia(canonical.preview, previewResult)
        listOf(91, 92, 123, 131, 132, 163).forEach { offset ->
            val opened = openAuthenticatedManifest(flipped(plaintext, offset), encrypted, tripKey, aad)
            assertCryptoFailure(CryptoFailure.CHECKSUM) {
                ManifestReader.assertMatchesMedia(opened.preview, previewResult)
            }
        }
    }

    @Test
    fun manifestFilenameMimeUnicodeBoundsAndCaptureMutationMatrix() {
        val tripKey = decode(TRIP_KEY)
        val aad = CrewRollAad.manifest(TRIP_ID, ASSET_ID)
        val encrypted = Files.readAllBytes(vectorPath("manifest-canonical.bin"))
        val plaintext = decryptManifest(encrypted, tripKey, aad)

        listOf("below encrypted minimum" to 280, "above encrypted maximum" to 785)
            .forEach { (label, count) ->
                assertCryptoFailure(CryptoFailure.STRUCTURE, label) {
                    ManifestReader.open(provider.sodium, ByteArray(count), tripKey, aad)
                }
            }
        listOf("below plaintext minimum" to 240, "above plaintext maximum" to 745)
            .forEach { (label, count) ->
                assertCryptoFailure(CryptoFailure.STRUCTURE, label) {
                    ManifestReader.parse(ByteArray(count))
                }
            }

        val astral = openAuthenticatedManifest(
            manifestWithFilename(plaintext, "photo-😀.jpg".toByteArray()),
            encrypted,
            tripKey,
            aad,
        )
        assertEquals("photo-😀.jpg", astral.filename)
        val absent = openAuthenticatedManifest(
            manifestWithFilename(plaintext, ByteArray(0)),
            encrypted,
            tripKey,
            aad,
        )
        assertEquals(null, absent.filename)

        val captureTooLate = replacingU64(plaintext, 45, 253_402_300_800_000uL)
        val zeroWidth = plaintext.copyOf().also { it.fill(0, 76, 80) }
        val zeroHeight = plaintext.copyOf().also { it.fill(0, 80, 84) }
        val shortCiphertext = replacingU64(plaintext, 124, 44uL)
        val filenameOverrun = plaintext.copyOf().also {
            it[53] = 0xff.toByte()
            it[54] = 0xff.toByte()
        }
        val filenameCases = listOf(
            "forward slash" to manifestWithFilename(plaintext, "bad/name.jpg".toByteArray()),
            "backslash" to manifestWithFilename(plaintext, "bad\\name.jpg".toByteArray()),
            "ASCII control" to manifestWithFilename(plaintext, byteArrayOf(0x1f)),
            "DEL" to manifestWithFilename(plaintext, byteArrayOf(0x7f)),
            "invalid UTF-8" to manifestWithFilename(plaintext, byteArrayOf(0xff.toByte())),
            "isolated high surrogate" to manifestWithFilename(
                plaintext,
                byteArrayOf(0xed.toByte(), 0xa0.toByte(), 0x80.toByte()),
            ),
            "isolated low surrogate" to manifestWithFilename(
                plaintext,
                byteArrayOf(0xed.toByte(), 0xb0.toByte(), 0x80.toByte()),
            ),
            "decomposed Unicode" to manifestWithFilename(
                plaintext,
                "Cafe\u0301.jpg".toByteArray(),
            ),
            "256-byte filename" to manifestWithFilename(plaintext, ByteArray(256) { 0x61 }),
            "filename length overrun" to filenameOverrun,
        )
        val mimeCases = listOf(
            "uppercase MIME" to manifestWithPreviewMime(plaintext, "Image/jpeg".toByteArray()),
            "parameterized MIME" to manifestWithPreviewMime(plaintext, "image/jp;g".toByteArray()),
            "whitespace MIME" to manifestWithPreviewMime(plaintext, "image/ jpg".toByteArray()),
            "two slashes" to manifestWithPreviewMime(plaintext, "image//peg".toByteArray()),
            "short MIME" to manifestWithPreviewMime(plaintext, "a/".toByteArray()),
            "128-byte MIME" to manifestWithPreviewMime(
                plaintext,
                "a/".toByteArray() + ByteArray(126) { 0x62 },
            ),
            "non-ASCII MIME" to manifestWithPreviewMime(
                plaintext,
                byteArrayOf(0xff.toByte(), '/'.code.toByte(), 'a'.code.toByte()),
            ),
        )
        val structuralCases = filenameCases + mimeCases + listOf(
            "capture after year 9999" to captureTooLate,
            "zero pixel width" to zeroWidth,
            "zero pixel height" to zeroHeight,
            "ciphertext below 45 bytes" to shortCiphertext,
        )
        structuralCases.forEach { (label, candidate) ->
            assertCryptoFailure(CryptoFailure.STRUCTURE, label) {
                openAuthenticatedManifest(candidate, encrypted, tripKey, aad)
            }
        }

        val allowedMime = "a!#$&^_.+-/b0"
        val allowed = openAuthenticatedManifest(
            manifestWithPreviewMime(plaintext, allowedMime.toByteArray()),
            encrypted,
            tripKey,
            aad,
        )
        assertEquals(allowedMime, allowed.preview.mime)
    }

    @Test
    fun authenticatedDescriptorMetadataDisagreementFailsParity() {
        val canonical = ManifestReader.open(
            provider.sodium,
            Files.readAllBytes(vectorPath("manifest-canonical.bin")),
            decode(TRIP_KEY),
            CrewRollAad.manifest(TRIP_ID, ASSET_ID),
        )
        val expected = canonical.preview
        val mutations = listOf(
            "variant" to expected.copy(variant = MediaVariant.ORIGINAL),
            "MIME" to expected.copy(mime = "image/jpef"),
            "pixel width" to expected.copy(pixelWidth = expected.pixelWidth + 1u),
            "pixel height" to expected.copy(pixelHeight = expected.pixelHeight + 1u),
            "plaintext length" to expected.copy(plaintextBytes = expected.plaintextBytes + 1uL),
            "plaintext hash" to expected.copy(
                plaintextSha256 = flipped(expected.plaintextSha256, 0),
            ),
            "ciphertext length" to expected.copy(ciphertextBytes = expected.ciphertextBytes + 1uL),
            "ciphertext hash" to expected.copy(
                ciphertextSha256 = flipped(expected.ciphertextSha256, 31),
            ),
        )
        mutations.forEach { (label, mutation) ->
            assertCryptoFailure(CryptoFailure.CHECKSUM, label) {
                ManifestReader.assertMatchesDescriptor(mutation, expected)
            }
        }
    }

    @Test
    fun envelopeCorruptionAndContextMutationsFailClosedExceptNamedSubstitution() {
        val recipient = envelopeVectors.first { it.kind == "OWNER_RECIPIENT" }
        val owner = envelopeVectors.first { it.kind == "OWNER_SELF" }
        val ciphertext = Files.readAllBytes(vectorPath(recipient.file))
        val publicKey = decode(recipient.recipientPublicKeyBase64)
        val secretKey = decode(RECIPIENT_SECRET_KEY)

        val uppercaseContext = EnvelopeReader.open(
            provider.sodium,
            ciphertext,
            publicKey,
            secretKey,
            TRIP_ID.uppercase(),
            OWNER_DEVICE_ID.uppercase(),
            RECIPIENT_DEVICE_ID.uppercase(),
            1,
        )
        assertArrayEquals(decode(TRIP_KEY), uppercaseContext)
        assertCryptoFailure(CryptoFailure.STRUCTURE, "malformed expected envelope UUID") {
            EnvelopeReader.open(
                provider.sodium,
                ciphertext,
                publicKey,
                secretKey,
                TRIP_ID.dropLast(1),
                OWNER_DEVICE_ID,
                RECIPIENT_DEVICE_ID,
                1,
            )
        }

        listOf(0, ciphertext.size / 2, ciphertext.lastIndex).forEach { offset ->
            assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
                openEnvelope(flipped(ciphertext, offset), recipient, publicKey, secretKey)
            }
        }
        assertCryptoFailure(CryptoFailure.AUTHENTICATION) {
            openEnvelope(
                ciphertext,
                recipient,
                decode(owner.recipientPublicKeyBase64),
                decode(OWNER_SECRET_KEY),
            )
        }
        listOf(0, 48, 56, 60, 76, 80, 96, 112, 116, 147).forEach { count ->
            assertCryptoFailure(CryptoFailure.STRUCTURE) {
                openEnvelope(ciphertext.copyOfRange(0, count), recipient, publicKey, secretKey)
            }
        }
        assertCryptoFailure(CryptoFailure.STRUCTURE) {
            openEnvelope(ciphertext + byteArrayOf(0), recipient, publicKey, secretKey)
        }

        val plaintext = openSealedBox(ciphertext, publicKey, secretKey)
        listOf(0, 11, 12, 31, 32, 48, 67).forEach { offset ->
            val mutation = sealBox(flipped(plaintext, offset), publicKey)
            assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT) {
                openEnvelope(mutation, recipient, publicKey, secretKey)
            }
        }
        assertCryptoFailure(CryptoFailure.SEMANTIC_CONTEXT) {
            EnvelopeReader.open(
                provider.sodium,
                ciphertext,
                publicKey,
                secretKey,
                TRIP_ID,
                OWNER_DEVICE_ID,
                RECIPIENT_DEVICE_ID,
                2,
            )
        }

        val substitution = envelopeVectors.first { it.kind == "FIRST_IMPORT_SUBSTITUTION" }
        val substituted = openEnvelope(
            Files.readAllBytes(vectorPath(substitution.file)),
            substitution,
            decode(substitution.recipientPublicKeyBase64),
            secretKey,
        )
        assertArrayEquals(decode(SUBSTITUTED_TRIP_KEY), substituted)
        assertFalse(substituted.contentEquals(decode(TRIP_KEY)))
    }

    private fun decode(value: String): ByteArray = Base64.getDecoder().decode(value)

    private fun deriveKey(
        root: ByteArray,
        context: String,
        subkeyId: Long,
    ): ByteArray = ByteArray(32).also { output ->
        assertEquals(
            0,
            provider.sodium.crypto_kdf_derive_from_key(
                output,
                output.size,
                subkeyId,
                context.toByteArray(Charsets.US_ASCII),
                root,
            ),
        )
    }

    private fun openMedia(vector: MediaVector): MediaReadResult = MediaReader.open(
        sodium = provider.sodium,
        blob = Files.readAllBytes(vectorPath(vector.file)),
        streamKey = decode(vector.streamKeyBase64),
        aad = CrewRollAad.media(TRIP_ID, ASSET_ID, vector.variant),
        expectedCiphertextBytes = vector.ciphertextBytes,
        expectedCiphertextSha256 = decode(vector.ciphertextSha256Base64),
        expectedPlaintextSha256 = decode(vector.plaintextSha256Base64),
    )

    private fun assertCryptoFailure(
        expected: CryptoFailure,
        label: String = "",
        operation: () -> Unit,
    ) {
        val error = assertThrows(CryptoReadException::class.java, operation)
        assertEquals(expected, error.failure, "$label: ${error.message}")
    }

    private fun openMutatedMedia(
        blob: ByteArray,
        vector: MediaVector,
        aad: ByteArray,
        key: ByteArray,
    ): MediaReadResult = MediaReader.open(
        sodium = provider.sodium,
        blob = blob,
        streamKey = key,
        aad = aad,
        expectedCiphertextBytes = blob.size.toLong(),
        expectedCiphertextSha256 = sha256(blob),
        expectedPlaintextSha256 = decode(vector.plaintextSha256Base64),
    )

    private fun flipped(bytes: ByteArray, offset: Int): ByteArray =
        bytes.copyOf().also { it[offset] = (it[offset].toInt() xor 1).toByte() }

    private fun replacingU32(
        bytes: ByteArray,
        offset: Int,
        value: Long,
    ): ByteArray = bytes.copyOf().also {
        ByteBuffer.wrap(it, offset, 4).order(ByteOrder.BIG_ENDIAN).putInt(value.toInt())
    }

    private fun replacingU64(
        bytes: ByteArray,
        offset: Int,
        value: ULong,
    ): ByteArray = bytes.copyOf().also { result ->
        repeat(8) { index ->
            result[offset + index] = (value shr ((7 - index) * 8)).toByte()
        }
    }

    private fun replacingBytes(
        bytes: ByteArray,
        fromIndex: Int,
        toIndex: Int,
        replacement: ByteArray,
    ): ByteArray = bytes.copyOfRange(0, fromIndex) +
        replacement +
        bytes.copyOfRange(toIndex, bytes.size)

    private fun manifestWithFilename(
        plaintext: ByteArray,
        filename: ByteArray,
    ): ByteArray {
        check(filename.size <= 0xffff)
        val length = ByteBuffer.allocate(2)
            .order(ByteOrder.BIG_ENDIAN)
            .putShort(filename.size.toShort())
            .array()
        return plaintext.copyOfRange(0, 53) +
            length +
            filename +
            plaintext.copyOfRange(64, plaintext.size)
    }

    private fun manifestWithPreviewMime(
        plaintext: ByteArray,
        mime: ByteArray,
    ): ByteArray {
        check(mime.size <= 0xff)
        return plaintext.copyOfRange(0, 65) +
            byteArrayOf(mime.size.toByte()) +
            mime +
            plaintext.copyOfRange(76, plaintext.size)
    }

    private fun oracleMedia(
        frames: List<Pair<ByteArray, Byte>>,
        aad: ByteArray,
        key: ByteArray,
    ): ByteArray {
        val state = SecretStream.State()
        val header = ByteArray(24)
        check(
            provider.sodium.crypto_secretstream_xchacha20poly1305_init_push(
                state,
                header,
                key,
            ) == 0,
        )
        return frames.fold(header) { output, (message, tag) ->
            val ciphertext = ByteArray(message.size + 17)
            val ciphertextLength = LongArray(1)
            check(
                provider.sodium.crypto_secretstream_xchacha20poly1305_push(
                    state,
                    ciphertext,
                    ciphertextLength,
                    message,
                    message.size.toLong(),
                    aad,
                    aad.size.toLong(),
                    tag,
                ) == 0,
            )
            check(ciphertextLength[0] == ciphertext.size.toLong())
            output + ByteBuffer.allocate(4)
                .order(ByteOrder.BIG_ENDIAN)
                .putInt(ciphertext.size)
                .array() + ciphertext
        }
    }

    private fun framedRecords(blob: ByteArray): List<ByteArray> {
        val records = mutableListOf<ByteArray>()
        var offset = 24
        while (offset < blob.size) {
            check(blob.size - offset >= 4)
            val length = ByteBuffer.wrap(blob, offset, 4)
                .order(ByteOrder.BIG_ENDIAN)
                .int
            check(length >= 0)
            val end = offset + 4 + length
            check(end <= blob.size)
            records += blob.copyOfRange(offset, end)
            offset = end
        }
        return records
    }

    private fun decryptManifest(
        encrypted: ByteArray,
        tripKey: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        val nonce = encrypted.copyOfRange(0, 24)
        val ciphertext = encrypted.copyOfRange(24, encrypted.size)
        val plaintext = ByteArray(ciphertext.size - 16)
        val plaintextLength = LongArray(1)
        check(
            provider.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
                plaintext,
                plaintextLength,
                null,
                ciphertext,
                ciphertext.size.toLong(),
                aad,
                aad.size.toLong(),
                nonce,
                ManifestReader.deriveManifestKey(provider.sodium, tripKey),
            ) == 0,
        )
        check(plaintextLength[0] == plaintext.size.toLong())
        return plaintext
    }

    private fun encryptManifest(
        plaintext: ByteArray,
        nonce: ByteArray,
        tripKey: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        val ciphertext = ByteArray(plaintext.size + 16)
        val ciphertextLength = LongArray(1)
        check(
            provider.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
                ciphertext,
                ciphertextLength,
                plaintext,
                plaintext.size.toLong(),
                aad,
                aad.size.toLong(),
                null,
                nonce,
                ManifestReader.deriveManifestKey(provider.sodium, tripKey),
            ) == 0,
        )
        check(ciphertextLength[0] == ciphertext.size.toLong())
        return nonce + ciphertext
    }

    private fun openAuthenticatedManifest(
        plaintext: ByteArray,
        canonical: ByteArray,
        tripKey: ByteArray,
        aad: ByteArray,
    ): ManifestReadResult = ManifestReader.open(
        provider.sodium,
        encryptManifest(plaintext, canonical.copyOfRange(0, 24), tripKey, aad),
        tripKey,
        aad,
    )

    private fun openEnvelope(
        ciphertext: ByteArray,
        vector: EnvelopeVector,
        publicKey: ByteArray,
        secretKey: ByteArray,
    ): ByteArray = EnvelopeReader.open(
        provider.sodium,
        ciphertext,
        publicKey,
        secretKey,
        TRIP_ID,
        OWNER_DEVICE_ID,
        vector.recipientDeviceId,
        1,
    )

    private fun openSealedBox(
        ciphertext: ByteArray,
        publicKey: ByteArray,
        secretKey: ByteArray,
    ): ByteArray = ByteArray(ciphertext.size - 48).also { plaintext ->
        check(
            provider.sodium.crypto_box_seal_open(
                plaintext,
                ciphertext,
                ciphertext.size.toLong(),
                publicKey,
                secretKey,
            ) == 0,
        )
    }

    private fun sealBox(
        plaintext: ByteArray,
        publicKey: ByteArray,
    ): ByteArray = ByteArray(plaintext.size + 48).also { ciphertext ->
        check(
            provider.sodium.crypto_box_seal(
                ciphertext,
                plaintext,
                plaintext.size.toLong(),
                publicKey,
            ) == 0,
        )
    }

    private fun plaintextPattern(count: Int): ByteArray =
        ByteArray(count) { index -> (index * 29 + 17).toByte() }

    private fun sodiumTemporaryDirectories(): Set<Path> =
        Files.list(Path.of(System.getProperty("java.io.tmpdir"))).use { paths ->
            paths
                .filter { it.fileName.toString().startsWith("crewroll-sodium-") }
                .toList()
                .toSet()
        }

    private fun vectorPath(file: String): Path {
        var root = Path.of(System.getProperty("user.dir"))
        check(root.fileName.toString() == "kotlin")
        repeat(2) { root = root.parent }
        return root.resolve("vectors/v1").resolve(file)
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        const val TRIP_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3130"
        const val ASSET_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3140"
        const val OWNER_DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3150"
        const val RECIPIENT_DEVICE_ID = "018f0d98-76fa-7d1a-b4b4-1f742c2e3160"
        const val TRIP_KEY = "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8="
        const val SUBSTITUTED_TRIP_KEY = "kJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq8="
        const val CONTENT_ROOT = "MDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk8="
        const val OWNER_SECRET_KEY = "7kARMZqE/onEWMkb3j4TS6qUBB73xReGD9bnjMah3Gg="
        const val RECIPIENT_SECRET_KEY = "lTmXvUJ7nghtew2sV7FnN1LmPWFJEv7BVQe0wpX3/UI="
        const val PREVIEW_AAD =
            "Q1JST0xMLUFBRC1WMQAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxMzAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxNDABAAAAAQAAAAE="
        const val ORIGINAL_AAD =
            "Q1JST0xMLUFBRC1WMQAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxMzAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxNDACAAAAAQAAAAE="
        const val MANIFEST_AAD =
            "Q1JST0xMLU1BTi1WMQAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxMzAwMThmMGQ5OC03NmZhLTdkMWEtYjRiNC0xZjc0MmMyZTMxNDAAAAABAAAAAQ=="

        val mediaVectors = listOf(
            MediaVector("media-empty-preview.bin", MediaVariant.PREVIEW, 0, 1, 45, "XaHlKW6y9jp/wwdLkNQYXBNXm98kaKzw", "Uw52sHB+WzNhtQkaT7E7ulycYuOVb1aAv+EQmvCZfb8=", "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", "NH9LRpNFtyuACiPqU979zNxGEHhxvprkieSPge6enAU="),
            MediaVector("media-one-preview.bin", MediaVariant.PREVIEW, 1, 1, 46, "MXW5/UaKzgJdoeUpbrL2On/DB0uQ1Bhc", "Uw52sHB+WzNhtQkaT7E7ulycYuOVb1aAv+EQmvCZfb8=", "SmShB/DLMlNuW85smMOT2yHMp/TqGHuoxNyotR1OqAo=", "CZDy3TztdGZcAJ4mv1JaaBh6fp3+KNgmG8qNcEA4l9o="),
            MediaVector("media-exact-chunk-preview.bin", MediaVariant.PREVIEW, 262_144, 1, 262_189, "E1eb3yRorPAxdbn9RorOAl2h5SlusvY6", "Uw52sHB+WzNhtQkaT7E7ulycYuOVb1aAv+EQmvCZfb8=", "po5wSdgWZ7VE1kcDx1tXm4wCSEyX28lWTClMbIoQvW0=", "Nm5qwb4MQOIR2pbEqAJQA3NkelxoSJ60p7PR1ohtBvM="),
            MediaVector("media-chunk-plus-one-preview.bin", MediaVariant.PREVIEW, 262_145, 2, 262_211, "f8MHS5DUGFwTV5vfJGis8DF1uf1Gis4C", "Uw52sHB+WzNhtQkaT7E7ulycYuOVb1aAv+EQmvCZfb8=", "Nz9FIWx9/PcSEvRuAtlwdEyYhmjx7Qn/nTzYsu1UsO8=", "sRyf6ioFnlHq15LRx1J5I21Yay0RcYOhYKMCUQQ1sfY="),
            MediaVector("media-empty-original.bin", MediaVariant.ORIGINAL, 0, 1, 45, "XaHlKW6y9jp/wwdLkNQYXBNXm98kaKzw", "ZsyJRVuU+16KeORGaf/+i1poFC91KraCFb0/XJNyjjk=", "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=", "ANKRJHFvukvM0vPCkqqClKg+jSVqKa8UAhPiJOFBhtQ="),
            MediaVector("media-one-original.bin", MediaVariant.ORIGINAL, 1, 1, 46, "MXW5/UaKzgJdoeUpbrL2On/DB0uQ1Bhc", "ZsyJRVuU+16KeORGaf/+i1poFC91KraCFb0/XJNyjjk=", "SmShB/DLMlNuW85smMOT2yHMp/TqGHuoxNyotR1OqAo=", "xKzQgUgh/zvUnf6l0tarRIK84xMh/G9k2aKRfp+0KPg="),
            MediaVector("media-exact-chunk-original.bin", MediaVariant.ORIGINAL, 262_144, 1, 262_189, "E1eb3yRorPAxdbn9RorOAl2h5SlusvY6", "ZsyJRVuU+16KeORGaf/+i1poFC91KraCFb0/XJNyjjk=", "po5wSdgWZ7VE1kcDx1tXm4wCSEyX28lWTClMbIoQvW0=", "sGduShT3Nt0XQGofowltfB6Bgkm/mnryFv15i1106NU="),
            MediaVector("media-chunk-plus-one-original.bin", MediaVariant.ORIGINAL, 262_145, 2, 262_211, "f8MHS5DUGFwTV5vfJGis8DF1uf1Gis4C", "ZsyJRVuU+16KeORGaf/+i1poFC91KraCFb0/XJNyjjk=", "Nz9FIWx9/PcSEvRuAtlwdEyYhmjx7Qn/nTzYsu1UsO8=", "JEWrII9+3q2Y2TR8BQ6QWKmQ1fQ0Le9xyYceCOpCq4w="),
        )

        val envelopeVectors = listOf(
            EnvelopeVector("envelope-owner-self.bin", "OWNER_SELF", OWNER_DEVICE_ID, "EIT5fcwxJb3Sw8y+V9yHL+JGU5pDVlgw9H5ueCV7OnI=", TRIP_KEY, false),
            EnvelopeVector("envelope-owner-recipient.bin", "OWNER_RECIPIENT", RECIPIENT_DEVICE_ID, "pwEP64FAv6NU2VaYsDwuGVIHpubBQnFsIQP2gBO6404=", TRIP_KEY, false),
            EnvelopeVector("envelope-first-import-substitution.bin", "FIRST_IMPORT_SUBSTITUTION", RECIPIENT_DEVICE_ID, "pwEP64FAv6NU2VaYsDwuGVIHpubBQnFsIQP2gBO6404=", SUBSTITUTED_TRIP_KEY, true),
        )

        val inventory = mapOf(
            "envelope-first-import-substitution.bin" to "87edf3b14aaa4f0f4061b0871ce098d47a11d99cbbe03011f41bf8631355926d",
            "envelope-owner-recipient.bin" to "f3f961bdbbe528e97c99b4334233fe9e689d474cb0e2539ee6bd0c2a2c4d77b3",
            "envelope-owner-self.bin" to "37c7b4c1712d5cf47f4e24a9329aad36c40d2296d3d34d978bf5279c5a7d2e83",
            "manifest-canonical.bin" to "a717344138975e1b5b4dac3f7b7c9f7baf9ff9ebdc6b9ab31b6d25ac93ccc6f6",
            "media-chunk-plus-one-original.bin" to "2445ab208f7edead98d9347c050e9058a990d5f4342def71c9871e08ea42ab8c",
            "media-chunk-plus-one-preview.bin" to "b11c9fea2a059e51ead792d1c75279236d586b2d117183a160a302510435b1f6",
            "media-empty-original.bin" to "00d29124716fba4bccd2f3c292aa8294a83e8d256a29af140213e224e14186d4",
            "media-empty-preview.bin" to "347f4b469345b72b800a23ea53defdccdc46107871be9ae489e48f81ee9e9c05",
            "media-exact-chunk-original.bin" to "b0676e4a14f736dd17406a1fa3096d7c1e818249bf9a7af216fd798b5d74e8d5",
            "media-exact-chunk-preview.bin" to "366e6ac1be0c40e211da96c4a802500373647a5c68489eb4a7b3d1d6886d06f3",
            "media-one-original.bin" to "c4acd0814821ff3bd49dfea5d2d6ab4482bce31321fc6f64d9a2917e9fb428f8",
            "media-one-preview.bin" to "0990f2dd3ced74665c009e26bf525a68187a7e9dfe28d8261bca8d70403897da",
        )
    }
}
