package com.uankit53.crewroll.transfer.media

import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativePollGateTest {
  @Test fun `background wake bursts cannot spam services and resume is immediate`() {
    var now = 0L
    val gate = NativePollGate { now }
    assertTrue(gate.allow())
    gate.foreground(false)
    repeat(1000) { assertFalse(gate.allow()) }
    now = TimeUnit.SECONDS.toNanos(30)
    assertTrue(gate.allow())
    assertFalse(gate.allow())
    gate.foreground(true)
    assertTrue(gate.allow())
  }
}
