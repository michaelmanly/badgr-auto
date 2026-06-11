const CONTEXT_WINDOWS = {
  'gpt-4o':              128_000,
  'gpt-4o-mini':         128_000,
  'gpt-4-turbo':         128_000,
  'gpt-4':                 8_192,
  'gpt-3.5-turbo':        16_385,
  'claude-3-5-sonnet':   200_000,
  'claude-3-5-haiku':    200_000,
  'claude-3-opus':       200_000,
  'claude-3-sonnet':     200_000,
  'claude-3-haiku':      200_000,
  'claude-sonnet':       200_000,
  'claude-haiku':        200_000,
  'claude-opus':         200_000,
  'deepseek-chat':        64_000,
  'deepseek-coder':       64_000,
  'qwen2.5-coder':        32_000,
  'qwen2.5':              32_000,
  'mistral':              32_000,
  'llama3':                8_192,
  'llama-3':               8_192,
  'gemma':                 8_192,
};

const DEFAULT_CONTEXT_WINDOW = 32_000;

export function getContextWindow(model) {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const lower = model.toLowerCase();
  for (const [key, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// Returns { usedPercent, status: 'ok'|'warning'|'danger', recommendation, compactionRecommended }
export function computeContextHealth(tokens, model) {
  const windowSize = getContextWindow(model);
  const usedPercent = Math.round((tokens / windowSize) * 1000) / 10;

  if (usedPercent >= 75) {
    return { usedPercent, status: 'danger', recommendation: 'compact now', compactionRecommended: true };
  }
  if (usedPercent >= 60) {
    return { usedPercent, status: 'warning', recommendation: 'compact soon', compactionRecommended: true };
  }
  return { usedPercent, status: 'ok', recommendation: null, compactionRecommended: false };
}
