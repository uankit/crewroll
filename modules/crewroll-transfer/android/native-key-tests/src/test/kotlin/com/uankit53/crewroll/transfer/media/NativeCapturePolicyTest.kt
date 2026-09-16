package com.uankit53.crewroll.transfer.media

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativeCapturePolicyTest {
    private fun time(second: Long) = Instant.ofEpochSecond(1_900_000_000 + second)
    private fun policy(participation: String = "JOINED", open: Boolean = false): NativeCapturePolicy = NativeCapturePolicy(
        JSONObject().put("tripId", "trip").put("version", 3).put("participation", participation)
            .put("captureUntil", time(80).toString()).put("excludedCaptureWindows", JSONArray().put(
                JSONObject().put("from", time(20).toString()).put("until", if (open) JSONObject.NULL else time(40).toString())
            )), "trip")
    @Test fun `resume permanently excludes the paused interval and applies departure cutoff`() {
        assertEquals(listOf(time(0) to time(20).minusMillis(1), time(40) to time(80)), policy("LEAVING").windows(time(0), time(100)))
    }
    @Test fun `open pause stops only new capture discovery`() {
        assertEquals(listOf(time(0) to time(20).minusMillis(1)), policy(open = true).windows(time(0), time(100)))
    }
    @Test fun `left membership has no capture windows`() {
        assertTrue(policy("LEFT").windows(time(0), time(100)).isEmpty())
    }
}
