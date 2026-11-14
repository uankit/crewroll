package com.uankit53.crewroll.transfer.media

/** An untrusted wake hint is never authority to activate a trip or grant Photos. */
data class NativePushHint(val deviceId: String, val tripId: String, val eventId: String) {
    fun data(): Map<String, String> = mapOf("type" to TYPE, "deviceId" to deviceId, "tripId" to tripId, "eventId" to eventId)
    companion object {
        const val TYPE = "crewroll.sync.v1"
        private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        fun parse(data: Map<String, *>): NativePushHint? {
            if (data.keys != setOf("type", "deviceId", "tripId", "eventId") || data["type"] != TYPE) return null
            val device = data["deviceId"] as? String ?: return null
            val trip = data["tripId"] as? String ?: return null
            val event = data["eventId"] as? String ?: return null
            if (!uuid.matches(device) || !uuid.matches(trip) || trip[14] != '7' || !uuid.matches(event)) return null
            return NativePushHint(device, trip, event)
        }
    }
}

/** Bounded process-local duplicate suppression. Durable transfer IDs remain
 * authoritative across OS restarts and retries. Context is lazy so a disabled
 * policy cannot touch account credentials or start media work. */
class NativePushWakeGate {
    private val seen = linkedSetOf<String>()
    @Synchronized fun accept(hints: List<NativePushHint>, enabled: Boolean, photosAllowed: Boolean,
        context: () -> Pair<String, String>?): Boolean {
        if (!enabled || !photosAllowed) return false
        val active = context() ?: return false
        val hint = hints.firstOrNull { it.deviceId == active.first && it.tripId == active.second && "${it.deviceId}:${it.tripId}:${it.eventId}" !in seen } ?: return false
        seen.add("${hint.deviceId}:${hint.tripId}:${hint.eventId}")
        while (seen.size > 128) seen.remove(seen.first())
        return true
    }
}
