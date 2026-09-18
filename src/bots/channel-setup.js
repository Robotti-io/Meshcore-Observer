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

  let channels;
  try {
    channels = await runCommand((connection) => connection.getChannels());
  } catch (err) {
    logger.warn('bots.channelBot', 'failed to list channel slots', { channel: channelName, error: err.message });
    return null;
  }

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
  try {
    await runCommand((connection) => connection.setChannel(emptySlot.channelIdx, channelName, secret));
  } catch (err) {
    logger.warn('bots.channelBot', 'failed to create channel', { channel: channelName, error: err.message });
    return null;
  }

  // Never log the derived key itself, per the repository's logging contract.
  logger.info('bots.channelBot', 'created channel', { channelIdx: emptySlot.channelIdx, channel: channelName });
  return { channelIdx: emptySlot.channelIdx, secret };
}
