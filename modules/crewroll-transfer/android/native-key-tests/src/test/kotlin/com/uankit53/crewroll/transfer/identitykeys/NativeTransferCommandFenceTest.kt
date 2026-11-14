package com.uankit53.crewroll.transfer.identitykeys

import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class NativeTransferCommandFenceTest {
    @Test fun `a delayed old teardown cannot clear a newly selected session even before activation`() {
        val fence = NativeTransferCommandFence()
        val old = fence.advance()
        var session: String? = "a"
        val drain = CompletableFuture<Unit>()
        val cleanup = drain.thenApply { fence.runIfCurrent(old) { session = null } }
        val replacement = fence.advance()
        fence.runIfCurrent(replacement) { session = "b" }
        drain.complete(Unit)
        assertThrows(java.util.concurrent.ExecutionException::class.java) { cleanup.get(5, TimeUnit.SECONDS) }
        assertEquals("b", session)
        assertFalse(fence.matches(old))
    }
    @Test fun `selection replacement waits for an atomic protected mutation then wins`() {
        val fence = NativeTransferCommandFence(); val first = fence.advance()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        var session = "a"
        try {
            val older = pool.submit { fence.runIfCurrent(first) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); session = "cleared" } }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val newer = pool.submit { val epoch = fence.advance(); fence.runIfCurrent(epoch) { session = "b" } }
            assertFalse(newer.isDone)
            release.countDown(); older.get(5, TimeUnit.SECONDS); newer.get(5, TimeUnit.SECONDS)
            assertEquals("b", session)
        } finally { release.countDown(); pool.shutdownNow() }
    }
}
