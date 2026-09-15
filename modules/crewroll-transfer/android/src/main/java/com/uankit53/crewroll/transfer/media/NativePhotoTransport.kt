package com.uankit53.crewroll.transfer.media

import com.uankit53.crewroll.transfer.identitykeys.NativeMediaContext
import java.io.File
import java.io.FileOutputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.util.concurrent.CancellationException
import org.json.JSONObject

class TransferHttpException(val status: Int, val authenticated: Boolean) : RuntimeException("photo request failed")
interface NativePhotoTransportPort {
    fun cancel()
    fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject
    fun upload(url: String, headers: Map<String, String>, source: File): String
    fun download(url: String, destination: File, expectedBytes: Long)
}

class NativePhotoTransport(private val networkAllowed: () -> Boolean) : NativePhotoTransportPort {
    @Volatile private var cancelled = false
    @Volatile private var active: HttpURLConnection? = null
    override fun cancel() { cancelled = true; active?.disconnect() }
    private fun connection(raw: String): HttpURLConnection {
        if (cancelled || !networkAllowed()) throw CancellationException()
        val uri = URI(raw)
        require(uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null && uri.fragment == null)
        return (uri.toURL().openConnection() as HttpURLConnection).also {
            it.instanceFollowRedirects = false; it.useCaches = false
            it.connectTimeout = 20_000; it.readTimeout = 30_000
            active = it
            if (cancelled) { it.disconnect(); throw CancellationException() }
        }
    }
    private fun checkResponse(connection: HttpURLConnection, authenticated: Boolean) {
        if (connection.responseCode !in 200..299) throw TransferHttpException(connection.responseCode, authenticated)
    }
    override fun json(path: String, method: String, body: JSONObject?, context: NativeMediaContext, commandId: String): JSONObject {
        val base = URI(context.session.apiBaseUrl); val uri = base.resolve(path)
        require(base.scheme == "https" && uri.scheme == base.scheme && uri.host == base.host && uri.port == base.port)
        val connection = connection(uri.toString())
        try {
            connection.requestMethod = method
            connection.setRequestProperty("Authorization", "Bearer " + String(context.session.backgroundBearer, Charsets.US_ASCII))
            connection.setRequestProperty("X-CrewRoll-Device-Id", context.session.deviceId)
            connection.setRequestProperty("Idempotency-Key", commandId)
            if (body != null) {
                val bytes = body.toString().toByteArray(); connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json"); connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            checkResponse(connection, true)
            val bytes = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val count = input.read(buffer); if (count < 0) break; require(output.size() + count <= 1_048_576); output.write(buffer, 0, count) }
                output.toByteArray()
            }
            return JSONObject(String(bytes, Charsets.UTF_8))
        } finally { connection.disconnect(); active = null }
    }
    override fun upload(url: String, headers: Map<String, String>, source: File): String {
        require(headers.keys == setOf("content-length", "content-type", "x-amz-checksum-sha256", "if-none-match"))
        require(headers["content-type"] == "application/octet-stream" && headers["if-none-match"] == "*" && headers["content-length"] == source.length().toString())
        val connection = connection(url)
        try {
            connection.requestMethod = "PUT"; connection.doOutput = true; connection.setFixedLengthStreamingMode(source.length())
            headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
            connection.outputStream.use { output -> source.inputStream().use { it.copyTo(output, 65_536) } }
            checkResponse(connection, false)
            return requireNotNull(connection.getHeaderField("ETag")).also { require(it.length in 1..256) }
        } finally { connection.disconnect(); active = null }
    }
    override fun download(url: String, destination: File, expectedBytes: Long) {
        require(expectedBytes in 45..52_428_800)
        val connection = connection(url); var created = false; var complete = false
        try {
            checkResponse(connection, false)
            check(destination.createNewFile()); created = true
            FileOutputStream(destination).use { output -> connection.inputStream.use { input ->
                val buffer = ByteArray(65_536); var total = 0L
                while (true) {
                    if (cancelled) throw CancellationException()
                    val count = input.read(buffer); if (count < 0) break
                    total += count; require(total <= expectedBytes); output.write(buffer, 0, count)
                }
                require(total == expectedBytes); output.fd.sync()
            } }
            complete = true
        } finally { connection.disconnect(); active = null; if (created && !complete) destination.delete() }
    }
}
