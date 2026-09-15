package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.crypto.VerifiedSodiumProvider
import com.uankit53.crewroll.crypto.MediaReader as ReferenceReader
import com.uankit53.crewroll.crypto.ManifestReader as ReferenceManifest
import java.nio.file.Files
import java.time.Instant
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

class NativePhotoCryptoTest {
    private val trip = "01990000-0000-7000-8000-000000000001"
    private val asset = "01990000-0000-4000-8000-000000000002"
    @Test fun `streaming encryption matches the independent v1 reader at frame boundaries`() {
        VerifiedSodiumProvider.open().use { provider ->
            val crypto = NativePhotoCrypto(provider.sodium)
            val root = crypto.randomKey(); val tripKey = crypto.randomKey()
            val dir = Files.createTempDirectory("crewroll-crypto-test-").toFile()
            try {
                for (size in listOf(0, 1, 262_143, 262_144, 262_145, 524_288, 1_048_577)) {
                    val bytes = ByteArray(size) { it.toByte() }
                    val source = dir.resolve("source-$size").apply { writeBytes(bytes) }
                    val encrypted = dir.resolve("encrypted-$size"); val output = dir.resolve("out-$size")
                    val d = crypto.encrypt(source, encrypted, root, trip, asset, MediaVariant.ORIGINAL, "image/jpeg", 1200u, 800u)
                    val key = crypto.mediaKey(root, MediaVariant.ORIGINAL)
                    try {
                        val reference = ReferenceReader.open(provider.sodium, encrypted.readBytes(), key, CrewRollAad.media(trip, asset, MediaVariant.ORIGINAL), d.ciphertextBytes.toLong(), d.ciphertextSha256, d.plaintextSha256)
                        assertArrayEquals(bytes, reference.plaintext)
                    } finally { key.fill(0) }
                    crypto.decrypt(encrypted, output, d, root, trip, asset); assertArrayEquals(bytes, output.readBytes())
                    val preview = d.copy(variant = MediaVariant.PREVIEW)
                    val manifest = crypto.sealManifest(root, Instant.ofEpochMilli(1_700_000_000_000), preview, d, tripKey, trip, asset)
                    val read = ReferenceManifest.open(provider.sodium, manifest, tripKey, CrewRollAad.manifest(trip, asset))
                    assertArrayEquals(root, read.contentRoot); assertEquals(d.plaintextBytes, read.original.plaintextBytes)
                    val opened = crypto.openManifest(manifest, tripKey, trip, asset); opened.erase()
                    assertTrue(opened.contentRoot.all { it == 0.toByte() }); assertTrue(opened.plaintext.all { it == 0.toByte() })
                }
            } finally { root.fill(0); tripKey.fill(0); dir.deleteRecursively() }
        }
    }
    @Test fun `tamper wrong context and truncated streams never leave output or overwrite existing files`() {
        VerifiedSodiumProvider.open().use { provider ->
            val crypto = NativePhotoCrypto(provider.sodium); val root = crypto.randomKey()
            val dir = Files.createTempDirectory("crewroll-corruption-test-").toFile()
            try {
                val source = dir.resolve("source").apply { writeBytes(ByteArray(262_145) { 42 }) }
                val encrypted = dir.resolve("ciphertext"); val output = dir.resolve("out")
                val d = crypto.encrypt(source, encrypted, root, trip, asset, MediaVariant.ORIGINAL, "image/jpeg", 1u, 1u)
                assertThrows(Exception::class.java) { crypto.decrypt(encrypted, output, d, root, trip, "01990000-0000-4000-8000-000000000099") }
                assertFalse(output.exists())
                val valid = encrypted.readBytes()
                for (bad in listOf(valid.copyOf(valid.size - 1), valid.copyOf().also { it[30] = (it[30].toInt() xor 1).toByte() })) {
                    encrypted.writeBytes(bad)
                    assertThrows(Exception::class.java) { crypto.decrypt(encrypted, output, d, root, trip, asset) }
                    assertFalse(output.exists())
                }
                encrypted.writeBytes(valid); output.writeText("keep")
                assertThrows(Exception::class.java) { crypto.decrypt(encrypted, output, d, root, trip, asset) }
                assertEquals("keep", output.readText())
            } finally { root.fill(0); dir.deleteRecursively() }
        }
    }
}
