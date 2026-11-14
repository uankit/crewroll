package com.uankit53.crewroll.transfer

import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import com.uankit53.crewroll.transfer.media.NativePushHint
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import java.util.concurrent.CopyOnWriteArraySet

/** Keep Expo's token rotation bridge, but consume our data-only hint natively:
 * no JS bundle, notification tray item, foreground service or alert permission. */
class CrewRollPushService : ExpoFirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val hint = NativePushHint.parse(remoteMessage.data)
        if (hint == null) {
            if (remoteMessage.data["type"]?.startsWith("crewroll.") != true) super.onMessageReceived(remoteMessage)
            return
        }
        CrewRollPushEvents.received(hint)
        val prefs = getSharedPreferences("crewroll-background-policy", Context.MODE_PRIVATE)
        if (prefs.getBoolean("enabled", false))
            CrewRollSyncJobs.push(applicationContext, prefs.getBoolean("cellular", true), hint)
    }
}

internal object CrewRollPushEvents {
    private val listeners = CopyOnWriteArraySet<(NativePushHint) -> Unit>()
    fun listen(listener: (NativePushHint) -> Unit) { listeners.add(listener) }
    fun unlisten(listener: (NativePushHint) -> Unit) { listeners.remove(listener) }
    fun received(hint: NativePushHint) { listeners.forEach { it(hint) } }
}
