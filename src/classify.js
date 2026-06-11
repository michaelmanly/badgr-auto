// Hard: tasks that genuinely require the most capable model — deep reasoning, cross-repo
// understanding, security analysis. Keep this list conservative. When unsure, use OSS cloud.
const HARD_KEYWORDS = [
  'architecture', 'analyze', 'analyse',
  'explain repo', 'codebase', 'security',
];

// Medium: normal development work — routes to OSS cloud, never local or premium.
const MEDIUM_KEYWORDS = ['debug', 'refactor', 'implement', 'review', 'design'];

export function estimatePromptTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let totalChars = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') {
      totalChars += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part.text === 'string') totalChars += part.text.length;
      }
    }
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Returns 'simple' | 'normal' | 'hard' for a chat request.
 *
 * simple  → route to local Ollama / LM Studio
 * normal  → route to OSS cloud (DeepSeek, etc.)
 * hard    → route to Claude via quality override
 */
export function classifyRequest(requestData, config = {}) {
  const mode            = config.mode            || 'balanced';
  const simpleMaxTokens = config.simpleMaxTokens ?? 500;
  const hardMinTokens   = config.hardMinTokens   ?? 4096;
  const messages = requestData.messages || [];

  if (mode === 'quality') return 'hard';

  const promptTokens = estimatePromptTokens(messages);
  const fullText = messages
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join(' ')
    .toLowerCase();

  const hasHardKeywords   = HARD_KEYWORDS.some(kw => fullText.includes(kw));
  const hasMediumKeywords = MEDIUM_KEYWORDS.some(kw => fullText.includes(kw));

  let classification;
  if (hasHardKeywords || promptTokens > hardMinTokens) {
    classification = 'hard';
  } else if (promptTokens <= simpleMaxTokens && !hasHardKeywords && !hasMediumKeywords) {
    classification = 'simple';
  } else {
    classification = 'normal';
  }

  if (mode === 'cheap' && classification === 'hard') classification = 'normal';
  return classification;
}
