package com.uankit53.crewroll.transfer.media

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.time.Instant

/** API 29+ scoped storage: pending rows are journalled before publishing. */
class AndroidPhotoLibrary(private val context: Context) : NativePhotoLibraryPort {
    private val resolver = context.contentResolver
    private val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    private var observer: ContentObserver? = null
    private val savedPath = "Pictures/CrewRoll/"
    private fun permission() {
        if (Build.VERSION.SDK_INT < 29) throw PhotoLibraryException("PHOTO_PERMISSION")
        val read = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        if (context.checkSelfPermission(read) != PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) != PackageManager.PERMISSION_GRANTED) throw PhotoLibraryException("PHOTO_PERMISSION")
    }
    override fun observe(changed: (() -> Unit)?) {
        observer?.let(resolver::unregisterContentObserver); observer = null
        if (changed == null) return
        observer = object : ContentObserver(Handler(Looper.getMainLooper())) { override fun onChange(selfChange: Boolean) { changed() } }
        resolver.registerContentObserver(collection, true, observer!!)
    }
    override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int): List<DiscoveredPhoto> {
        permission()
        val columns = arrayOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN)
        val selection = "${MediaStore.Images.Media.DATE_TAKEN} >= ? AND ${MediaStore.Images.Media.DATE_TAKEN} <= ? AND ${MediaStore.Images.Media.RELATIVE_PATH} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 0"
        val result = mutableListOf<DiscoveredPhoto>()
        resolver.query(collection, columns, selection, arrayOf(startsAt.toEpochMilli().toString(), endsAt.toEpochMilli().toString(), "DCIM/Camera/"), "${MediaStore.Images.Media.DATE_TAKEN} ASC, ${MediaStore.Images.Media._ID} ASC")?.use { cursor ->
            while (cursor.moveToNext() && result.size < limit) {
                val uri = ContentUris.withAppendedId(collection, cursor.getLong(0)).toString()
                if (uri !in excluding) result.add(DiscoveredPhoto(uri, Instant.ofEpochMilli(cursor.getLong(1))))
            }
        } ?: throw PhotoLibraryException("PHOTO_PERMISSION")
        return result
    }
    override fun exportOriginal(localId: String, destination: File): PhotoMetadata {
        permission()
        val uri = MediaStore.setRequireOriginal(Uri.parse(localId))
        val mime = resolver.getType(uri) ?: throw PhotoLibraryException("SOURCE_MISSING")
        if (mime !in setOf("image/jpeg", "image/heic", "image/heif", "image/png", "image/webp")) throw PhotoLibraryException("INTEGRITY_FAILURE")
        check(destination.createNewFile())
        var complete = false
        try {
            resolver.openInputStream(uri)?.use { input -> FileOutputStream(destination).use { output ->
                val buffer = ByteArray(65_536); var size = 0L
                try { while (true) { val n = input.read(buffer); if (n < 0) break; size += n; if (size > 52_428_800) throw PhotoLibraryException("INTEGRITY_FAILURE"); output.write(buffer, 0, n) } }
                finally { buffer.fill(0) }
                output.fd.sync()
            } } ?: throw PhotoLibraryException("SOURCE_MISSING")
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(destination.path, options)
            if (options.outWidth <= 0 || options.outHeight <= 0) throw PhotoLibraryException("INTEGRITY_FAILURE")
            complete = true; return PhotoMetadata(mime, options.outWidth.toUInt(), options.outHeight.toUInt())
        } finally { if (!complete) destination.delete() }
    }
    override fun preview(source: File, destination: File): PhotoMetadata {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(source.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1024) sample *= 2
        val bitmap = BitmapFactory.decodeFile(source.path, BitmapFactory.Options().apply { inSampleSize = sample }) ?: throw PhotoLibraryException("INTEGRITY_FAILURE")
        val ratio = minOf(1.0, 512.0 / maxOf(bitmap.width, bitmap.height))
        val scaled = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * ratio).toInt()), maxOf(1, (bitmap.height * ratio).toInt()), true)
        val orientation = ExifInterface(source.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
                ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
                ExifInterface.ORIENTATION_FLIP_VERTICAL -> setScale(1f, -1f)
                ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
                ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
                ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
            }
        }
        val upright = Bitmap.createBitmap(scaled, 0, 0, scaled.width, scaled.height, matrix, true)
        try {
            check(destination.createNewFile())
            FileOutputStream(destination).use { check(upright.compress(Bitmap.CompressFormat.JPEG, 72, it)); it.fd.sync() }
            return PhotoMetadata("image/jpeg", upright.width.toUInt(), upright.height.toUInt())
        } finally { if (upright !== scaled) upright.recycle(); if (scaled !== bitmap) scaled.recycle(); bitmap.recycle() }
    }
    override fun findSaved(assetId: String): String? {
        permission()
        require(assetId.matches(Regex("[0-9a-f-]{36}")))
        resolver.query(collection, arrayOf(MediaStore.Images.Media._ID), "${MediaStore.Images.Media.DISPLAY_NAME} LIKE ? AND ${MediaStore.Images.Media.RELATIVE_PATH} = ? AND ${MediaStore.Images.Media.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 0", arrayOf("crewroll-$assetId.%", savedPath, context.packageName), null)?.use { cursor ->
            if (cursor.moveToFirst()) return ContentUris.withAppendedId(collection, cursor.getLong(0)).toString()
        }
        return null
    }
    override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, allocated: (String) -> Unit): String {
        permission()
        findSaved(assetId)?.let { allocated(it); return it }
        require(assetId.matches(Regex("[0-9a-f-]{36}")))
        val extension = when (mime) { "image/jpeg" -> "jpg"; "image/heic" -> "heic"; "image/heif" -> "heif"; "image/png" -> "png"; "image/webp" -> "webp"; else -> throw PhotoLibraryException("INTEGRITY_FAILURE") }
        val name = "crewroll-$assetId.$extension"
        // Recover the precise app-owned pending row after a process death before
        // journal publication. Never touch another application's photos.
        var pending: Uri? = null
        resolver.query(collection, arrayOf(MediaStore.Images.Media._ID), "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.RELATIVE_PATH} = ? AND ${MediaStore.Images.Media.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 1", arrayOf(name, savedPath, context.packageName), null)?.use { if (it.moveToFirst()) pending = ContentUris.withAppendedId(collection, it.getLong(0)) }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name); put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, savedPath); put(MediaStore.Images.Media.IS_PENDING, 1)
            if (capturedAt != null) put(MediaStore.Images.Media.DATE_TAKEN, capturedAt.toEpochMilli())
        }
        val uri = pending ?: resolver.insert(collection, values) ?: throw PhotoLibraryException("STORAGE_FULL")
        allocated(uri.toString())
        resolver.openOutputStream(uri, "wt")?.use { output -> source.inputStream().use { it.copyTo(output, 65_536) } } ?: throw PhotoLibraryException("STORAGE_FULL")
        // Verify pending bytes before publishing, then the engine verifies again
        // before acknowledging to the server.
        val hash = source.inputStream().use { input -> val digest = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(65_536); try { while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }; digest.digest() } finally { buffer.fill(0) } }
        verify(uri.toString(), source.length(), hash)
        check(resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null) == 1)
        return uri.toString()
    }
    override fun verify(localId: String, bytes: Long, checksum: ByteArray) {
        permission()
        val digest = MessageDigest.getInstance("SHA-256"); var count = 0L
        resolver.openInputStream(MediaStore.setRequireOriginal(Uri.parse(localId)))?.use { input ->
            val buffer = ByteArray(65_536)
            try { while (true) { val n = input.read(buffer); if (n < 0) break; count += n; if (count > bytes) throw PhotoLibraryException("INTEGRITY_FAILURE"); digest.update(buffer, 0, n) } }
            finally { buffer.fill(0) }
        } ?: throw PhotoLibraryException("SOURCE_MISSING")
        if (count != bytes || !MessageDigest.isEqual(digest.digest(), checksum)) throw PhotoLibraryException("INTEGRITY_FAILURE")
    }
}
