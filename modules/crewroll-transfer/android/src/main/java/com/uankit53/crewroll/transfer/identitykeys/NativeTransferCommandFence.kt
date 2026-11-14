package com.uankit53.crewroll.transfer.identitykeys

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Process-shared selection ownership. Validation in engine predicates is a
 * nonblocking volatile read; only command dispatch and lifecycle mutation take
 * this lock. Never await an engine drain while holding it. */
class NativeTransferCommandFence {
    private val lock = ReentrantLock()
    @Volatile private var revision = 0L
    fun advance(): Long = lock.withLock { ++revision }
    fun current(): Long = revision
    fun matches(epoch: Long): Boolean = revision == epoch
    fun <T> runIfCurrent(epoch: Long, operation: () -> T): T = lock.withLock {
        if (!matches(epoch)) throw NativeKeyException.invalidState()
        operation()
    }
}
