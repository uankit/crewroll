package com.uankit53.crewroll.transfer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import java.util.concurrent.TimeUnit

internal object CrewRollSyncJobs {
  const val PERIODIC = 73101
  const val PHOTOS = 73102
  const val USER = 73103
  private fun builder(context: Context, id: Int, cellular: Boolean) = JobInfo.Builder(id, ComponentName(context, CrewRollSyncJobService::class.java))
    .setRequiredNetworkType(if (cellular) JobInfo.NETWORK_TYPE_ANY else JobInfo.NETWORK_TYPE_UNMETERED)
  fun schedule(context: Context, cellular: Boolean) {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    // Do not reset a pending periodic job every time a projection refreshes.
    val existing = scheduler.getPendingJob(PERIODIC)
    if (existing == null || existing.networkType != (if (cellular) JobInfo.NETWORK_TYPE_ANY else JobInfo.NETWORK_TYPE_UNMETERED)) {
      scheduler.schedule(builder(context, PERIODIC, cellular).setPersisted(true).setRequiresStorageNotLow(true)
        .setPeriodic(TimeUnit.MINUTES.toMillis(15)).build())
    }
    armPhotos(context, cellular)
  }
  fun armPhotos(context: Context, cellular: Boolean) {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    val existing = scheduler.getPendingJob(PHOTOS)
    if (existing == null || existing.networkType != (if (cellular) JobInfo.NETWORK_TYPE_ANY else JobInfo.NETWORK_TYPE_UNMETERED)) scheduler.schedule(builder(context, PHOTOS, cellular)
      .addTriggerContentUri(JobInfo.TriggerContentUri(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS))
      .setTriggerContentUpdateDelay(1_000).setTriggerContentMaxDelay(5_000).build())
  }
  fun syncNow(context: Context, cellular: Boolean) {
    val request = builder(context, USER, cellular)
    if (Build.VERSION.SDK_INT >= 34) request.setUserInitiated(true)
    // UIDT must be scheduled while visible; the caller also wakes the foreground
    // engine, so an OS quota rejection never loses the durable queue.
    try { context.getSystemService(JobScheduler::class.java).schedule(request.build()) } catch (_: IllegalStateException) { }
  }
  fun cancel(context: Context) { val scheduler = context.getSystemService(JobScheduler::class.java); listOf(PERIODIC, PHOTOS, USER).forEach(scheduler::cancel) }
}

class CrewRollSyncJobService : JobService() {
  private val handler = Handler(Looper.getMainLooper())
  private val deadlines = mutableMapOf<Int, Runnable>()
  override fun onStartJob(params: JobParameters): Boolean {
    val runtime = CrewRollNativeRuntime.get(applicationContext)
    if (!runtime.beginJob(params.jobId)) return false
    if (params.jobId == CrewRollSyncJobs.PERIODIC) CrewRollSyncJobs.armPhotos(applicationContext, runtime.cellular)
    if (Build.VERSION.SDK_INT >= 34 && params.jobId == CrewRollSyncJobs.USER) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel("crewroll-sync", "Photo sync", NotificationManager.IMPORTANCE_LOW))
      val launch = packageManager.getLaunchIntentForPackage(packageName)
      val notification = Notification.Builder(this, "crewroll-sync").setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentTitle("Syncing your trip").setContentText("CrewRoll is saving your crew’s photos.")
        .setOngoing(true).setOnlyAlertOnce(true)
      if (launch != null) notification.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      setNotification(params, 73103, notification.build(), JOB_END_NOTIFICATION_POLICY_REMOVE)
    }
    // A bounded lease; journals survive expiration and all network operations are
    // cancelled by engine.stop before another session can use the worker.
    val deadline = Runnable {
      deadlines.remove(params.jobId)
      runtime.endJob(params.jobId)
      jobFinished(params, false)
      if (runtime.enabled && params.jobId == CrewRollSyncJobs.PHOTOS) {
        // A one-shot content job must be submitted again after completion.
        getSystemService(JobScheduler::class.java).cancel(CrewRollSyncJobs.PHOTOS)
        CrewRollSyncJobs.armPhotos(applicationContext, runtime.cellular)
      }
    }
    deadlines[params.jobId] = deadline
    handler.postDelayed(deadline, TimeUnit.MINUTES.toMillis(if (params.jobId == CrewRollSyncJobs.USER) 5 else 2))
    return true
  }
  override fun onStopJob(params: JobParameters): Boolean {
    deadlines.remove(params.jobId)?.let(handler::removeCallbacks)
    val runtime = CrewRollNativeRuntime.get(applicationContext)
    runtime.endJob(params.jobId)
    return runtime.enabled
  }
}
