import { PacketDeduplicator } from '../packets/packet-deduplicator.js';
import { compileSchema, formatErrors } from '../validation/ajv.js';
import { satisfactoryChannelResponseSchema } from './schemas.js';

const validate = compileSchema(satisfactoryChannelResponseSchema);

/** Coordinates handler-approved response matching across every configured bot. */
export function createReplySuppressionCoordinator({ store, botsByName, logger, deduplicator = new PacketDeduplicator() }) {
  return function suppressSatisfactoryPendingReply(input) {
    if (!validate(input)) {
      throw new Error(`Invalid satisfactory channel response: ${formatErrors(validate.errors)}`);
    }
    if (deduplicator.isDuplicate(`${input.channel}:${input.packetHash}`)) return false;

    const candidates = store.queryPendingReplySuppressionCandidates({
      channel: input.channel,
      observedAt: input.observedAt
    });
    if (candidates.overflow) return false;

    const matches = [];
    try {
      for (const item of candidates.items) {
        const bot = botsByName.get(item.botName);
        if (bot?.isSatisfactoryResponse?.({
          item,
          responseText: input.responseText,
          responseSender: input.responseSender
        })) matches.push(item);
      }
    } catch {
      logger.warn('bots.replySuppression', 'could not evaluate pending reply response evidence', {
        channel: input.channel,
        reason: 'matcher-error'
      });
      return false;
    }

    if (matches.length !== 1) return false;

    const [match] = matches;
    const suppressed = store.suppressPendingReplyItem({ id: match.id, resolvedAt: input.observedAt });
    if (suppressed) {
      logger.info('bots.replySuppression', 'suppressed one pending reply after a handler-matched channel response', {
        bot: match.botName,
        channel: match.channel,
        trigger: match.trigger,
        reason: 'satisfactory-response'
      });
    }
    return suppressed;
  };
}
