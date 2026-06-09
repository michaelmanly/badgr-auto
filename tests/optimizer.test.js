import { describe, it, expect } from 'vitest';
import { optimizeMessages } from '../src/optimizer.js';
import { countTokens } from '../src/token-counter.js';
import { estimateSavings } from '../src/pricing.js';

describe('optimizeMessages', () => {
  it('deduplicates identical string messages and keeps the latest copy', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'same chunk' },
      { role: 'assistant', content: 'different' },
      { role: 'user', content: 'same chunk' },
    ];

    const optimized = optimizeMessages(messages, { compressionThresholdTokens: 1000 });

    expect(optimized.didDedupe).toBe(true);
    expect(optimized.didCompress).toBe(false);
    expect(optimized.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'assistant', content: 'different' },
      { role: 'user', content: 'same chunk' },
    ]);
  });

  it('does not deduplicate tool call JSON or tool response messages', () => {
    const toolCall = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }],
    };
    const toolResult = { role: 'tool', tool_call_id: 'call_1', content: 'same chunk' };

    const optimized = optimizeMessages([
      toolCall,
      toolResult,
      { role: 'user', content: 'same chunk' },
    ], { compressionThresholdTokens: 1000 });

    expect(optimized.messages).toEqual([toolCall, toolResult, { role: 'user', content: 'same chunk' }]);
  });

  it('compresses older context over the threshold while preserving system and recent messages', () => {
    const messages = [
      { role: 'system', content: 'Never rewrite this system prompt.' },
      { role: 'user', content: 'old context '.repeat(100) },
      { role: 'assistant', content: 'old answer '.repeat(100) },
      { role: 'user', content: 'recent one' },
      { role: 'assistant', content: 'recent two' },
      { role: 'user', content: 'latest user message' },
    ];

    const optimized = optimizeMessages(messages, {
      compressionThresholdTokens: 10,
      recentMessagesToKeep: 3,
      summaryMaxTokens: 20,
    });

    expect(optimized.didCompress).toBe(true);
    expect(optimized.messages[0]).toEqual(messages[0]);
    expect(optimized.messages[1].role).toBe('system');
    expect(optimized.messages[1].content).toContain('Summary of earlier conversation');
    expect(optimized.messages.slice(-3)).toEqual(messages.slice(-3));
  });
});

describe('token counting and pricing', () => {
  it('counts message text tokens and estimates savings', () => {
    const original = countTokens([{ role: 'user', content: 'abcd'.repeat(100) }]);
    const optimized = countTokens([{ role: 'user', content: 'abcd'.repeat(25) }]);
    const savings = estimateSavings(original, optimized, 'gpt-4o-mini');

    expect(original).toBeGreaterThan(optimized);
    expect(savings.savedTokens).toBe(original - optimized);
    expect(savings.savedCost).toBeGreaterThan(0);
  });
});
