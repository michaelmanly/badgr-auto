const RATES_PER_MILLION_INPUT_TOKENS = [
  [/gpt-4\.1|gpt-4o(?!-mini)/i, 5.00],
  [/gpt-4\.1-mini|gpt-4o-mini/i, 0.15],
  [/gpt-4\.1-nano/i, 0.10],
  [/claude-3-5-sonnet|claude-3\.5-sonnet|claude-sonnet-4/i, 3.00],
  [/claude-3-5-haiku|claude-3\.5-haiku|claude-haiku/i, 0.80],
];

// Reference rates for savings comparisons (per million input tokens)
export const HAIKU_RATE_PER_MILLION  = 0.80;
export const SONNET_RATE_PER_MILLION = 3.00;

export function inputRatePerMillion(model = '') {
  const match = RATES_PER_MILLION_INPUT_TOKENS.find(([pattern]) => pattern.test(model));
  return match ? match[1] : 1.00;
}

export function estimateInputCost(tokens, model) {
  return (Math.max(tokens, 0) / 1_000_000) * inputRatePerMillion(model);
}

export function estimateHaikuCost(tokens) {
  return (Math.max(tokens, 0) / 1_000_000) * HAIKU_RATE_PER_MILLION;
}

export function estimateSonnetCost(tokens) {
  return (Math.max(tokens, 0) / 1_000_000) * SONNET_RATE_PER_MILLION;
}

export function estimateSavings(originalTokens, optimizedTokens, model) {
  const savedTokens = Math.max(originalTokens - optimizedTokens, 0);
  return {
    originalCost: estimateInputCost(originalTokens, model),
    optimizedCost: estimateInputCost(optimizedTokens, model),
    savedCost: estimateInputCost(savedTokens, model),
    savedTokens,
    savedPercent: originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0,
  };
}
