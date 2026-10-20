/**
 * ------------------------------------------------------------------
 *  Title    |  Memory queues
 *  Ref      |  DESIGN.md §6.3
 *  ID       |  core
 * ------------------------------------------------------------------
 *  Purpose  |  Run steps one after another where two at once would
 *           |  undo each other: filing a sighting of a lesson, or
 *           |  deciding one suggestion twice.
 *  How      |  A promise chain. A step that throws does not stop the
 *           |  ones behind it. Keyed queues keep one chain per key, so
 *           |  unrelated keys never wait for each other, and drop the
 *           |  chain when it empties.
 *  Note     |  Nothing here waits on a model or on git: hold a queue
 *           |  only around short work. The repository's own write queue
 *           |  (repo.ts) is separate and is not nested inside these.
 * ------------------------------------------------------------------
 */

export class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
