package com.uankit53.crewroll.transfer.media

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
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
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.time.Instant

/** API 29+ scoped storage: pending rows are journalled before publishing. */
class AndroidPhotoLibrary(private val context: Context) : NativePhotoLibraryPort {
    private val resolver = context.contentResolver
    private val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    private var observer: ContentObserver? = null
    private val systemCameras: Set<String> by lazy {
        @Suppress("DEPRECATION")
        val cameras = listOf(MediaStore.ACTION_IMAGE_CAPTURE, MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)
            .flatMap { context.packageManager.queryIntentActivities(Intent(it), PackageManager.MATCH_DEFAULT_ONLY) }
        cameras.filter {
            it.activityInfo.applicationInfo.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
        }.map { it.activityInfo.packageName }.filter { it != context.packageName }.toSet()
    }
    private fun permission() {
        val read = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
        val access = nativePhotoAccess(Build.VERSION.SDK_INT,
            fullRead = context.checkSelfPermission(read) == PackageManager.PERMISSION_GRANTED,
            selectedRead = Build.VERSION.SDK_INT >= 34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED,
            originalMetadata = context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED)
        if (access != NativePhotoAccess.FULL) throw PhotoLibraryException("PHOTO_PERMISSION")
    }
    override fun observe(changed: (() -> Unit)?) {
        val previous = observer; observer = null
        previous?.let(resolver::unregisterContentObserver)
        if (changed == null) return
        val next = object : ContentObserver(Handler(Looper.getMainLooper())) { override fun onChange(selfChange: Boolean) { changed() } }
        resolver.registerContentObserver(collection, true, next)
        observer = next
    }
    override fun discover(startsAt: Instant, endsAt: Instant, excluding: Set<String>, limit: Int): List<DiscoveredPhoto> {
        permission()
        val selection = "${MediaStore.Images.Media.DATE_TAKEN} >= ? AND ${MediaStore.Images.Media.DATE_TAKEN} <= ? AND ${MediaStore.Images.Media.RELATIVE_PATH} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 0"
        val result = mutableListOf<DiscoveredPhoto>()
        for (path in listOf("DCIM/Camera/", "Pictures/")) {
            if (path == "Pictures/" && systemCameras.isEmpty()) continue
            // Query owner only for the fallback folder. On Android 14+ owner
            // visibility must not hide legacy DCIM captures with unknown owners.
            val columns = mutableListOf(MediaStore.Images.Media._ID, MediaStore.Images.Media.DATE_TAKEN)
            if (path == "Pictures/") columns.add(MediaStore.Images.Media.OWNER_PACKAGE_NAME)
            resolver.query(collection, columns.toTypedArray(), selection, arrayOf(startsAt.toEpochMilli().toString(), endsAt.toEpochMilli().toString(), path), "${MediaStore.Images.Media.DATE_TAKEN} ASC, ${MediaStore.Images.Media._ID} ASC")?.use { cursor ->
                var accepted = 0
                while (cursor.moveToNext() && accepted < limit) {
                    val owner = if (path == "Pictures/") cursor.getString(2) else null
                    if (!isCameraSource(path, owner, systemCameras)) continue
                    val uri = ContentUris.withAppendedId(collection, cursor.getLong(0)).toString()
                    if (uri !in excluding) {
                        result.add(DiscoveredPhoto(uri, Instant.ofEpochMilli(cursor.getLong(1))))
                        accepted++
                    }
                }
            } ?: throw PhotoLibraryException("PHOTO_PERMISSION")
        }
        return result.sortedWith(compareBy<DiscoveredPhoto> { it.capturedAt }.thenBy { it.localId }).take(limit)
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
        // The capture ID remains stable if the user moves the image or app
        // ownership is reset by reinstall. The engine authenticates its bytes
        // before reuse; this read never moves or changes a matched photo.
        resolver.query(collection, arrayOf(MediaStore.Images.Media._ID), "${MediaStore.Images.Media.DISPLAY_NAME} LIKE ? AND ${MediaStore.Images.Media.IS_PENDING} = 0", arrayOf("crewroll-$assetId.%"), null)?.use { cursor ->
            if (cursor.moveToFirst()) return ContentUris.withAppendedId(collection, cursor.getLong(0)).toString()
        }
        return null
    }
    override fun isPublished(localId: String): Boolean {
        permission()
        resolver.query(Uri.parse(localId), arrayOf(MediaStore.Images.Media.IS_PENDING, MediaStore.Images.Media.OWNER_PACKAGE_NAME), null, null, null)?.use {
            if (it.moveToFirst()) {
                if (it.getInt(0) == 0) return true
                if (it.getString(1) == context.packageName) return false
                throw PhotoLibraryException("PHOTO_PERMISSION")
            }
        }
        throw PhotoLibraryException("SOURCE_MISSING")
    }
    override fun save(source: File, assetId: String, capturedAt: Instant?, mime: String, relativePath: String, allocated: (String) -> Unit): String {
        permission()
        require(NativeTripAlbumPaths.isDestination(relativePath))
        findSaved(assetId)?.let { allocated(it); return it }
        require(assetId.matches(Regex("[0-9a-f-]{36}")))
        val extension = when (mime) { "image/jpeg" -> "jpg"; "image/heic" -> "heic"; "image/heif" -> "heif"; "image/png" -> "png"; "image/webp" -> "webp"; else -> throw PhotoLibraryException("INTEGRITY_FAILURE") }
        val name = "crewroll-$assetId.$extension"
        // Recover the precise app-owned pending row after a process death before
        // journal publication. Never touch another application's photos.
        var pending: Uri? = null
        resolver.query(collection, arrayOf(MediaStore.Images.Media._ID), "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.RELATIVE_PATH} LIKE ? AND ${MediaStore.Images.Media.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 1", arrayOf(name, "${NativeTripAlbumPaths.LEGACY}%", context.packageName), null)?.use { if (it.moveToFirst()) pending = ContentUris.withAppendedId(collection, it.getLong(0)) }
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name); put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, relativePath); put(MediaStore.Images.Media.IS_PENDING, 1)
            if (capturedAt != null) put(MediaStore.Images.Media.DATE_TAKEN, capturedAt.toEpochMilli())
        }
        val uri = pending ?: try {
            resolver.insert(collection, values) ?: throw PhotoLibraryException("STORAGE_FULL")
        } catch (error: Exception) {
            if (relativePath == NativeTripAlbumPaths.LEGACY || error is SecurityException) throw error
            // A folder/provider failure must not withhold an otherwise writable
            // original. Check for an uncertain committed pending row before a
            // fallback insert; organization repairs the same URI separately.
            var recovered: Uri? = null
            resolver.query(collection, arrayOf(MediaStore.Images.Media._ID), "${MediaStore.Images.Media.DISPLAY_NAME} = ? AND ${MediaStore.Images.Media.RELATIVE_PATH} LIKE ? AND ${MediaStore.Images.Media.OWNER_PACKAGE_NAME} = ? AND ${MediaStore.Images.Media.IS_PENDING} = 1", arrayOf(name, "${NativeTripAlbumPaths.LEGACY}%", context.packageName), null)?.use {
                if (it.moveToFirst()) recovered = ContentUris.withAppendedId(collection, it.getLong(0))
            }
            recovered ?: resolver.insert(collection, ContentValues(values).apply { put(MediaStore.Images.Media.RELATIVE_PATH, NativeTripAlbumPaths.LEGACY) }) ?: throw error
        }
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
        try { resolver.openInputStream(MediaStore.setRequireOriginal(Uri.parse(localId)))?.use { input ->
            val buffer = ByteArray(65_536)
            try { while (true) { val n = input.read(buffer); if (n < 0) break; count += n; if (count > bytes) throw PhotoLibraryException("INTEGRITY_FAILURE"); digest.update(buffer, 0, n) } }
            finally { buffer.fill(0) }
        } ?: throw PhotoLibraryException("SOURCE_MISSING") }
        catch (_: FileNotFoundException) { throw PhotoLibraryException("SOURCE_MISSING") }
        if (count != bytes || !MessageDigest.isEqual(digest.digest(), checksum)) throw PhotoLibraryException("INTEGRITY_FAILURE")
    }
    override fun inspectOrganization(localId: String, relativePath: String): NativePhotoOrganizationAction {
        permission()
        require(NativeTripAlbumPaths.isDestination(relativePath) && relativePath != NativeTripAlbumPaths.LEGACY)
        val uri = Uri.parse(localId)
        var actualPath: String? = null
        var owner: String? = null
        resolver.query(uri, arrayOf(MediaStore.Images.Media.RELATIVE_PATH, MediaStore.Images.Media.OWNER_PACKAGE_NAME), null, null, null)?.use {
            if (it.moveToFirst()) { actualPath = it.getString(0); owner = it.getString(1) }
        }
        val existing = actualPath ?: throw PhotoLibraryException("SOURCE_MISSING")
        return photoOrganizationAction(existing, relativePath, owner, context.packageName)
    }
    override fun organizeSaved(localId: String, relativePath: String): PhotoOrganizationResult {
        when (inspectOrganization(localId, relativePath)) {
            NativePhotoOrganizationAction.ALREADY_ORGANIZED -> return PhotoOrganizationResult.ORGANIZED
            NativePhotoOrganizationAction.USER_MANAGED -> return PhotoOrganizationResult.USER_MANAGED
            NativePhotoOrganizationAction.OWNERSHIP_UNAVAILABLE -> throw SecurityException("Photo organization requires app ownership")
            NativePhotoOrganizationAction.MOVE -> Unit
        }
        check(resolver.update(Uri.parse(localId), ContentValues().apply { put(MediaStore.Images.Media.RELATIVE_PATH, relativePath) }, null, null) == 1)
        return PhotoOrganizationResult.ORGANIZED
    }
}
