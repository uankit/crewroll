package com.uankit53.crewroll.transfer.media

import java.util.concurrent.TimeUnit

/** Cached/background processes must not continually poll Android services.
 * Foreground wakes remain immediate; this does not promise background execution.
 */
class NativePollGate(private val now: () -> Long = System::nanoTime) {
  private var foreground = true
  private var last = 0L
  @Synchronized fun foreground(value: Boolean) {
    if (foreground && !value) last = now()
    foreground = value
  }
  @Synchronized fun allow(): Boolean {
    if (foreground) return true
    val current = now()
    if (current - last < TimeUnit.SECONDS.toNanos(30)) return false
    last = current
    return true
  }
}
