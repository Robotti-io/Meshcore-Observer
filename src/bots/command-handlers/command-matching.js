/** Matches a complete command trigger without regard to letter case. */
export function matchesCommandTrigger(trigger, text) {
  return trigger.toLowerCase() === text.toLowerCase();
}

/** Matches a command prefix and preserves the original argument text. */
export function matchCommandPrefix(trigger, text) {
  const normalizedTrigger = trigger.toLowerCase();
  const normalizedText = text.toLowerCase();

  if (normalizedText === normalizedTrigger) {
    return { argument: '' };
  }
  if (normalizedText.startsWith(`${normalizedTrigger} `)) {
    return { argument: text.slice(trigger.length + 1).trim() };
  }
  return null;
}
