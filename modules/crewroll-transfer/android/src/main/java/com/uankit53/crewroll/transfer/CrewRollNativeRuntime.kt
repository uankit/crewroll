package com.uankit53.crewroll.transfer

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.goterl.lazysodium.SodiumAndroid
import com.uankit53.crewroll.transfer.identitykeys.AndroidNativeKeyInfrastructure
import com.uankit53.crewroll.transfer.identitykeys.NativeMediaSession
import com.uankit53.crewroll.transfer.media.AndroidPhotoLibrary
import com.uankit53.crewroll.transfer.media.NativePhotoCrypto
import com.uankit53.crewroll.transfer.media.NativePhotoTransferEngine
import com.uankit53.crewroll.transfer.media.NativePhotoTransport
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet

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
  val enabled get() = preferences.getBoolean("enabled", false)
  val cellular get() = preferences.getBoolean("cellular", false)
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  val engine = NativePhotoTransferEngine(File(context.noBackupFilesDir, "crewroll-transfers"), { mediaSession.read() },
    AndroidPhotoLibrary(context), NativePhotoCrypto(SodiumAndroid()), { cellular ->
      NativePhotoTransport {
        val capabilities = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
        capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
          (cellular || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))
      }
    }, { revision -> listeners.forEach { it(revision) } })

  fun listen(listener: (Long) -> Unit) { listeners.add(listener) }
  fun unlisten(listener: (Long) -> Unit) { listeners.remove(listener) }
  @Synchronized fun foreground(value: Boolean) {
    foreground = value
    engine.foreground(value)
    if (value && enabled) engine.activate()
    if (!value && enabled) CrewRollSyncJobs.schedule(context, cellular)
  }
  @Synchronized fun policy(enabled: Boolean, cellular: Boolean = this.cellular) {
    // Only scheduling flags live here. Credentials and keys stay in Keystore.
    check(preferences.edit().putBoolean("enabled", enabled).putBoolean("cellular", cellular).commit())
    if (enabled) CrewRollSyncJobs.schedule(context, cellular)
    else { jobs.clear(); CrewRollSyncJobs.cancel(context) }
  }
  @Synchronized fun beginJob(id: Int): Boolean {
    if (!enabled) return false
    val active = try { mediaSession.read() } catch (_: Exception) { null } ?: return false
    active.erase()
    val firstLease = jobs.isEmpty()
    jobs.add(id)
    if (firstLease && !foreground) {
      engine.foreground(false)
      engine.policy(false, cellular)
    } else {
      // Overlapping OS jobs share the same writer; never cancel an existing
      // foreground/other-job transfer simply to acquire another lease.
      engine.activate()
    }
    return true
  }
  @Synchronized fun endJob(id: Int) {
    jobs.remove(id)
    if (!foreground && jobs.isEmpty()) engine.stop()
  }
  companion object {
    @Volatile private var instance: CrewRollNativeRuntime? = null
    @Synchronized fun get(context: Context): CrewRollNativeRuntime = instance ?: CrewRollNativeRuntime(context.applicationContext).also { instance = it }
  }
}
