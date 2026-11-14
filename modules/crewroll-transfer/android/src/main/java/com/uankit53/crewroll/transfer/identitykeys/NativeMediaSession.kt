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
    val now = clock()
    if (value.session.expiresAt <= now || NativeTripRetention.deadline(value.metadata) <= now) {
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

  /** Prime only from a lifecycle-validated command, while selection is fenced.
   * The caller's context is erased; this lease owns independent buffers. */
  @Synchronized fun <T> changeAndPrime(operation: () -> T, contextOf: (T) -> NativeMediaContext?): T {
    if (closed) throw NativeKeyException.invalidState()
    clear()
    var owned: NativeMediaContext? = null
    return try {
      val result = operation()
      owned = contextOf(result)
      owned?.let { value ->
        val now = clock()
        if (value.session.expiresAt <= now || NativeTripRetention.deadline(value.metadata) <= now || value.tripKey.size != 32)
          throw NativeKeyException.materialLost()
        NativeCommandDecoder.validate(value.metadata)
        context = value.copy(session = value.session.copy(backgroundBearer = value.session.backgroundBearer.copyOf()),
          tripKey = value.tripKey.copyOf())
      }
      loaded = true
      result
    } catch (error: Throwable) { clear(); throw error }
    finally { owned?.erase() }
  }

  /** Ownership is checked even when a verified composite preserves its lease. */
  fun completeCommand(fence: NativeTransferCommandFence, epoch: Long, clearLease: Boolean) {
    fence.runIfCurrent(epoch) { if (clearLease) clear() }
  }

  fun failPreparedCommand(fence: NativeTransferCommandFence, epoch: Long): Nothing {
    try { completeCommand(fence, epoch, clearLease = true) }
    finally { throw NativeKeyException.activationFailed() }
  }

  @Synchronized fun clear() {
    context?.erase()
    context = null
    loaded = false
  }

  @Synchronized fun close() { clear(); closed = true }
}
