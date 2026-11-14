package com.uankit53.crewroll.transfer.media

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePushHintTest {
    private val data = mapOf("type" to "crewroll.sync.v1", "deviceId" to "5a95305d-c558-4c79-b78c-a075be7bff84", "tripId" to "018f0d98-76fa-7d1a-b4b4-1f742c2e3130", "eventId" to "5a95305d-c558-4c79-b78c-a075be7bff85")
    @Test fun validatesClosedVersionedOpaquePayload() {
        assertNotNull(NativePushHint.parse(data))
        for (key in data.keys) assertNull(NativePushHint.parse(data - key))
        assertNull(NativePushHint.parse(data + ("url" to "https://example.test/private")))
        assertNull(NativePushHint.parse(data + ("type" to "crewroll.sync.v2")))
        assertNull(NativePushHint.parse(data + ("tripId" to data.getValue("deviceId"))))
        assertNull(NativePushHint.parse(data + ("deviceId" to "other")))
    }
    @Test fun noConsentNeverLoadsCredentialsOrStartsMedia() {
        val gate = NativePushWakeGate(); val hint = NativePushHint.parse(data)!!
        val context = { fail<Pair<String, String>>("Context must remain untouched"); null }
        assertFalse(gate.accept(listOf(hint), false, true, context))
        assertFalse(gate.accept(listOf(hint), true, false, context))
    }
    @Test fun accountDeviceTripMismatchAndReplayNeverWake() {
        val gate = NativePushWakeGate(); val hint = NativePushHint.parse(data)!!
        assertFalse(gate.accept(listOf(hint), true, true) { "other-device" to hint.tripId })
        assertFalse(gate.accept(listOf(hint), true, true) { hint.deviceId to "other-trip" })
        assertFalse(gate.accept(listOf(hint), true, true) { null })
        assertTrue(gate.accept(listOf(hint), true, true) { hint.deviceId to hint.tripId })
        assertFalse(gate.accept(listOf(hint), true, true) { hint.deviceId to hint.tripId })
        val moved = hint.copy(deviceId = "5a95305d-c558-4c79-b78c-a075be7bff86")
        assertTrue(gate.accept(listOf(moved), true, true) { moved.deviceId to moved.tripId })
    }
}
