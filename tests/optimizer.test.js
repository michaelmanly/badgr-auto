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

  it('deduplicates repeated code block data blocks but NOT long natural-language user messages', () => {
    const fileContent = '```typescript\n' + 'const x: number = 1;\n'.repeat(12) + '```';
    const naturalLanguage = 'Can you please help me understand this problem? '.repeat(8);

    const messages = [
      { role: 'user', content: fileContent },
      { role: 'user', content: naturalLanguage },
      { role: 'assistant', content: 'I see the file.' },
      { role: 'user', content: fileContent },         // repeated code block — removed
      { role: 'user', content: naturalLanguage },      // repeated natural language — KEPT
      { role: 'user', content: 'Now fix the bug.' },
    ];

    const optimized = optimizeMessages(messages, { compressionThresholdTokens: 10000 });

    expect(optimized.didDedupe).toBe(true);
    // Only one copy of the code block kept (the latest)
    expect(optimized.messages.filter((m) => m.content === fileContent)).toHaveLength(1);
    // Both copies of the natural-language message are preserved
    expect(optimized.messages.filter((m) => m.content === naturalLanguage)).toHaveLength(2);
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

  it('returns contextTokensRemoved, clientProfile, and removedBlocks in the result', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    const result = optimizeMessages(messages, { compressionThresholdTokens: 10000 });
    expect(typeof result.contextTokensRemoved).toBe('number');
    expect(result.clientProfile).toBe(CLIENT_PROFILES.CHAT);
    expect(Array.isArray(result.removedBlocks)).toBe(true);
  });

  it('logs removedBlocks with hash, block_type, tokens_removed, and reason for each removed duplicate', () => {
    const dupContent = '```js\n' + 'console.log("value:", result);\n'.repeat(6) + '```';
    const messages = [
      { role: 'user', content: dupContent },
      { role: 'assistant', content: 'Got it.' },
      { role: 'user', content: dupContent },
    ];
    const result = optimizeMessages(messages, { compressionThresholdTokens: 10000 });

    expect(result.didDedupe).toBe(true);
    expect(result.removedBlocks).toHaveLength(1);
    const block = result.removedBlocks[0];
    expect(typeof block.removed_block_hash).toBe('string');
    expect(block.block_type).toBe('code_block');
    expect(typeof block.tokens_removed).toBe('number');
    expect(block.reason).toBe('exact_duplicate');
  });

  it('regression: same long natural-language question repeated twice — both messages remain present', () => {
    // This is the key safety check: repeated user questions must never be silently dropped,
    // even when they are very long. Only structural data blocks (code, diffs, logs) are deduped.
    const longQuestion =
      'I have been working on this authentication system for several weeks and I keep running into ' +
      'a very specific problem with token refresh timing. When the access token expires, the refresh ' +
      'call sometimes races with another API request. Can you help me design a locking mechanism that ' +
      'prevents concurrent refresh attempts without blocking normal API calls? I need the solution to ' +
      'work in a browser context without shared workers. This is the third time asking because the ' +
      'previous answers did not address the concurrency aspect in enough detail.';

    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: longQuestion },
      { role: 'assistant', content: 'Here is a basic approach...' },
      { role: 'user', content: longQuestion }, // same question repeated — must be KEPT
    ];

    const result = optimizeMessages(messages, { compressionThresholdTokens: 10000 });

    expect(result.didDedupe).toBe(false);
    expect(result.messages.filter((m) => m.content === longQuestion)).toHaveLength(2);
    expect(result.removedBlocks).toHaveLength(0);
  });

  it('optimizationMode off returns messages unchanged with no optimization applied', () => {
    const fileContent = '```typescript\n' + 'const x = 1;\n'.repeat(12) + '```';
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: fileContent },
      { role: 'user', content: fileContent }, // would normally be deduped
    ];

    const result = optimizeMessages(messages, { optimizationMode: 'off', compressionThresholdTokens: 1000 });

    expect(result.didDedupe).toBe(false);
    expect(result.didCompress).toBe(false);
    expect(result.contextTokensRemoved).toBe(0);
    expect(result.removedBlocks).toHaveLength(0);
    expect(result.messages).toBe(messages); // same reference — untouched
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

  it('uses X-Badgr-Task-Type header to detect profile when provided', () => {
    const messages = [{ role: 'user', content: 'Do something.' }];
    expect(detectClientProfile(messages, {}, { 'x-badgr-task-type': 'coding' })).toBe(CLIENT_PROFILES.CODING);
    expect(detectClientProfile(messages, {}, { 'x-badgr-task-type': 'agent' })).toBe(CLIENT_PROFILES.AGENT);
    expect(detectClientProfile(messages, {}, { 'x-badgr-task-type': 'rag' })).toBe(CLIENT_PROFILES.RAG);
    expect(detectClientProfile(messages, {}, { 'x-badgr-task-type': 'chat' })).toBe(CLIENT_PROFILES.CHAT);
  });

  it('uses X-Badgr-Client header to detect known coding tools', () => {
    const messages = [{ role: 'user', content: 'Write a function.' }];
    for (const client of ['cline', 'continue', 'aider', 'cursor']) {
      expect(detectClientProfile(messages, {}, { 'x-badgr-client': client }), `expected ${client} → coding`).toBe(CLIENT_PROFILES.CODING);
    }
  });

  it('uses X-Badgr-Client header to detect known agent tools', () => {
    const messages = [{ role: 'user', content: 'Run the plan.' }];
    expect(detectClientProfile(messages, {}, { 'x-badgr-client': 'openclaw' })).toBe(CLIENT_PROFILES.AGENT);
  });

  it('X-Badgr-Task-Type takes precedence over X-Badgr-Client and content', () => {
    const messages = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_code', arguments: '{}' } }] },
    ];
    // Content says agent, but header says rag — header wins
    expect(detectClientProfile(messages, {}, { 'x-badgr-task-type': 'rag' })).toBe(CLIENT_PROFILES.RAG);
  });

  it('falls back to content inference when no headers are provided', () => {
    const messages = [{ role: 'user', content: 'What is the capital of France?' }];
    expect(detectClientProfile(messages, {}, {})).toBe(CLIENT_PROFILES.CHAT);
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
