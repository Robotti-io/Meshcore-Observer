const MAX_COMPANION_NAME_BYTES = 31;

function isValidTargetName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.isWellFormed()
    && Array.from(name).length <= MAX_COMPANION_NAME_BYTES
    && Buffer.byteLength(name, 'utf8') <= MAX_COMPANION_NAME_BYTES;
}

/**
 * Parse only a leading target selector. A leading malformed selector is
 * distinct from ordinary untagged text so callers can fail closed instead
 * of accidentally treating it as a legacy command.
 */
export function parseLeadingCommandTarget(text) {
  if (!text.startsWith('@[')) return { kind: 'untagged', commandText: text };

  const closingBracket = text.indexOf(']', 2);
  if (closingBracket < 0) return { kind: 'invalid' };

  const name = text.slice(2, closingBracket);
  const separator = text[closingBracket + 1];
  const commandText = text.slice(closingBracket + 1).trimStart();
  if (!isValidTargetName(name) || !separator || !/^\s$/u.test(separator) || !commandText) {
    return { kind: 'invalid' };
  }

  return { kind: 'targeted', name, commandText };
}

/** Companion names select a bot; they do not authenticate a sender. */
export function matchesCompanionTarget(targetName, identity) {
  if (!isValidTargetName(targetName) || !isValidTargetName(identity?.name)) return false;
  return targetName.normalize('NFC') === identity.name.normalize('NFC');
}
