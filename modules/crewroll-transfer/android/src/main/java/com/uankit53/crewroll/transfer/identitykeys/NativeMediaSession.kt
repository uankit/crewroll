package com.uankit53.crewroll.transfer.identitykeys

import java.time.Instant

/** One validated active-session lease, never the full account key database.
 * Callers own independent buffers. Every identity/session/trip mutation invalidates
 * the lease; expiry and teardown erase it. Status polling does no Keystore I/O.
 */
class NativeMediaSession(
  private val load: () -> NativeMediaContext?,
  private val clock: () -> Instant = Instant::now,
) {
  private var loaded = false
  private var context: NativeMediaContext? = null
  private var closed = false

  @Synchronized fun read(): NativeMediaContext? {
    if (closed) throw NativeKeyException.invalidState()
    if (!loaded) {
      context = load()
      loaded = true
    }
    val value = context ?: return null
    if (value.session.expiresAt <= clock()) {
      clear()
      throw NativeKeyException.materialLost()
    }
    return value.copy(
      session = value.session.copy(backgroundBearer = value.session.backgroundBearer.copyOf()),
      tripKey = value.tripKey.copyOf(),
    )
  }

  @Synchronized fun <T> change(operation: () -> T): T {
    if (closed) throw NativeKeyException.invalidState()
    clear()
    return try { operation() } finally { clear() }
  }

  @Synchronized fun clear() {
    context?.erase()
    context = null
    loaded = false
  }

  @Synchronized fun close() { clear(); closed = true }
}
