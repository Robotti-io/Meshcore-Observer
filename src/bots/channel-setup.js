import { deriveHashtagChannelKey } from './channel-key.js';

/**
 * Finds or creates the bot's public hashtag channel on the Companion device
 * (see docs/project_plan.spec.md Section 21, "Channel initialization"):
 * search existing slots by name (case-insensitive); if found, reuse its
 * index and secret; if absent, create it in the first empty slot using the
 * name-derived key. Returns null (without throwing) if no slot is
 * available or the device rejects the operation - callers must disable
 * replies rather than fail startup.
 *
 * @param {{runCommand: (fn: (connection: object) => Promise<any>) => Promise<any>, channelName: string, logger: object}} options
 * @returns {Promise<{channelIdx: number, secret: Buffer}|null>}
 */
export async function ensureChannel({ runCommand, channelName, logger }) {
  const target = channelName.toLowerCase();
  let phase = 'list';

  // Slot selection and creation are one transaction on the shared command
  // queue: another bot must not select the same empty slot between them.
  try {
    return await runCommand(async (connection, transaction) => {
      const channels = await connection.getChannels();
      transaction?.signal.throwIfAborted();
      const existing = channels.find((channel) => (channel.name || '').toLowerCase() === target);
      if (existing) {
        logger.info('bots.channelBot', 'found existing channel slot', {
          channelIdx: existing.channelIdx,
          channel: channelName
        });
        return { channelIdx: existing.channelIdx, secret: Buffer.from(existing.secret) };
      }

      const emptySlot = channels.find((channel) => !channel.name || channel.name.trim() === '');
      if (!emptySlot) {
        logger.warn('bots.channelBot', 'no empty channel slot available', { channel: channelName });
        return null;
      }

      const secret = deriveHashtagChannelKey(channelName);
      phase = 'create';
      await connection.setChannel(emptySlot.channelIdx, channelName, secret);
      transaction?.signal.throwIfAborted();

      // Never log the derived key itself, per the repository's logging contract.
      logger.info('bots.channelBot', 'created channel', { channelIdx: emptySlot.channelIdx, channel: channelName });
      return { channelIdx: emptySlot.channelIdx, secret };
    });
  } catch (err) {
    const message = phase === 'list' ? 'failed to list channel slots' : 'failed to create channel';
    logger.warn('bots.channelBot', message, { channel: channelName, error: err.message });
    return null;
  }
}
