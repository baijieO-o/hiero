export interface CompactableMessage {
  role: string;
  content: string;
  compactedMarker?: boolean;
}

export interface CompactableConversation<T extends CompactableMessage = CompactableMessage> {
  messages: T[];
  compactedSummary?: string;
  compactedUpTo?: number;
}

/** Must match DEFAULT_KEEP_RECENT in src/context-compactor.ts. The backend keeps this many recent messages verbatim. */
export const KEEP_RECENT_MESSAGES = 6;

/**
 * Index into `messages` where the summary ends. Dividers are not counted, so repeated compactions line up with the
 * backend's view of the history, which never contains dividers.
 */
export function compactionBoundary<T extends CompactableMessage>(messages: T[], keepRecent = KEEP_RECENT_MESSAGES): number {
  const visible = messages.filter((msg) => !msg.compactedMarker);
  return Math.max(0, visible.length - keepRecent);
}

/** Messages sent to the backend: the summary covers the older part, so only the visible messages after it are sent. */
export function sendableMessages<T extends CompactableMessage>(conversation: CompactableConversation<T>, extra: T[] = []): T[] {
  const visible = conversation.messages.filter((msg) => !msg.compactedMarker);
  const start = conversation.compactedSummary !== undefined ? (conversation.compactedUpTo ?? 0) : 0;
  return [...visible.slice(start), ...extra];
}

/** Insert a divider after the first `upTo` visible messages, keeping earlier dividers in place. */
export function insertDivider<T extends CompactableMessage>(messages: T[], upTo: number, divider: T): T[] {
  let seen = 0;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.compactedMarker) continue;
    if (seen === upTo) return [...messages.slice(0, i), divider, ...messages.slice(i)];
    seen += 1;
  }
  return [...messages, divider];
}
