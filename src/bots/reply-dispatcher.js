/**
 * Builds the single, shared `dispatch(item)` function a ReplyQueue calls
 * once a quiet window makes it safe to actually send a queued reply.
 *
 * Centralizing this as one function - rather than a different closure
 * captured at every `enqueue()` call site - keeps two things true: the
 * queue only ever holds plain, inspectable data (see reply-queue.js),
 * and "how a reply is actually turned into a radio transmission" lives
 * in exactly one auditable place, dispatching purely on `item.botName`
 * (chosen by this observer's own config-loaded bots, never by anything
 * in the item that came from over-the-air data).
 *
 * @param {Map<string, {sendQueuedReply: (item: object) => Promise<void>}>} botsByName
 * @returns {(item: object) => Promise<void>}
 */
export function createReplyDispatcher(botsByName) {
  return async function dispatch(item) {
    const bot = botsByName.get(item.botName);
    if (!bot) {
      throw new Error(`no bot registered for queued reply botName "${item.botName}"`);
    }
    await bot.sendQueuedReply(item);
  };
}
