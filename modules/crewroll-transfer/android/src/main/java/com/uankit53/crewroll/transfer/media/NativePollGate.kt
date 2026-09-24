package com.uankit53.crewroll.transfer.media

import java.util.concurrent.TimeUnit

/** Idle backoff is independent of active work; explicit user/library wakes win. */
class NativePollGate(private val now: () -> Long = System::nanoTime) {
  private var foreground = true
  private var next = 0L
  private var idle = 0
  @Synchronized fun foreground(value: Boolean) {
    if (foreground && !value) next = now() + TimeUnit.SECONDS.toNanos(30)
    foreground = value
    if (value) wake()
  }
  @Synchronized fun wake() { next = 0; idle = 0 }
  @Synchronized fun retryWithin(milliseconds: Long) { next = minOf(next, now() + TimeUnit.MILLISECONDS.toNanos(milliseconds.coerceAtLeast(0))) }
  @Synchronized fun allow(): Boolean {
    val current = now()
    if (current < next) return false
    if (!foreground) next = current + TimeUnit.SECONDS.toNanos(30)
    return true
  }
  @Synchronized fun completed(worked: Boolean, failed: Boolean) {
    idle = if (worked && !failed) 0 else (idle + 1).coerceAtMost(5)
    val seconds = when {
      failed -> (2L shl idle).coerceAtMost(60)
      worked -> 1L
      foreground -> (1L shl idle).coerceAtMost(15)
      else -> 30L
    }
    next = now() + TimeUnit.SECONDS.toNanos(seconds)
  }
}
