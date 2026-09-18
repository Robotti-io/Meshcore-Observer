/**
 * Ensures exactly one Companion device command transaction is in flight at a
 * time. meshcore.js correlates a command to its response purely by "next
 * matching event wins" (EventEmitter#once), so overlapping calls of the same
 * command type can cross-resolve incorrectly without this serialization.
 */
export class CommandQueue {
  #tail = Promise.resolve();

  /**
   * Runs `task` once every previously queued task has settled, and returns a
   * promise for `task`'s own outcome (its rejection, if any, does not affect
   * later queued tasks).
   *
   * @param {() => Promise<any>} task
   */
  run(task) {
    const result = this.#tail.then(() => task());
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
