import { createHash } from 'node:crypto';
import { contentToText, countTokens, countTextTokens, truncateTextToTokens } from './token-counter.js';

export const CLIENT_PROFILES = {
  AGENT: 'agent',   // tool calls, OpenClaw, AutoGen, CrewAI
  CODING: 'coding', // Cline, Continue, Aider, Cursor
  RAG: 'rag',       // retrieved docs, citations, evidence
  CHAT: 'chat',     // generic chat UI
};

// Explicit client header values mapped to profiles.
const CLIENT_HEADER_MAP = {
  cline: CLIENT_PROFILES.CODING,
  continue: CLIENT_PROFILES.CODING,
  aider: CLIENT_PROFILES.CODING,
  cursor: CLIENT_PROFILES.CODING,
  openclaw: CLIENT_PROFILES.AGENT,
  autogen: CLIENT_PROFILES.AGENT,
  crewai: CLIENT_PROFILES.AGENT,
  openwebui: CLIENT_PROFILES.CHAT,
  'open-webui': CLIENT_PROFILES.CHAT,
};

export const DEFAULT_OPTIMIZER_OPTIONS = {
  compressionThresholdTokens: 12000,
  recentMessagesToKeep: 8,
  summaryMaxTokens: 1600,
};

// Patterns grouped by block type. Each group identifies a category of structured,
// repeatable context that is safe to deduplicate on exact match.
// Natural-language conversation is never deduplicated — it has no entry here.
const BLOCK_TYPE_PATTERNS = {
  code_block:   [/```[\s\S]{80,}```/],
  diff:         [/^diff --git /m, /^--- .+\n\+\+\+ .+/m, /^@@\s+-\d+/m],
  conflict:     [/^[<>]{4,} /m],
  log_output:   [
    /\[(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\]/,
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m,
  ],
  retrieved_doc: [
    /^\[(?:Document|Source|Retrieved|Chunk|Result)\b/im,
    /^(?:Document|Source|Retrieved|Chunk)\s*\d*\s*:/im,
    /^(?:---+|\*{3,})\s*\n.{20,}\n(?:---+|\*{3,})/m,
  ],
};

// Minimum character length before block-type classification is attempted.
const DATA_BLOCK_MIN_CHARS = 120;

// Returns the block type string if content is a structured repeatable block,
// or null if it looks like natural-language conversation.
function classifyBlockType(content) {
  const text = contentToText(content);
  if (text.length < DATA_BLOCK_MIN_CHARS) return null;
  for (const [type, patterns] of Object.entries(BLOCK_TYPE_PATTERNS)) {
    if (patterns.some((p) => p.test(text))) return type;
  }
  return null;
}

function blockHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function hasProtectedAgentData(message = {}) {
  return Boolean(
    message.role === 'tool' ||
    message.tool_call_id ||
    message.tool_calls ||
    message.function_call ||
    message.name
  );
}

// Working tree / git state patterns — content that reflects a specific snapshot of the
// file system at a point in time. Deduplicating across turns could silently drop a
// newer tree state, so we never remove these even when the text is identical.
const WORKING_TREE_PATTERNS = [
  /^modified:\s+\S+/im,
  /^deleted:\s+\S+/im,
  /^new file:\s+\S+/im,
  /^renamed:\s+\S+ ->/im,
  /working tree (clean|changed|dirty)/i,
  /uncommitted changes/i,
  /changes not staged for commit/i,
  /nothing to commit/i,
];

function hasWorkingTreeContent(text) {
  return WORKING_TREE_PATTERNS.some(p => p.test(text));
}

// Conservative deduplication rules:
// - system messages are static instructions — always safe to dedupe
// - tool calls, results, and IDs are protected — never deduped
// - working tree / git state content is never deduped (staleness protection)
// - user/assistant messages are only deduped when classifyBlockType returns a type
// - natural-language conversation has no block type and is never deduped
function isDeduplicatable(message) {
  if (hasProtectedAgentData(message)) return false;
  const text = contentToText(message?.content);
  if (hasWorkingTreeContent(text)) return false;
  if (message.role === 'system') return true;
  return classifyBlockType(message.content) !== null;
}

export function detectClientProfile(messages, requestData = {}, headers = {}) {
  // Explicit task-type header takes highest priority.
  const taskTypeHeader = (headers['x-badgr-task-type'] || '').toLowerCase().trim();
  if (taskTypeHeader === 'coding') return CLIENT_PROFILES.CODING;
  if (taskTypeHeader === 'agent') return CLIENT_PROFILES.AGENT;
  if (taskTypeHeader === 'rag') return CLIENT_PROFILES.RAG;
  if (taskTypeHeader === 'chat') return CLIENT_PROFILES.CHAT;

  // Known client header maps directly to a profile.
  const clientHeader = (headers['x-badgr-client'] || '').toLowerCase().trim();
  if (clientHeader && CLIENT_HEADER_MAP[clientHeader]) {
    return CLIENT_HEADER_MAP[clientHeader];
  }

  // Fall back to content-based inference.
  const hasToolCalls = messages.some(
    (m) => m.tool_calls || m.role === 'tool' || m.tool_call_id
  );
  const hasToolDefs = Array.isArray(requestData.tools) && requestData.tools.length > 0;
  if (hasToolCalls || hasToolDefs) return CLIENT_PROFILES.AGENT;

  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .join(' ')
    .toLowerCase();

  if (/\b(retrieved|evidence|citation|search result|context chunk|retrieved document)\b/.test(systemText)) {
    return CLIENT_PROFILES.RAG;
  }
  if (/\b(repository|codebase|diff|\.ts\b|\.js\b|\.py\b|refactor|implement)\b/.test(systemText)) {
    return CLIENT_PROFILES.CODING;
  }
  return CLIENT_PROFILES.CHAT;
}

function dedupeMessages(messages, model) {
  const latestIndexByContent = new Map();
  const removedBlocks = [];

  messages.forEach((message, index) => {
    if (!isDeduplicatable(message)) return;
    const text = contentToText(message?.content).trim();
    if (!text) return;
    latestIndexByContent.set(`${message.role || ''} ${text}`, index);
  });

  const kept = messages.filter((message, index) => {
    if (!isDeduplicatable(message)) return true;
    const text = contentToText(message?.content).trim();
    if (!text) return true;
    const key = `${message.role || ''} ${text}`;
    const isLatest = latestIndexByContent.get(key) === index;
    if (!isLatest) {
      removedBlocks.push({
        removed_block_hash: blockHash(text),
        block_type: message.role === 'system' ? 'system_instruction' : (classifyBlockType(message.content) ?? 'data_block'),
        tokens_removed: countTextTokens(text, model),
        reason: 'exact_duplicate',
      });
    }
    return isLatest;
  });

  return { messages: kept, removedBlocks };
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
  const profile = options.clientProfile
    || detectClientProfile(Array.isArray(messages) ? messages : [], options.requestData || {}, options.headers || {});

  if (!Array.isArray(messages)) {
    return { messages: [], didDedupe: false, didCompress: false, contextTokensRemoved: 0, clientProfile: profile, removedBlocks: [] };
  }

  // Off mode: pass through entirely unchanged. No deduplication, no compaction.
  if (options.mode === 'off') {
    return { messages, didDedupe: false, didCompress: false, contextTokensRemoved: 0, clientProfile: profile, removedBlocks: [] };
  }

  const config = { ...DEFAULT_OPTIMIZER_OPTIONS, ...options };
  const model = options.model;

  // Agents get a larger recent window to preserve active tool chains and working state.
  const recentToKeep = profile === CLIENT_PROFILES.AGENT
    ? Math.max(config.recentMessagesToKeep, 12)
    : config.recentMessagesToKeep;

  const originalLength = messages.length;
  const originalTokens = countTokens(messages, model);
  const { messages: deduped, removedBlocks: dedupeRemovedBlocks } = dedupeMessages(messages, model);
  const tokensAfterDedupe = countTokens(deduped, model);

  if (tokensAfterDedupe <= config.compressionThresholdTokens) {
    return {
      messages: deduped,
      didDedupe: deduped.length !== originalLength,
      didCompress: false,
      contextTokensRemoved: Math.max(originalTokens - tokensAfterDedupe, 0),
      clientProfile: profile,
      removedBlocks: dedupeRemovedBlocks,
    };
  }

  const systemMessages = deduped.filter((m) => m.role === 'system');
  const nonSystemMessages = deduped.filter((m) => m.role !== 'system');
  const recentMessages = nonSystemMessages.slice(-recentToKeep);
  const recentSet = new Set(recentMessages);
  const olderMessages = nonSystemMessages.filter((m) => !recentSet.has(m));

  // Protected older messages: tool activity and unresolved agent state are never summarized.
  const protectedOlder = olderMessages.filter(hasProtectedAgentData);
  const summarizableOlder = olderMessages.filter((m) => !hasProtectedAgentData(m));
  const summaryMessage = buildSummaryMessage(summarizableOlder, model, config.summaryMaxTokens);

  const compressRemovedBlocks = summarizableOlder
    .map((m) => {
      const text = contentToText(m?.content).trim();
      const tokensRemoved = countTextTokens(text, model);
      if (!text || tokensRemoved === 0) return null;
      return {
        removed_block_hash: blockHash(text),
        block_type: 'completed_history',
        tokens_removed: tokensRemoved,
        reason: 'compacted_into_summary',
      };
    })
    .filter(Boolean);

  const compressedMessages = [
    ...systemMessages,
    ...(summaryMessage ? [summaryMessage] : []),
    ...protectedOlder,
    ...recentMessages,
  ];

  const compressedTokens = countTokens(compressedMessages, model);

  return {
    messages: compressedMessages,
    didDedupe: deduped.length !== originalLength,
    didCompress: true,
    contextTokensRemoved: Math.max(originalTokens - compressedTokens, 0),
    clientProfile: profile,
    removedBlocks: [...dedupeRemovedBlocks, ...compressRemovedBlocks],
  };
}
