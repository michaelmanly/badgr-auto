import { describe, it, expect } from 'vitest';
import { optimizeMessages, detectClientProfile, CLIENT_PROFILES } from '../src/optimizer.js';
import { countTokens } from '../src/token-counter.js';
import { estimateSavings } from '../src/pricing.js';

describe('optimizeMessages — conservative deduplication', () => {
  it('deduplicates identical system instructions but preserves short conversational user messages', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'system', content: 'You are helpful.' }, // duplicate system — removed
      { role: 'user', content: 'Hello' },               // short conversation — kept
    ];

    const optimized = optimizeMessages(messages, { compressionThresholdTokens: 1000 });

    expect(optimized.didDedupe).toBe(true);
    expect(optimized.didCompress).toBe(false);
    // Duplicate system instruction removed, but both user "Hello" messages preserved
    expect(optimized.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(optimized.messages.filter((m) => m.content === 'Hello')).toHaveLength(2);
  });

  it('deduplicates repeated large data blocks such as file attachments', () => {
    const fileContent = '```typescript\n' + 'const x: number = 1;\n'.repeat(12) + '```';
    const messages = [
      { role: 'user', content: fileContent },
      { role: 'assistant', content: 'I see the file.' },
      { role: 'user', content: fileContent }, // repeated file attachment — removed
      { role: 'user', content: 'Now fix the bug in that file.' },
    ];

    const optimized = optimizeMessages(messages, { compressionThresholdTokens: 1000 });

    expect(optimized.didDedupe).toBe(true);
    // Only one copy of the file kept (the newest)
    expect(optimized.messages.filter((m) => m.content === fileContent)).toHaveLength(1);
    expect(optimized.messages.at(-1)).toEqual({ role: 'user', content: 'Now fix the bug in that file.' });
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

  it('returns contextTokensRemoved and clientProfile in the result', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = optimizeMessages(messages, { compressionThresholdTokens: 10000 });
    expect(typeof result.contextTokensRemoved).toBe('number');
    expect(result.clientProfile).toBe(CLIENT_PROFILES.CHAT);
  });
});

describe('detectClientProfile', () => {
  it('detects agent profile when tool_calls are present', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    ];
    expect(detectClientProfile(messages, {})).toBe(CLIENT_PROFILES.AGENT);
  });

  it('detects agent profile when tools array is defined in request', () => {
    const messages = [{ role: 'user', content: 'Do something.' }];
    const requestData = { tools: [{ type: 'function', function: { name: 'run_code' } }] };
    expect(detectClientProfile(messages, requestData)).toBe(CLIENT_PROFILES.AGENT);
  });

  it('detects RAG profile from system message', () => {
    const messages = [
      { role: 'system', content: 'Use the following retrieved documents to answer.' },
      { role: 'user', content: 'What is X?' },
    ];
    expect(detectClientProfile(messages, {})).toBe(CLIENT_PROFILES.RAG);
  });

  it('detects coding profile from system message', () => {
    const messages = [
      { role: 'system', content: 'You are working in a repository with TypeScript .ts files.' },
      { role: 'user', content: 'Refactor this.' },
    ];
    expect(detectClientProfile(messages, {})).toBe(CLIENT_PROFILES.CODING);
  });

  it('defaults to chat for generic messages', () => {
    const messages = [
      { role: 'user', content: 'What is the capital of France?' },
    ];
    expect(detectClientProfile(messages, {})).toBe(CLIENT_PROFILES.CHAT);
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
