package com.uankit53.crewroll.transfer.media

import com.goterl.lazysodium.Sodium
import com.goterl.lazysodium.interfaces.SecretStream
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Instant

/** Same v1 wire format as iOS; streams bounded frames, never whole originals. */
class NativePhotoCrypto(private val sodium: Sodium) {
    init { check(sodium.sodium_init() >= 0) }
    fun randomKey() = ByteArray(32).also { sodium.randombytes_buf(it, it.size) }
    fun mediaKey(root: ByteArray, variant: MediaVariant): ByteArray {
        requireWidth(root, 32, "content root")
        return ByteArray(32).also { valid(sodium.crypto_kdf_derive_from_key(it, 32, variant.code.toLong(), "CRROLL01".toByteArray(), root) == 0) }
    }
    private fun limit(variant: MediaVariant) = if (variant == MediaVariant.PREVIEW) 524_288L else 52_428_800L
    private fun valid(condition: Boolean) { if (!condition) throw CryptoReadException(CryptoFailure.AUTHENTICATION, "photo integrity verification failed") }
    private fun erase(state: SecretStream.State) { state.k.fill(0); state.nonce.fill(0); state._pad.fill(0); state.write(); state.pointer.clear(state.size().toLong()) }

    fun encrypt(source: File, destination: File, root: ByteArray, tripId: String, assetId: String,
                variant: MediaVariant, mime: String, width: UInt, height: UInt): ManifestVariantDescriptor {
        val size = source.length()
        valid(size <= limit(variant) && 24 + size + maxOf(1, (size + 262_143) / 262_144) * 21 <= limit(variant))
        val key = mediaKey(root, variant)
        val state = SecretStream.State()
        var created = false
        var complete = false
        try {
            val aad = CrewRollAad.media(tripId, assetId, variant)
            val header = ByteArray(24)
            valid(sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, key) == 0)
            check(destination.createNewFile()) { "destination exists" }; created = true
            val plainHash = MessageDigest.getInstance("SHA-256")
            val cipherHash = MessageDigest.getInstance("SHA-256")
            var written = 0L
            DataInputStream(source.inputStream().buffered()).use { input ->
                FileOutputStream(destination).use { output ->
                    fun write(bytes: ByteArray) { output.write(bytes); cipherHash.update(bytes); written += bytes.size }
                    write(header)
                    var remaining = size
                    do {
                        val message = ByteArray(minOf(262_144L, remaining).toInt())
                        try {
                            input.readFully(message); plainHash.update(message); remaining -= message.size
                            val ciphertext = ByteArray(message.size + 17); val count = LongArray(1)
                            valid(sodium.crypto_secretstream_xchacha20poly1305_push(state, ciphertext, count, message, message.size.toLong(), aad, aad.size.toLong(), (if (remaining == 0L) 3 else 0).toByte()) == 0)
                            valid(count[0] == ciphertext.size.toLong())
                            write(ByteBuffer.allocate(4).putInt(ciphertext.size).array()); write(ciphertext)
                        } finally { message.fill(0) }
                    } while (remaining > 0)
                    valid(input.read() == -1); output.fd.sync()
                }
            }
            complete = true
            return ManifestVariantDescriptor(variant, mime, width, height, size.toULong(), plainHash.digest(), written.toULong(), cipherHash.digest())
        } finally { key.fill(0); erase(state); if (created && !complete) destination.delete() }
    }

    fun decrypt(source: File, destination: File, descriptor: ManifestVariantDescriptor, root: ByteArray, tripId: String, assetId: String) {
        valid(descriptor.ciphertextBytes <= limit(descriptor.variant).toULong() && source.length().toULong() == descriptor.ciphertextBytes)
        val key = mediaKey(root, descriptor.variant); val state = SecretStream.State()
        var created = false; var complete = false
        try {
            val aad = CrewRollAad.media(tripId, assetId, descriptor.variant)
            val cipherHash = MessageDigest.getInstance("SHA-256"); val plainHash = MessageDigest.getInstance("SHA-256")
            DataInputStream(source.inputStream().buffered()).use { input ->
                var consumed = 0L
                fun read(count: Int): ByteArray = ByteArray(count).also { input.readFully(it); consumed += count; cipherHash.update(it) }
                valid(sodium.crypto_secretstream_xchacha20poly1305_init_pull(state, read(24), key) == 0)
                check(destination.createNewFile()) { "destination exists" }; created = true
                var plainBytes = 0L; var final = false
                FileOutputStream(destination).use { output ->
                    while (consumed < source.length()) {
                        val length = ByteBuffer.wrap(read(4)).int
                        valid(length in 17..262_161 && consumed + length <= source.length())
                        val ciphertext = read(length); val last = consumed == source.length()
                        valid(if (last) length > 17 || consumed == 45L else length == 262_161)
                        val message = ByteArray(length - 17); val count = LongArray(1); val tag = ByteArray(1)
                        try {
                            valid(sodium.crypto_secretstream_xchacha20poly1305_pull(state, message, count, tag, ciphertext, length.toLong(), aad, aad.size.toLong()) == 0)
                            valid(count[0] == message.size.toLong() && tag[0].toInt() == if (last) 3 else 0)
                            output.write(message); plainHash.update(message); plainBytes += message.size; final = last
                        } finally { message.fill(0) }
                    }
                    valid(final && input.read() == -1 && plainBytes.toULong() == descriptor.plaintextBytes && bytesEqual(cipherHash.digest(), descriptor.ciphertextSha256) && bytesEqual(plainHash.digest(), descriptor.plaintextSha256))
                    output.fd.sync()
                }
            }
            complete = true
        } finally { key.fill(0); erase(state); if (created && !complete) destination.delete() }
    }

    fun sealManifest(root: ByteArray, captured: Instant, preview: ManifestVariantDescriptor, original: ManifestVariantDescriptor, tripKey: ByteArray, tripId: String, assetId: String): ByteArray {
        requireWidth(root, 32, "content root")
        val buffer = ByteBuffer.allocate(744)
        var plain: ByteArray? = null
        val key = ManifestReader.deriveManifestKey(sodium, tripKey)
        try {
            buffer.put("CRMANP1\u0000".toByteArray()).putInt(1).put(root).put(1).putLong(captured.toEpochMilli()).putShort(0)
            for (d in listOf(preview, original)) {
                val mime = d.mime.toByteArray(Charsets.US_ASCII); valid(mime.size <= 127)
                buffer.put(d.variant.code.toByte()).put(mime.size.toByte()).put(mime).putInt(d.pixelWidth.toInt()).putInt(d.pixelHeight.toInt())
                    .putLong(d.plaintextBytes.toLong()).put(d.plaintextSha256).putLong(d.ciphertextBytes.toLong()).put(d.ciphertextSha256)
            }
            val plaintext = buffer.array().copyOf(buffer.position()); plain = plaintext
            val parsed = ManifestReader.parse(plaintext.copyOf()); parsed.erase()
            val aad = CrewRollAad.manifest(tripId, assetId)
            val nonce = ByteArray(24).also { sodium.randombytes_buf(it, it.size) }
            val ciphertext = ByteArray(plaintext.size + 16); val count = LongArray(1)
            valid(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, count, plaintext, plaintext.size.toLong(), aad, aad.size.toLong(), null, nonce, key) == 0)
            valid(count[0] == ciphertext.size.toLong())
            return nonce + ciphertext
        } finally { key.fill(0); plain?.fill(0); buffer.array().fill(0) }
    }
    fun openManifest(bytes: ByteArray, tripKey: ByteArray, tripId: String, assetId: String) = ManifestReader.open(sodium, bytes, tripKey, CrewRollAad.manifest(tripId, assetId))
}
