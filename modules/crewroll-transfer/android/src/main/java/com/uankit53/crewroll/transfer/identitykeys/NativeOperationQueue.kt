package com.uankit53.crewroll.transfer.identitykeys

import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** Lifecycle callbacks only enqueue work. No disk, crypto, or locks on the UI thread. */
class NativeOperationQueue(private val observe: (String, String, Long) -> Unit = { _, _, _ -> }) {
  private val executor = Executors.newSingleThreadExecutor { task ->
    Thread(task, "CrewRollSession").apply { isDaemon = true }
  }

  fun <T> submit(name: String, operation: () -> T): CompletableFuture<T> {
    val result = CompletableFuture<T>()
    try {
      executor.execute {
        val start = System.nanoTime()
        observe(name, "start", 0)
        try {
          val value = operation()
          observe(name, "end", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start))
          result.complete(value)
        } catch (error: Throwable) {
          observe(name, "failed", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start))
          result.completeExceptionally(error)
        }
      }
    } catch (error: RejectedExecutionException) { result.completeExceptionally(error) }
    return result
  }

  fun close() { executor.shutdown() }
}
