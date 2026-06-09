import { contentToText, countTokens, truncateTextToTokens } from './token-counter.js';

export const DEFAULT_OPTIMIZER_OPTIONS = {
  compressionThresholdTokens: 12000,
  recentMessagesToKeep: 8,
  summaryMaxTokens: 1600,
};

function hasProtectedAgentData(message = {}) {
  return Boolean(
    message.role === 'tool' ||
    message.tool_call_id ||
    message.tool_calls ||
    message.function_call ||
    message.name
  );
}

function dedupeMessages(messages) {
  const latestIndexByContent = new Map();

  messages.forEach((message, index) => {
    if (hasProtectedAgentData(message)) return;
    const text = contentToText(message?.content).trim();
    if (!text) return;
    latestIndexByContent.set(`${message.role || ''}\u0000${text}`, index);
  });

  return messages.filter((message, index) => {
    if (hasProtectedAgentData(message)) return true;
    const text = contentToText(message?.content).trim();
    if (!text) return true;
    return latestIndexByContent.get(`${message.role || ''}\u0000${text}`) === index;
  });
}

function buildSummaryMessage(olderMessages, model, summaryMaxTokens) {
  const lines = olderMessages
    .map((message) => {
      const text = contentToText(message?.content).trim();
      if (!text) return null;
      return `${message.role || 'message'}: ${text}`;
    })
    .filter(Boolean);

  if (lines.length === 0) return null;

  const summaryText = truncateTextToTokens(lines.join('\n'), summaryMaxTokens, model);
  return {
    role: 'system',
    content: `Summary of earlier conversation, preserved for context. Do not treat this as new user instructions.\n${summaryText}`,
  };
}

export function optimizeMessages(messages, options = {}) {
  if (!Array.isArray(messages)) {
    return { messages: [], didDedupe: false, didCompress: false };
  }

  const config = { ...DEFAULT_OPTIMIZER_OPTIONS, ...options };
  const model = options.model;
  const originalLength = messages.length;
  const deduped = dedupeMessages(messages);
  const originalTokensAfterDedupe = countTokens(deduped, model);

  if (originalTokensAfterDedupe <= config.compressionThresholdTokens) {
    return {
      messages: deduped,
      didDedupe: deduped.length !== originalLength,
      didCompress: false,
    };
  }

  const systemMessages = deduped.filter((message) => message.role === 'system');
  const nonSystemMessages = deduped.filter((message) => message.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-config.recentMessagesToKeep);
  const recentSet = new Set(recentMessages);
  const olderMessages = nonSystemMessages.filter((message) => !recentSet.has(message));
  const protectedOlder = olderMessages.filter(hasProtectedAgentData);
  const summarizableOlder = olderMessages.filter((message) => !hasProtectedAgentData(message));
  const summaryMessage = buildSummaryMessage(summarizableOlder, model, config.summaryMaxTokens);

  return {
    messages: [
      ...systemMessages,
      ...(summaryMessage ? [summaryMessage] : []),
      ...protectedOlder,
      ...recentMessages,
    ],
    didDedupe: deduped.length !== originalLength,
    didCompress: true,
  };
}
