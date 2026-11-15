package com.uankit53.crewroll.transfer

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.goterl.lazysodium.SodiumAndroid
import com.uankit53.crewroll.transfer.identitykeys.AndroidNativeKeyInfrastructure
import com.uankit53.crewroll.transfer.identitykeys.NativeMediaSession
import com.uankit53.crewroll.transfer.identitykeys.NativeDeferredMaintenance
import com.uankit53.crewroll.transfer.identitykeys.NativeTransferCommandFence
import com.uankit53.crewroll.transfer.media.AndroidPhotoLibrary
import com.uankit53.crewroll.transfer.media.NativePhotoCrypto
import com.uankit53.crewroll.transfer.media.NativePhotoTransferEngine
import com.uankit53.crewroll.transfer.media.NativePhotoTransport
import com.uankit53.crewroll.transfer.media.NativePushHint
import com.uankit53.crewroll.transfer.media.NativePushWakeGate
import com.uankit53.crewroll.transfer.media.NativePhotoAccess
import com.uankit53.crewroll.transfer.media.nativePhotoAccess
import com.uankit53.crewroll.transfer.media.NativeTripAlbumRegistry
import com.uankit53.crewroll.transfer.identitykeys.NativeKeyScope
import com.uankit53.crewroll.transfer.identitykeys.ActiveTripMetadata
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/** One journal writer per process, shared by Expo and OS jobs. No JS runtime is
 * needed to reopen the protected native session after the OS kills the process. */
internal class CrewRollNativeRuntime private constructor(val context: Context) {
  val lifecycle = AndroidNativeKeyInfrastructure.makeLifecycle(context)
  val mediaSession = NativeMediaSession({ lifecycle.mediaContext() })
  private val listeners = CopyOnWriteArraySet<(Long) -> Unit>()
  private val preferences = context.getSharedPreferences("crewroll-background-policy", Context.MODE_PRIVATE)
  @Volatile var foreground = false
    private set
  private val jobs = mutableSetOf<Int>()
  private val pushGate = NativePushWakeGate()
  private val policyRevision = AtomicLong()
  private val leaseRevision = AtomicLong()
  val enabled get() = preferences.getBoolean("enabled", false)
  val cellular get() = preferences.getBoolean("cellular", true)
  init {
    // Upgrade the old Wi-Fi-only preference without touching the enabled flag,
    // account credentials, trip keys, or durable transfer journal.
    if (preferences.getInt("network-policy-version", 0) < 1) {
      check(preferences.edit().putBoolean("cellular", true).putInt("network-policy-version", 1).commit())
    }
  }
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val albums = NativeTripAlbumRegistry(File(context.noBackupFilesDir, "crewroll-transfers"))
  private val engineDelegate = lazy { NativePhotoTransferEngine(File(context.noBackupFilesDir, "crewroll-transfers"), { mediaSession.read() },
    AndroidPhotoLibrary(context), NativePhotoCrypto(SodiumAndroid()), { cellular ->
      NativePhotoTransport {
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
          (cellular || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
      }
    }, { revision -> listeners.forEach { it(revision) } },
    expiredTrips = { lifecycle.expiredTrips() },
    purgeTripKey = { trip, cleanup -> mediaSession.change { lifecycle.purgeExpiredTrip(trip, cleanup) } },
    nextRetentionDeadline = { lifecycle.nextTripRetentionDeadline() }, albums = albums) }
  val engine get() = engineDelegate.value
  fun registerTripAlbum(scope: NativeKeyScope, metadata: ActiveTripMetadata, tripName: String) {
    albums.register(scope, metadata, tripName)
  }
  private val maintenanceExecutor = Executors.newSingleThreadExecutor { task ->
    Thread(task, "CrewRollRetention").apply { isDaemon = true }
  }
  private val retentionMaintenance = NativeDeferredMaintenance({ task -> maintenanceExecutor.execute(task) }) {
    lifecycle.runScheduledCleanup()
    engine.reconcileRetention()
  }

  /** Called after an interactive acknowledgement, never joined by that command.
   * Paused retention needs no current trip, observer, network or JavaScript. */
  fun requestRetentionMaintenance() = retentionMaintenance.request()

  fun applyTransferPolicy(paused: Boolean, cellular: Boolean, ifCurrent: () -> Boolean): CompletableFuture<Unit> {
    policy(!paused, cellular)
    if (paused && !engineDelegate.isInitialized()) return CompletableFuture.completedFuture(Unit)
    return engine.policy(paused, cellular, ifCurrent)
  }

  fun listen(listener: (Long) -> Unit) { listeners.add(listener) }
  fun unlisten(listener: (Long) -> Unit) { listeners.remove(listener) }
  fun foreground(value: Boolean) {
    val epoch = synchronized(this) { foreground = value; leaseRevision.incrementAndGet(); policyRevision.get() }
    val selection = transferCommands.current()
    if (engineDelegate.isInitialized()) engine.foreground(value)
    if (value && enabled && mediaSession.hasPreparedContext()) engine.activate { foreground && enabled && policyRevision.get() == epoch && transferCommands.matches(selection) }
    synchronized(this) { if (!foreground && enabled) CrewRollSyncJobs.schedule(context, cellular) }
  }
  @Synchronized fun policy(enabled: Boolean, cellular: Boolean = this.cellular) {
    policyRevision.incrementAndGet()
    leaseRevision.incrementAndGet()
    // Only scheduling flags live here. Credentials and keys stay in Keystore.
    check(preferences.edit().putBoolean("enabled", enabled).putBoolean("cellular", cellular).commit())
    if (enabled) CrewRollSyncJobs.schedule(context, cellular)
    else { jobs.clear(); CrewRollSyncJobs.cancel(context) }
  }
  fun beginJob(id: Int, hints: List<NativePushHint>? = null): Boolean {
    val epoch = synchronized(this) { if (!enabled) return false; policyRevision.get() }
    val selection = transferCommands.current()
    // Explicit OS jobs restore independently of JS. Maintenance is dispatched
    // separately and selected expiry is checked by mediaContext itself.
    requestRetentionMaintenance()
    engine.reconcileRetention()
    if (hints != null) {
      if (!pushGate.accept(hints, enabled, photosAllowed()) {
        val active = try { mediaSession.read() } catch (_: Exception) { null }
        active?.let { try { Pair(it.session.deviceId, it.metadata.tripId) } finally { it.erase() } }
      }) return false
    }
    val active = try { mediaSession.read() } catch (_: Exception) { null } ?: return false
    active.erase()
    synchronized(this) {
      if (!enabled || policyRevision.get() != epoch) return false
      jobs.add(id)
      leaseRevision.incrementAndGet()
    }
    // An OS lease joins existing work without cancelling another transfer.
    val current = {
      enabled && policyRevision.get() == epoch && transferCommands.matches(selection) && (hints == null || (photosAllowed() && matches(hints)))
    }
    engine.activate(current).thenRun { if (current()) engine.requestReconcile() }
    return true
  }
  private fun photosAllowed(): Boolean {
    val read = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE
    return nativePhotoAccess(Build.VERSION.SDK_INT,
      context.checkSelfPermission(read) == PackageManager.PERMISSION_GRANTED,
      Build.VERSION.SDK_INT >= 34 && context.checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED,
      context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED) == NativePhotoAccess.FULL
  }
  private fun matches(hints: List<NativePushHint>): Boolean {
    val active = try { mediaSession.read() } catch (_: Exception) { null } ?: return false
    return try { hints.any { it.deviceId == active.session.deviceId && it.tripId == active.metadata.tripId } }
    finally { active.erase() }
  }
  fun endJob(id: Int) {
    val (stop, epoch) = synchronized(this) { jobs.remove(id); Pair(!foreground && jobs.isEmpty(), leaseRevision.incrementAndGet()) }
    if (stop) engine.stop { !foreground && leaseRevision.get() == epoch }
  }
  companion object {
    val transferCommands = NativeTransferCommandFence()
    @Volatile private var instance: CrewRollNativeRuntime? = null
    @Synchronized fun get(context: Context): CrewRollNativeRuntime = instance ?: CrewRollNativeRuntime(context.applicationContext).also { instance = it }
  }
}
