/**
 * A single-threaded FIFO queue.
 *
 * WHY THIS EXISTS
 * ---------------
 * Caption blocks finalise in bursts — three people talking over each other
 * produces three finalised lines within a few hundred milliseconds. Firing
 * three `insert` calls at Supabase concurrently means three HTTP requests that
 * can complete in any order, and `created_at` defaults are microsecond-close,
 * so the transcript comes back from the database interleaved wrongly. A meeting
 * transcript whose lines are out of order is not a transcript.
 *
 * So: one task in flight at a time, in the order they were enqueued. The cost
 * is latency, which does not matter here — nothing is waiting on the write.
 *
 * A failing task must not stall the queue behind it, so errors are handed to
 * `onError` and the queue moves on. Losing one caption line is bad; losing
 * every line after it because the first one failed is much worse.
 */

export class FifoQueue {
  constructor({ onError, name = "queue" } = {}) {
    this.name = name;
    this.onError = onError ?? (() => {});
    this._tail = Promise.resolve();
    this.pending = 0;
    this.completed = 0;
    this.failed = 0;
    this._draining = false;
  }

  /**
   * Enqueue work. Returns a promise that settles when *this* task is done, but
   * the queue itself never rejects — callers are free to ignore the result.
   */
  push(task, label = "") {
    this.pending += 1;
    const run = this._tail.then(async () => {
      try {
        const result = await task();
        this.completed += 1;
        return result;
      } catch (error) {
        this.failed += 1;
        this.onError(error, label);
        return undefined;
      } finally {
        this.pending -= 1;
      }
    });
    // `_tail` swallows rejections by construction (the catch above), so the
    // chain can never be poisoned by one bad task.
    this._tail = run;
    return run;
  }

  /** Wait for everything currently queued to finish. */
  async drain() {
    this._draining = true;
    // Re-read `_tail` after awaiting: a task can enqueue another one.
    let previous;
    do {
      previous = this._tail;
      await previous;
    } while (previous !== this._tail);
  }

  get stats() {
    return { pending: this.pending, completed: this.completed, failed: this.failed };
  }
}
