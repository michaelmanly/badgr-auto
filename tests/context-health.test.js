import { describe, it, expect } from 'vitest';
import { getContextWindow, computeContextHealth } from '../src/context-health.js';

describe('getContextWindow', () => {
  it('returns known window for gpt-4o', () => {
    expect(getContextWindow('gpt-4o')).toBe(128_000);
  });

  it('returns known window for claude-sonnet models', () => {
    expect(getContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(getContextWindow('claude-sonnet-4-6')).toBe(200_000);
  });

  it('returns known window for deepseek-chat', () => {
    expect(getContextWindow('deepseek-chat')).toBe(64_000);
  });

  it('falls back to 32000 for unknown models', () => {
    expect(getContextWindow('unknown-model-xyz')).toBe(32_000);
    expect(getContextWindow(null)).toBe(32_000);
    expect(getContextWindow(undefined)).toBe(32_000);
  });

  it('is case-insensitive', () => {
    expect(getContextWindow('GPT-4O')).toBe(128_000);
    expect(getContextWindow('CLAUDE-SONNET')).toBe(200_000);
  });
});

describe('computeContextHealth', () => {
  it('returns ok for low usage', () => {
    const health = computeContextHealth(1000, 'gpt-4o');
    expect(health.status).toBe('ok');
    expect(health.compactionRecommended).toBe(false);
    expect(health.recommendation).toBeNull();
  });

  it('returns warning at 60% threshold', () => {
    const tokens = Math.ceil(128_000 * 0.60);
    const health = computeContextHealth(tokens, 'gpt-4o');
    expect(health.status).toBe('warning');
    expect(health.compactionRecommended).toBe(true);
    expect(health.recommendation).toBe('compact soon');
  });

  it('returns danger at 75% threshold', () => {
    const tokens = Math.ceil(128_000 * 0.75);
    const health = computeContextHealth(tokens, 'gpt-4o');
    expect(health.status).toBe('danger');
    expect(health.compactionRecommended).toBe(true);
    expect(health.recommendation).toBe('compact now');
  });

  it('usedPercent is accurate', () => {
    const health = computeContextHealth(32_000, 'gpt-4o');
    expect(health.usedPercent).toBeCloseTo(25, 0);
  });

  it('works with unknown model (default window)', () => {
    // 32000 / 32000 = 100% → danger
    const health = computeContextHealth(32_000, 'unknown-model');
    expect(health.status).toBe('danger');
  });
});
