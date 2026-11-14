package com.uankit53.crewroll.transfer.media

import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.file.Files
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/** The production transport receives an injected connection, not a rewritten copy loop. */
internal class NativePhotoTestConnection(private val input: InputStream, private val status: Int = 200) : HttpURLConnection(URI("https://storage.invalid/original").toURL()) {
    var disconnected = false
    override fun connect() = Unit
    override fun disconnect() { disconnected = true; input.close() }
    override fun usingProxy() = false
    override fun getResponseCode() = status
    override fun getInputStream() = input
}

class NativePhotoTransportTest {
    @Test fun `clean EOF before advertised original length is retryable and deletes partial file`() {
        val root = Files.createTempDirectory("crewroll-transport-short-").toFile()
        val connection = NativePhotoTestConnection(ByteArrayInputStream(ByteArray(63)))
        try {
            val destination = root.resolve("original.ciphertext")
            val transport = NativePhotoTransport({ uri -> assertEquals(URI("https://storage.invalid/original"), uri); connection }, { true })
            assertThrows(IOException::class.java) { transport.download("https://storage.invalid/original", destination, 128) }
            assertFalse(destination.exists())
            assertTrue(connection.disconnected)
            assertNull(connection.getRequestProperty("Authorization"))
            assertNull(connection.getRequestProperty("X-CrewRoll-Device-Id"))
        } finally { root.deleteRecursively() }
    }

    @Test fun `body read interruption is retryable and deletes partial file`() {
        val root = Files.createTempDirectory("crewroll-transport-interrupted-").toFile()
        val input = object : InputStream() {
            private var sent = false
            override fun read(): Int = throw IOException("synthetic interrupted stream")
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                if (sent) throw IOException("synthetic interrupted stream")
                sent = true
                buffer.fill(7, offset, offset + minOf(length, 17))
                return minOf(length, 17)
            }
        }
        val connection = NativePhotoTestConnection(input)
        try {
            val destination = root.resolve("original.ciphertext")
            assertThrows(IOException::class.java) { NativePhotoTransport({ connection }, { true }).download("https://storage.invalid/original", destination, 128) }
            assertFalse(destination.exists())
            assertTrue(connection.disconnected)
        } finally { root.deleteRecursively() }
    }

    @Test fun `overlong body remains an integrity error and deletes partial file`() {
        val root = Files.createTempDirectory("crewroll-transport-overlong-").toFile()
        val connection = NativePhotoTestConnection(ByteArrayInputStream(ByteArray(129)))
        try {
            val destination = root.resolve("original.ciphertext")
            assertThrows(IllegalArgumentException::class.java) { NativePhotoTransport({ connection }, { true }).download("https://storage.invalid/original", destination, 128) }
            assertFalse(destination.exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun `complete body is preserved for authenticated crypto verification`() {
        val root = Files.createTempDirectory("crewroll-transport-complete-").toFile()
        val bytes = ByteArray(128) { it.toByte() }
        val connection = NativePhotoTestConnection(ByteArrayInputStream(bytes))
        try {
            val destination = root.resolve("original.ciphertext")
            NativePhotoTransport({ connection }, { true }).download("https://storage.invalid/original", destination, bytes.size.toLong())
            assertArrayEquals(bytes, destination.readBytes())
            assertTrue(connection.disconnected)
        } finally { root.deleteRecursively() }
    }

    @Test fun `object grant rejection is unauthenticated and creates no destination`() {
        for (status in listOf(401, 403)) {
            val root = Files.createTempDirectory("crewroll-transport-object-auth-").toFile()
            val connection = NativePhotoTestConnection(ByteArrayInputStream(ByteArray(128)), status)
            try {
                val destination = root.resolve("original.ciphertext")
                val error = assertThrows(TransferHttpException::class.java) { NativePhotoTransport({ connection }, { true }).download("https://storage.invalid/original", destination, 128) }
                assertEquals(status, error.status)
                assertFalse(error.authenticated)
                assertFalse(destination.exists())
                assertNull(connection.getRequestProperty("Authorization"))
            } finally { root.deleteRecursively() }
        }
    }
}
